/** IA de Chalyb (ADR 0030), the whole chain on the local database: agent credential source → api /v1/coding →
 *  a CLI on the token → ai-gateway → fake provider → outbox → hub ledger. */
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ManagedSessionAdapter,
  type AdapterEvent,
  type ManagedCredential,
  type SessionAdapter,
} from "@chalito/adapters";
import { CodingMeter, HubClient, PostgresCodingStore, PostgresOutbox, drainOutbox } from "@chalito/billing";
import { FakeHub } from "@chalito/billing/testing";
import { loadPrices, loadProviders } from "@chalito/config";
import { createGateway } from "../../ai-gateway/src/app.js";
import { FakeProviders } from "../../ai-gateway/test/fake-providers.js";
import { apiManagedSource } from "../../agent/src/managed-source.js";
import { codingRoutes } from "../../api/src/coding/routes.js";
import { PostgresCodingIssueStore } from "../../api/src/coding/store.js";
import { MemoryAudit, type Deps } from "../../api/src/deps.js";

const url = process.env.DATABASE_URL;
const GW = "https://ai.chalito.test";
const OPENAI_KEY = "sk-chalyb-SECRET";

if (!url) {
  describe("managed coding chain", () => it.skip("needs DATABASE_URL", () => {}));
} else {
  const admin = postgres(url, { onnotice: () => {} });
  const serverSql = postgres(url, { max: 4, onnotice: () => {}, connection: { role: "chalito_server" } });
  const gwSql = postgres(url, { max: 6, onnotice: () => {}, connection: { role: "chalito_ai_gateway" } });
  const providers = loadProviders();
  const hub = new FakeHub();
  const hubClient = new HubClient({ baseUrl: "https://www.chalyb.com", token: "t", fetch: hub.fetch });
  const fakes = new FakeProviders();
  const owner = `mc-${randomUUID()}`;
  const device = `desk_${randomBytes(6).toString("hex")}`;
  let api: ReturnType<typeof codingRoutes>;
  let gateway: ReturnType<typeof createGateway>;
  const meter = new CodingMeter({
    store: new PostgresCodingStore(gwSql),
    hub: hubClient,
    prices: loadPrices(),
    cfg: providers.codingManaged,
    reserveBasis: "pre_margin",
    now: Date.now,
  });

  beforeAll(async () => {
    const up = await fakes.start();
    await admin`insert into chalito.tenants (id) values (${owner})`;
    await admin`insert into chalito.users (id, tenant_id, tier, tz) values (${owner}, ${owner}, 'Pro', 'America/Mexico_City')`;
    await admin`insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id, revoked)
      values (${owner}, ${device}, 'agent', 'desktop', 'linux', 'Desk', 'pk', 'p', 'f', 'pairing', ${randomUUID()}, false)`;
    hub.setUser(owner, 50_000_000);
    const deps = {
      repo: {
        getDevice: async (o: string, d: string) =>
          o === owner && d === device ? { deviceId: d, revoked: false } : null,
      },
      identity: {
        verify: async (t: string) => ({
          uid: `d_${device}`,
          role: t === "device-jwt" ? "agent" : "none",
          owner,
          deviceId: device,
        }),
      },
      audit: new MemoryAudit(),
      config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
      now: Date.now,
    } as unknown as Deps;
    api = codingRoutes(deps, {
      store: new PostgresCodingIssueStore(serverSql),
      hub: hubClient,
      prices: loadPrices(),
      providers,
      maxLivePerDevice: 6,
      reserveBasis: "pre_margin",
      enabled: () => true,
      gatewayUrl: GW,
    });
    gateway = createGateway({
      store: new PostgresCodingStore(gwSql),
      meter,
      providers,
      upstreams: { openai: { baseUrl: `${up}/openai/v1`, apiKey: OPENAI_KEY }, xai: null, google: null },
      enabled: () => true,
      now: Date.now,
    });
  });
  afterAll(async () => {
    await fakes.stop();
    await Promise.all([admin.end(), serverSql.end(), gwSql.end()]);
  });

  /** A Codex-like CLI: on each prompt, one Responses call to the gateway with its env token, then idle. */
  const cli =
    (calls: Response[]) =>
    (c: ManagedCredential): SessionAdapter => ({
      kind: "codex",
      async start(o) {
        let done: () => void = () => undefined;
        const turn = async () => {
          o.onEvent({ type: "state", state: "running" });
          const res = await gateway.request(`${new URL(c.baseUrl).pathname.replace(/\/$/, "")}/v1/responses`, {
            method: "POST",
            headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
            body: JSON.stringify({ model: c.model, stream: true, input: "arregla el test" }),
          });
          await res.text();
          calls.push(res);
          o.onEvent({ type: "state", state: res.ok ? "idle" : "failed" });
        };
        void turn();
        return {
          prompt: () => void turn(),
          interrupt: async () => {},
          setPermissionMode: async () => {},
          close: () => done(),
          done: new Promise<void>((r) => (done = r)),
        };
      },
    });
  const until = async (check: () => Promise<boolean> | boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timed out");
  };

  it("a session runs on IA de Chalyb, is billed once through the hub, gets blocked over the cap and is closed at the end", async () => {
    const source = apiManagedSource({
      apiBase: "http://api.test",
      agent: "codex",
      accessToken: async () => "device-jwt",
      // The api's /v1/coding router, as mounted under /v1/coding.
      fetch: (input, init) => {
        const u = new URL(String(input));
        u.pathname = u.pathname.replace(/^\/v1\/coding/, "");
        return Promise.resolve(api.fetch(new Request(u, init)));
      },
    });
    const calls: Response[] = [];
    const events: AdapterEvent[] = [];
    const adapter = new ManagedSessionAdapter("codex", { source, make: cli(calls) });
    fakes.behaviour = {
      kind: "responses",
      usage: {
        input_tokens: 20_000,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 2_000,
        total_tokens: 22_000,
      },
    };
    const h = await adapter.start({
      sid: "sess_mc1",
      cwd: "/ws",
      prompt: "arregla el test",
      origin: "local" as never,
      permissionMode: "default",
      gate: async () => ({ allow: true }),
      askUser: async () => ({}),
      onEvent: (e) => void events.push(e),
    });
    await until(() => calls.length === 1);
    expect(calls[0]!.status).toBe(200);
    // Our key upstream; the session token never past the gateway.
    const seen = fakes.seen.at(-1)!;
    expect(seen.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    const [cred] = await admin`select id, token_hash from chalito_private.coding_credentials where owner = ${owner}`;
    expect(JSON.stringify(seen)).not.toContain("chc_");

    // gpt-5.6-luna: 20k in at 0.20 + 2k out at 1.20 per 1M = 6_400 micros, billed by the hub at its 160%.
    await until(
      async () => (await admin`select 1 from chalito_private.usage_outbox where owner = ${owner}`).length === 1,
    );
    await drainOutbox({
      store: new PostgresOutbox(serverSql),
      hub: hubClient,
      now: () => Date.now() + 1000,
      alert: () => undefined,
    });
    expect(hub.used(owner)).toBe(Math.ceil((6_400 * 2.6) / 4));

    // The owner lowers today's cap under what's spent: the next turn is refused and the agent says so.
    await admin`insert into chalito.coding_settings (owner, daily_cap_tokens) values (${owner}, 1000)
      on conflict (owner) do update set daily_cap_tokens = 1000`;
    h.prompt("otra vez", "local" as never);
    await until(() => calls.length === 2);
    expect(calls[1]!.status).toBe(402);
    await until(() => events.some((e) => e.type === "blocked"));
    expect(events.filter((e) => e.type === "blocked")).toEqual([{ type: "blocked", reason: "daily_cap" }]);
    expect(hub.events.size).toBe(1);

    // Session end: the token is revoked, the gateway refuses it, and the sweep closes the hold.
    h.close();
    await until(
      async () =>
        (await admin`select revoked_reason from chalito_private.coding_credentials where id = ${cred!.id}`)[0]!
          .revoked_reason === "session_end",
    );
    expect(await meter.sweep()).toBeGreaterThanOrEqual(1);
    expect(hub.reservations.filter((r) => r.user === owner).every((r) => r.status !== "open")).toBe(true);
  });
}
