import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CodingMeter, HubClient, PostgresCodingStore, drainOutbox, PostgresOutbox } from "@chalito/billing";
import { FakeHub } from "@chalito/billing/testing";
import { loadPrices, loadProviders } from "@chalito/config";
import { createGateway } from "../src/app.js";
import { FakeProviders } from "./fake-providers.js";

/** The gateway end to end: real HTTP in and out, fake providers, the hub ledger, the database as chalito_ai_gateway. */
const url = process.env.DATABASE_URL;
const OPENAI_KEY = "sk-chalyb-openai-SECRET";
const XAI_KEY = "xai-chalyb-SECRET";
const GEMINI_KEY = "AIza-chalyb-SECRET";

if (!url) {
  describe("ai-gateway", () => it.skip("needs DATABASE_URL", () => {}));
} else {
  const admin = postgres(url, { onnotice: () => {} });
  const gw = postgres(url, { max: 8, onnotice: () => {}, connection: { role: "chalito_ai_gateway" } });
  const server = postgres(url, { max: 2, onnotice: () => {}, connection: { role: "chalito_server" } });
  const providers = loadProviders();
  const fakes = new FakeProviders();
  const hub = new FakeHub();
  const logs: string[] = [];
  let enabled = true;
  let base = "";
  let http: ServerType;
  let perToken = { capacity: 60, refillPerSec: 1 };
  let drainMs = 10_000;
  let failFinish = 0;
  let gwApp: ReturnType<typeof createGateway>;
  const upstreams = {
    openai: { baseUrl: "", apiKey: OPENAI_KEY },
    xai: { baseUrl: "", apiKey: XAI_KEY },
    google: { baseUrl: "", apiKey: GEMINI_KEY },
  };
  const meter = new CodingMeter({
    store: new PostgresCodingStore(gw),
    hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "t", fetch: hub.fetch }),
    prices: loadPrices(),
    cfg: providers.codingManaged,
    reserveBasis: "pre_margin",
    now: Date.now,
  });

  beforeAll(async () => {
    const up = await fakes.start();
    upstreams.openai.baseUrl = `${up}/openai/v1`;
    upstreams.xai.baseUrl = `${up}/xai/v1`;
    upstreams.google.baseUrl = `${up}/google`;
    const app = (gwApp = createGateway({
      store: new PostgresCodingStore(gw),
      // The real meter; `failFinish` makes its next finishes fail like a database blip.
      meter: {
        begin: (id, r) => meter.begin(id, r),
        finish: async (t, u, f) => {
          if (failFinish > 0) {
            failFinish -= 1;
            throw new Error("database unavailable");
          }
          return meter.finish(t, u, f);
        },
      },
      providers,
      upstreams,
      enabled: () => enabled,
      now: Date.now,
      get perToken() {
        return perToken;
      },
      get drainMs() {
        return drainMs;
      },
      log: (m, meta) => void logs.push(`${m} ${JSON.stringify(meta)}`),
    }));
    http = serve({ fetch: app.fetch, port: 0 });
    await new Promise((r) => http.once("listening", r));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    http.close();
    await fakes.stop();
    await Promise.all([gw.end(), server.end(), admin.end()]);
  });
  beforeEach(() => {
    enabled = true;
    perToken = { capacity: 60, refillPerSec: 1 };
    drainMs = 10_000;
    failFinish = 0;
  });

  const session = async (
    agent: "codex" | "grok-build" | "gemini-cli" = "codex",
    o: { allocation?: number; tier?: string } = {},
  ) => {
    const owner = `gw-${randomUUID()}`;
    const device = `desk_${randomBytes(6).toString("hex")}`;
    await admin`insert into chalito.tenants (id) values (${owner})`;
    await admin`insert into chalito.users (id, tenant_id, tier, tz) values (${owner}, ${owner}, ${o.tier ?? "Pro"}, 'America/Mexico_City')`;
    await admin`insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id, revoked)
      values (${owner}, ${device}, 'agent', 'desktop', 'linux', 'Desk', 'pk', 'p', 'f', 'pairing', ${randomUUID()}, false)`;
    const managed = providers.codingAgents[agent].managed ?? { models: ["grok-4.3"], defaultModel: "grok-4.3" };
    const provider = { codex: "openai", "grok-build": "xai", "gemini-cli": "google" }[agent];
    const id = `cc_${randomBytes(16).toString("hex")}`;
    const token = `chc_${randomBytes(32).toString("base64url")}`;
    await admin`insert into chalito_private.coding_credentials (id, token_hash, owner, device_id, sid, agent, provider, models, expires_at)
      values (${id}, ${createHash("sha256").update(token).digest("hex")}, ${owner}, ${device}, 'sid1', ${agent}, ${provider},
              ${managed.models}, ${new Date(Date.now() + 3_600_000)})`;
    hub.setUser(owner, o.allocation ?? 50_000_000);
    return { owner, id, token, model: managed.defaultModel };
  };
  const responses = (token: string, body: Record<string, unknown>, signal?: AbortSignal) =>
    fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "session-id": "codex-thread-1" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  const events = (owner: string) =>
    admin<
      { source_id: string; event: { amount: number; cost_usd_micros: number; metadata: Record<string, unknown> } }[]
    >`
      select source_id, event from chalito_private.usage_outbox where owner = ${owner} order by id`;
  const cred = async (id: string) =>
    (await admin`select * from chalito_private.coding_credentials where id = ${id}`)[0]!;
  const until = async (check: () => Promise<boolean>, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timed out");
  };
  const drain = () =>
    drainOutbox({
      store: new PostgresOutbox(server),
      hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "t", fetch: hub.fetch }),
      now: () => Date.now() + 1000,
      alert: () => undefined,
    });
  // gpt-5.6-luna: 0.20 in, 1.20 out, 0.02 cached, per 1M.
  const usage = {
    input_tokens: 12_000,
    input_tokens_details: { cached_tokens: 2_000 },
    output_tokens: 1_500,
    total_tokens: 13_500,
  };
  const usageCost = Math.ceil(10_000 * 0.2 + 1_500 * 1.2 + 2_000 * 0.02); // 3_840

  describe("Codex (Responses, streamed)", () => {
    it("streams the provider's answer back, with our key upstream and the session token never past the gateway", async () => {
      const s = await session();
      fakes.behaviour = { kind: "responses", usage, text: "listo" };
      const res = await responses(s.token, {
        model: s.model,
        stream: true,
        input: [{ role: "user", content: "hola" }],
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("listo0");
      expect(text).toContain("response.completed");
      const seen = fakes.seen.at(-1)!;
      expect(seen.path).toBe("/openai/v1/responses");
      expect(seen.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
      expect(JSON.stringify(seen)).not.toContain(s.token);
      // Codex never sends a limit; the gateway sets the agent's.
      expect(seen.body!.max_output_tokens).toBe(providers.codingAgents.codex.managed!.maxOutputTokens);
      // Nothing from the CLI's own headers reaches the provider.
      expect(seen.headers["session-id"]).toBeUndefined();
      expect(text).not.toContain(OPENAI_KEY);

      await until(async () => (await events(s.owner)).length === 1);
      const [e] = await events(s.owner);
      expect(e!.source_id).toBe(`coding:${s.id}:r1`);
      expect(e!.event).toMatchObject({
        amount: 13_500,
        cost_usd_micros: usageCost,
        metadata: { tokens: { input: 10_000, output: 1_500, cache_read: 2_000, cache_write: 0 }, agent: "codex" },
      });
      await until(async () => Number((await cred(s.id)).inflight_micros) === 0);
      expect((await drain()).sent).toBeGreaterThanOrEqual(1);
      expect(hub.used(s.owner)).toBe(Math.ceil((usageCost * 2.6) / 4));
    });

    it("a request's own limit is kept when lower, clamped when higher", async () => {
      const s = await session();
      fakes.behaviour = { kind: "responses", usage, stream: false };
      await (await responses(s.token, { model: s.model, max_output_tokens: 100 })).text();
      expect(fakes.seen.at(-1)!.body!.max_output_tokens).toBe(100);
      await (await responses(s.token, { model: s.model, max_output_tokens: 10_000_000 })).text();
      expect(fakes.seen.at(-1)!.body!.max_output_tokens).toBe(providers.codingAgents.codex.managed!.maxOutputTokens);
    });

    it("a JSON (non-streamed) answer is billed from its usage", async () => {
      const s = await session();
      fakes.behaviour = { kind: "responses", usage, stream: false };
      const res = await responses(s.token, { model: s.model });
      expect(((await res.json()) as { usage: unknown }).usage).toEqual(usage);
      await until(async () => (await events(s.owner)).length === 1);
      expect((await events(s.owner))[0]!.event.cost_usd_micros).toBe(usageCost);
    });

    it("the CLI hangs up mid-stream: the gateway reads the provider to the end and bills the real usage", async () => {
      const s = await session();
      fakes.behaviour = { kind: "responses", usage, delayMs: 60, chunks: 8 };
      const ctrl = new AbortController();
      const done = fakes.streamsDone;
      const res = await responses(s.token, { model: s.model, stream: true }, ctrl.signal);
      const r = res.body!.getReader();
      await r.read();
      ctrl.abort();
      await until(async () => fakes.streamsDone > done);
      await until(async () => (await events(s.owner)).length === 1);
      expect((await events(s.owner))[0]!.event).toMatchObject({ cost_usd_micros: usageCost });
      expect((await events(s.owner))[0]!.event.metadata.estimated).toBeUndefined();
    });

    it("the provider cuts the stream before its usage: billed at the estimate, marked so", async () => {
      const s = await session();
      fakes.behaviour = { kind: "cut", chunks: 2 };
      const res = await responses(s.token, { model: s.model, stream: true, input: "x".repeat(1000) });
      await res.text().catch(() => "");
      await until(async () => (await events(s.owner)).length === 1);
      const [e] = await events(s.owner);
      expect(e!.event.metadata).toMatchObject({ estimated: true });
      expect(e!.event.cost_usd_micros).toBeGreaterThan(0);
    });

    it("the provider refuses (500): the error goes back, nothing is billed, the hold is released", async () => {
      const s = await session();
      fakes.behaviour = { kind: "status", status: 500, body: { error: { message: "overloaded" } } };
      const res = await responses(s.token, { model: s.model, stream: true });
      expect(res.status).toBe(502);
      await res.text();
      await until(async () => Number((await cred(s.id)).inflight_micros) === 0);
      expect(await events(s.owner)).toHaveLength(0);
    });

    it("refuses a model outside the session's allowlist before anything is spent", async () => {
      const s = await session();
      const before = fakes.seen.length;
      const res = await responses(s.token, { model: "gpt-6-pro" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("model_not_allowed");
      expect(fakes.seen.length).toBe(before);
    });
  });

  describe("failure paths still bill exactly once", () => {
    it("the CLI hangs up and then the provider cuts the stream: the estimate is billed and the hold released", async () => {
      const s = await session();
      fakes.behaviour = { kind: "cut", chunks: 2, delayMs: 300 };
      const ctrl = new AbortController();
      const res = await responses(s.token, { model: s.model, stream: true }, ctrl.signal);
      await res.body!.getReader().read();
      ctrl.abort();
      await until(async () => (await events(s.owner)).length === 1);
      expect((await events(s.owner))[0]!.event.metadata).toMatchObject({ estimated: true });
      await until(async () => Number((await cred(s.id)).inflight_micros) === 0);
      expect(logs.some((l) => l.startsWith("upstream.stream_cut"))).toBe(true);
    });

    it("a provider that stalls after the CLI left is cut off after drainMs and the estimate billed", async () => {
      const s = await session();
      drainMs = 300;
      fakes.behaviour = { kind: "stall", chunks: 2 };
      const ctrl = new AbortController();
      const res = await responses(s.token, { model: s.model, stream: true }, ctrl.signal);
      await res.body!.getReader().read();
      ctrl.abort();
      await until(async () => (await events(s.owner)).length === 1, 5000);
      expect((await events(s.owner))[0]!.event.metadata).toMatchObject({ estimated: true });
    });

    it("the provider can't be reached: 502, nothing billed, the hold released", async () => {
      const s = await session();
      const was = upstreams.openai.baseUrl;
      upstreams.openai.baseUrl = "http://127.0.0.1:9/v1";
      try {
        const res = await responses(s.token, { model: s.model });
        expect(res.status).toBe(502);
      } finally {
        upstreams.openai.baseUrl = was;
      }
      expect(Number((await cred(s.id)).inflight_micros)).toBe(0);
      expect(await events(s.owner)).toHaveLength(0);
    });

    it("the database refuses the usage once: retried at once, billed once", async () => {
      const s = await session();
      fakes.behaviour = { kind: "responses", usage, stream: false };
      failFinish = 1;
      await (await responses(s.token, { model: s.model })).text();
      await until(async () => (await events(s.owner)).length === 1);
      expect((await events(s.owner))[0]!.event.cost_usd_micros).toBe(usageCost);
    });

    it("the database stays down: the usage waits and the next tick records it", async () => {
      const s = await session();
      fakes.behaviour = { kind: "responses", usage, stream: false };
      failFinish = 3;
      await (await responses(s.token, { model: s.model })).text();
      await until(async () => gwApp.pendingCount() === 1, 5000);
      expect(await events(s.owner)).toHaveLength(0);
      expect(await gwApp.retryPending()).toBe(true);
      expect((await events(s.owner))[0]!.event.cost_usd_micros).toBe(usageCost);
      expect(Number((await cred(s.id)).inflight_micros)).toBe(0);
    });

    it("SIGTERM while a hung-up stream drains: the drain is cut to the shutdown's deadline and billed", async () => {
      const s = await session();
      fakes.behaviour = { kind: "stall", chunks: 2 };
      const ctrl = new AbortController();
      const res = await responses(s.token, { model: s.model, stream: true }, ctrl.signal);
      await res.body!.getReader().read();
      ctrl.abort();
      await new Promise((r) => setTimeout(r, 100));
      const t0 = Date.now();
      await gwApp.shutdown(200);
      expect(Date.now() - t0).toBeLessThan(2000);
      await until(async () => (await events(s.owner)).length === 1, 2000);
    });

    it("a provider error body never reaches the CLI (it can name our org or key); the status does", async () => {
      const s = await session();
      fakes.behaviour = {
        kind: "status",
        status: 429,
        body: { error: { message: "Rate limit for org-SECRET42 on key sk-...abcd" } },
      };
      const res = await responses(s.token, { model: s.model });
      expect(res.status).toBe(429);
      const text = await res.text();
      expect(text).not.toContain("org-SECRET42");
      expect(JSON.parse(text)).toMatchObject({ error: { code: "upstream_error" } });
    });

    it("SIGTERM mid-stream: the stream is stopped and billed before the process exits", async () => {
      const s = await session();
      fakes.behaviour = { kind: "stall", chunks: 2 };
      const res = await responses(s.token, { model: s.model, stream: true });
      await res.body!.getReader().read();
      await gwApp.shutdown(200);
      await until(async () => (await events(s.owner)).length === 1);
      expect((await events(s.owner))[0]!.event.metadata).toMatchObject({ estimated: true });
    });

    it("paid built-in tools and stored state never go out on our key; store is always off", async () => {
      const s = await session();
      const before = fakes.seen.length;
      for (const body of [
        { model: s.model, tools: [{ type: "web_search_preview" }] },
        { model: s.model, tools: [{ type: "code_interpreter" }] },
        { model: s.model, previous_response_id: "resp_old" },
        { model: s.model, tools: [{ type: "brand_new_hosted_tool" }] },
        { model: s.model, background: true },
      ]) {
        const r = await responses(s.token, body);
        expect(r.status).toBe(400);
        await r.text();
      }
      expect(fakes.seen.length).toBe(before);
      fakes.behaviour = { kind: "responses", usage, stream: false };
      await (
        await responses(s.token, { model: s.model, store: true, tools: [{ type: "function", name: "shell" }] })
      ).text();
      expect(fakes.seen.at(-1)!.body!.store).toBe(false);
      const g = await session("gemini-cli");
      const gr = await fetch(`${base}/v1beta/models/${g.model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": g.token, "content-type": "application/json" },
        body: JSON.stringify({ contents: [], tools: [{ googleSearch: {} }] }),
      });
      expect(gr.status).toBe(400);
      for (const extra of [
        { tools: [{ google_search: {} }] },
        { tools: [{ code_execution: {} }] },
        { cached_content: "cachedContents/x" },
      ]) {
        const r = await fetch(`${base}/v1beta/models/${g.model}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": g.token, "content-type": "application/json" },
          body: JSON.stringify({ contents: [], ...extra }),
        });
        expect(r.status, JSON.stringify(extra)).toBe(400);
        await r.text();
      }
      // A priority tier is never asked for on our key.
      await (await responses(s.token, { model: s.model, service_tier: "priority" })).text();
      expect(fakes.seen.at(-1)!.body!.service_tier).toBeUndefined();
      // The token in the query string is never accepted (request logs keep it).
      const q = await fetch(`${base}/v1beta/models/${g.model}:generateContent?key=${g.token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(q.status).toBe(401);
    });

    it("Gemini generateContent (not streamed) is billed from its usageMetadata, not the estimate", async () => {
      const s = await session("gemini-cli");
      fakes.behaviour = {
        kind: "gemini",
        stream: false,
        usage: { promptTokenCount: 2_000, candidatesTokenCount: 100, totalTokenCount: 2_100 },
      };
      const res = await fetch(`${base}/v1beta/models/${s.model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": s.token, "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hola" }] }] }),
      });
      expect(res.status).toBe(200);
      await res.text();
      await until(async () => (await events(s.owner)).length === 1);
      const [e] = await events(s.owner);
      expect(e!.event.cost_usd_micros).toBe(500 + 150);
      expect(e!.event.metadata.estimated).toBeUndefined();
    });
  });

  describe("money limits", () => {
    it("the daily cap: the request that crosses it finishes; the next gets 402 daily_cap and the credential says so", async () => {
      const s = await session();
      // Room for one request's worst case plus a little: the second request's worst case no longer fits.
      const body = { model: s.model, max_output_tokens: 32_000 };
      const worst = Math.ceil(Buffer.byteLength(JSON.stringify(body)) * 0.2 + 32_000 * 1.2);
      await admin`insert into chalito.coding_settings (owner, daily_cap_tokens) values (${s.owner}, ${Math.ceil((worst * 2.6) / 4) + 2_000})`;
      fakes.behaviour = { kind: "responses", usage, stream: false };
      const first = await responses(s.token, { model: s.model });
      expect(first.status).toBe(200);
      await first.text();
      await until(async () => (await events(s.owner)).length === 1);
      const second = await responses(s.token, { model: s.model });
      expect(second.status).toBe(402);
      expect(((await second.json()) as { error: { code: string } }).error.code).toBe("daily_cap");
      expect((await cred(s.id)).blocked_reason).toBe("daily_cap");
    });

    it("balance exhausted mid-session: the next request gets 402 out_of_energy", async () => {
      const input = "x".repeat(10_000);
      const s0 = { model: providers.codingAgents.codex.managed!.defaultModel };
      const payload = JSON.stringify({ ...s0, input, max_output_tokens: 32_000 });
      const worst = Math.ceil(Buffer.byteLength(payload) * 0.2 + 32_000 * 1.2);
      // The hub holds the worst case (plus its margin); after one request's usage it no longer fits.
      const s = await session("codex", { allocation: Math.ceil(Math.ceil(worst / 4) * 2.6) + 1_000 });
      fakes.behaviour = { kind: "responses", usage, stream: false };
      const first = await responses(s.token, { model: s.model, input: "x".repeat(10_000) });
      expect(first.status).toBe(200);
      await first.text();
      await until(async () => (await events(s.owner)).length === 1);
      await drain();
      const next = await responses(s.token, { model: s.model, input: "x".repeat(10_000) });
      expect(next.status).toBe(402);
      expect(((await next.json()) as { error: { code: string } }).error.code).toBe("out_of_energy");
      expect((await cred(s.id)).blocked_reason).toBe("out_of_energy");
    });

    it("a revoked or unknown token is refused (401), and never reaches the provider", async () => {
      const s = await session();
      await admin`update chalito_private.coding_credentials set revoked_at = now(), revoked_reason = 'session_end' where id = ${s.id}`;
      const before = fakes.seen.length;
      expect((await responses(s.token, { model: s.model })).status).toBe(401);
      expect((await responses(`chc_${randomBytes(32).toString("base64url")}`, { model: s.model })).status).toBe(401);
      expect((await responses("sk-not-ours", { model: s.model })).status).toBe(401);
      expect(fakes.seen.length).toBe(before);
    });

    it("the kill switch: 503 managed_disabled, and the token is revoked for good", async () => {
      const s = await session();
      enabled = false;
      const res = await responses(s.token, { model: s.model });
      expect(res.status).toBe(503);
      expect((await cred(s.id)).revoked_reason).toBe("kill_switch");
      enabled = true;
      expect((await responses(s.token, { model: s.model })).status).toBe(401);
    });

    it("per-token rate limit: 429 once the burst is spent", async () => {
      const s = await session();
      perToken = { capacity: 2, refillPerSec: 0.001 };
      fakes.behaviour = { kind: "responses", usage, stream: false };
      const codes = [];
      for (let i = 0; i < 3; i++) {
        const r = await responses(s.token, { model: s.model });
        codes.push(r.status);
        await r.text();
      }
      expect(codes).toEqual([200, 200, 429]);
    });

    it("a tier off the paid list is refused (403)", async () => {
      const s = await session("codex", { tier: "free" });
      expect((await responses(s.token, { model: s.model })).status).toBe(403);
    });
  });

  describe("Grok Build and Gemini CLI", () => {
    it("lists the session's models (Grok Build's start-up call), and a Grok credential is refused while managed Grok is pending", async () => {
      const s = await session("codex");
      const models = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${s.token}` } });
      expect(((await models.json()) as { data: { id: string }[] }).data.map((m) => m.id)).toEqual(
        providers.codingAgents.codex.managed!.models,
      );
      const g = await session("grok-build");
      const before = fakes.seen.length;
      const r = await responses(g.token, { model: "grok-4.3" });
      expect(r.status).toBe(400);
      expect(fakes.seen.length).toBe(before);
    });

    it("a Codex token can't be used on the Gemini route, nor a Gemini token on Responses", async () => {
      const codex = await session("codex");
      const gem = await session("gemini-cli");
      const g = await fetch(`${base}/v1beta/models/${gem.model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": codex.token, "content-type": "application/json" },
        body: "{}",
      });
      expect(g.status).toBe(401);
      expect((await responses(gem.token, { model: gem.model })).status).toBe(401);
    });

    it("Gemini: streamGenerateContent (SSE) billed from the final usageMetadata; countTokens forwarded, not billed", async () => {
      const s = await session("gemini-cli");
      fakes.behaviour = {
        kind: "gemini",
        usage: {
          promptTokenCount: 20_000,
          cachedContentTokenCount: 4_000,
          candidatesTokenCount: 800,
          thoughtsTokenCount: 200,
          totalTokenCount: 21_000,
        },
      };
      const res = await fetch(`${base}/v1beta/models/${s.model}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "x-goog-api-key": s.token, "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hola" }] }],
          generationConfig: { maxOutputTokens: 9_999_999 },
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("hola2");
      const seen = fakes.seen.at(-1)!;
      expect(seen.path).toBe(`/google/v1beta/models/${s.model}:streamGenerateContent?alt=sse`);
      expect(seen.headers["x-goog-api-key"]).toBe(GEMINI_KEY);
      expect((seen.body!.generationConfig as { maxOutputTokens: number }).maxOutputTokens).toBe(
        providers.codingAgents["gemini-cli"].managed!.maxOutputTokens,
      );
      await until(async () => (await events(s.owner)).length === 1);
      // gemini-3.1-flash-lite: 0.25 in, 1.50 out, 0.025 cached → 16k + 1k out + 4k cached.
      expect((await events(s.owner))[0]!.event).toMatchObject({
        cost_usd_micros: 4_000 + 1_500 + 100,
        metadata: { tokens: { input: 16_000, output: 1_000, cache_read: 4_000 } },
      });
      const count = await fetch(`${base}/v1beta/models/${s.model}:countTokens`, {
        method: "POST",
        headers: { "x-goog-api-key": s.token, "content-type": "application/json" },
        body: JSON.stringify({ contents: [] }),
      });
      expect(await count.json()).toEqual({ totalTokens: 42 });
      await new Promise((r) => setTimeout(r, 200));
      expect(await events(s.owner)).toHaveLength(1);
    });
  });

  it("no log line ever carries a session token or one of our keys", () => {
    const all = logs.join("\n");
    for (const secret of [OPENAI_KEY, XAI_KEY, GEMINI_KEY, "chc_"]) expect(all).not.toContain(secret);
  });
}
