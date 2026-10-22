import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { CodingMeter, HubClient, PostgresCodingStore } from "@chalito/billing";
import { FakeHub } from "@chalito/billing/testing";
import { SoftAuthenticator } from "@chalito/client-keys/testing";
import { loadPrices, loadProviders } from "@chalito/config";
import type { DeviceDoc } from "@chalito/protocol";
import { codingRoutes } from "../src/coding/routes.js";
import { PostgresCodingIssueStore } from "../src/coding/store.js";
import { MemoryAudit, type Deps } from "../src/deps.js";
import type { ApiRepo, StoredWebAuthnCredential, WebAuthnChallenge } from "../src/repo.js";
import { webauthnRoutes } from "../src/routes/webauthn.js";

/** /v1/coding (ADR 0030) on the real store (migration 20261021002000) as CHALITO_DB_ROLE, a hub ledger and a real passkey. */
const url = process.env.DATABASE_URL;
const role = process.env.CHALITO_DB_ROLE;
const RP = "chalito.chalyb.com";
const ORIGIN = `https://${RP}`;
const WA = { rpId: RP, rpName: "Chalito", origins: [ORIGIN], challengeTtlMs: 60_000 };
const providers = loadProviders();

if (!url) {
  describe("/v1/coding", () => it.skip("needs DATABASE_URL", () => {}));
} else {
  const admin = postgres(url, { onnotice: () => {} });
  const sql = postgres(url, { max: 4, onnotice: () => {}, ...(role ? { connection: { role } } : {}) });
  afterAll(async () => {
    await Promise.all([sql.end(), admin.end()]);
  });
  const clock = Date.UTC(2026, 9, 21, 18);
  const hub = new FakeHub(() => clock);

  const setup = async (
    o: { tier?: string; enabled?: boolean; maxLive?: number; allocation?: number; failIssue?: boolean } = {},
  ) => {
    const owner = `cd-${randomUUID()}`;
    const agentId = `agent_${randomBytes(6).toString("hex")}`;
    const phoneId = `phone_${randomBytes(6).toString("hex")}`;
    await admin`insert into chalito.tenants (id) values (${owner})`;
    await admin`insert into chalito.users (id, tenant_id, tier, tz) values (${owner}, ${owner}, ${o.tier ?? "Pro"}, 'America/Mexico_City')`;
    hub.setUser(owner, o.allocation ?? 50_000_000);
    const devices = [
      { deviceId: agentId, owner, role: "agent", revoked: false },
      { deviceId: phoneId, owner, role: "client", revoked: false },
    ] as unknown as DeviceDoc[];
    const challenges = new Map<string, WebAuthnChallenge>();
    const creds = new Map<string, StoredWebAuthnCredential>();
    const repo: Partial<ApiRepo> = {
      getDevice: async (ow, id) => devices.find((d) => d.owner === ow && d.deviceId === id) ?? null,
      putWebAuthnChallenge: async (c) => void challenges.set(`${c.owner}/${c.deviceId}/${c.purpose}`, c),
      takeWebAuthnChallenge: async (ow, d, p, now) => {
        const k = `${ow}/${d}/${p}`;
        const c = challenges.get(k);
        challenges.delete(k);
        return c && c.expiresAt > now ? c.challenge : null;
      },
      setDeviceWebAuthn: async (ow, d, cred) => (creds.set(`${ow}/${d}`, cred), true),
      getDeviceWebAuthn: async (ow, d) => creds.get(`${ow}/${d}`) ?? null,
      bumpWebAuthnCounter: async (ow, d, id, counter) => {
        const c = creds.get(`${ow}/${d}`);
        if (!c || c.credentialId !== id) return "not_found";
        if (counter !== 0 && counter <= c.counter) return "cloned";
        creds.set(`${ow}/${d}`, { ...c, counter });
        return "ok";
      },
    };
    const audit = new MemoryAudit();
    const deps = {
      repo,
      identity: {
        verify: async (t: string) => {
          if (t === "agent") return { uid: `d_${agentId}`, role: "agent", owner, deviceId: agentId };
          if (t === "phone") return { uid: `d_${phoneId}`, role: "client", owner, deviceId: phoneId };
          if (t === "person") return { uid: owner, role: "user", owner };
          if (t === "other-agent") return { uid: "d_x", role: "agent", owner: "someone-else", deviceId: agentId };
          throw new Error("bad token");
        },
      },
      audit,
      config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
      now: () => clock,
    } as unknown as Deps;
    let enabled = o.enabled ?? true;
    const app = new Hono()
      .route(
        "/v1/coding",
        codingRoutes(
          deps,
          {
            store: o.failIssue
              ? Object.assign(new PostgresCodingIssueStore(sql), {
                  issue: async () => Promise.reject(new Error("db down")),
                })
              : new PostgresCodingIssueStore(sql),
            hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "t", fetch: hub.fetch }),
            meter: new CodingMeter({
              store: new PostgresCodingStore(sql),
              hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "t", fetch: hub.fetch }),
              prices: loadPrices(),
              cfg: providers.codingManaged,
              reserveBasis: "pre_margin",
              now: () => clock,
            }),
            prices: loadPrices(),
            providers,
            maxLivePerDevice: o.maxLive ?? 6,
            reserveBasis: "pre_margin",
            enabled: () => enabled,
            gatewayUrl: "https://ai.chalito.test",
          },
          WA,
        ),
      )
      .route("/v1/webauthn", webauthnRoutes(deps, WA));
    const call = async (method: string, path: string, token: string, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return {
        status: res.status,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        json: (text.startsWith("{") ? JSON.parse(text) : null) as Record<string, any>,
        headers: res.headers,
      };
    };
    const auth = new SoftAuthenticator({ origin: ORIGIN, alg: -8 });
    const enrol = async () => {
      const opts = await call("POST", "/v1/webauthn/register/options", "phone", {});
      await call("POST", "/v1/webauthn/register/verify", "phone", { response: await auth.create(opts.json.options) });
    };
    const stepUp = async () => auth.get((await call("POST", "/v1/webauthn/assert/options", "phone", {})).json.options);
    const issue = (sid = "s1", agent = "codex") => call("POST", "/v1/coding/credentials", "agent", { sid, agent });
    return { owner, agentId, call, issue, enrol, stepUp, audit, setEnabled: (v: boolean) => (enabled = v) };
  };
  const row = async (id: string) => (await admin`select * from chalito_private.coding_credentials where id = ${id}`)[0];

  describe("/v1/coding credentials", () => {
    it("issues an opaque token stored only as its hash, bound to the session, with a hub hold before margin", async () => {
      const s = await setup();
      const r = await s.issue();
      expect(r.status).toBe(201);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.json).toMatchObject({
        baseUrl: "https://ai.chalito.test",
        agent: "codex",
        provider: "openai",
        models: providers.codingAgents.codex.managed!.models,
        defaultModel: "gpt-5.6-luna",
      });
      expect(r.json.token).toMatch(/^chc_[A-Za-z0-9_-]{43}$/);
      const db = await row(r.json.id);
      expect(db).toMatchObject({ owner: s.owner, device_id: s.agentId, sid: "s1", agent: "codex", provider: "openai" });
      expect(db!.token_hash).toBe(createHash("sha256").update(r.json.token).digest("hex"));
      expect(JSON.stringify(db)).not.toContain(r.json.token);
      // Full window worst case for gpt-5.6-luna: 400k in + 32k out = 118_400 micros → 29_600 tokens before margin.
      const hold = hub.reservations.find((x) => x.jobId === `coding:${r.json.id}:0`)!;
      expect(hold.cls).toBe("stream");
      expect(hold.est).toBe(Math.ceil(29_600 * 2.6));
      expect(db!.reservation_id).toBe(hold.id);
      // The audit never carries the token.
      expect(JSON.stringify(s.audit.events)).not.toContain(r.json.token);
      expect(s.audit.events.at(-1)).toMatchObject({ action: "coding.credential_issued", target: r.json.id });
    });

    it("re-issuing for the same session revokes the previous token (reissued) and frees its hold at once", async () => {
      const s = await setup();
      const a = await s.issue();
      const b = await s.issue();
      expect(b.status).toBe(201);
      expect(await row(a.json.id)).toMatchObject({ revoked_reason: "reissued" });
      expect((await row(a.json.id))!.settled_at).not.toBeNull();
      expect(hub.reservations.find((x) => x.jobId === `coding:${a.json.id}:0`)!.status).toBe("succeeded");
      expect((await row(b.json.id))!.revoked_at).toBeNull();
    });

    it("on Pro (one stream) a session can start right after the previous one ended", async () => {
      const s = await setup();
      hub.activeStreams = 1;
      try {
        const a = await s.issue("one");
        expect(a.status).toBe(201);
        expect((await s.call("DELETE", `/v1/coding/credentials/${a.json.id}`, "agent")).status).toBe(200);
        expect((await s.issue("two")).status).toBe(201);
      } finally {
        hub.activeStreams = 5;
      }
    });

    it("never for Claude Code or an unknown agent", async () => {
      const s = await setup();
      expect((await s.issue("s1", "claude-code")).json).toEqual({ error: "not_managed" });
      expect((await s.issue("s1", "opencode")).status).toBe(400);
    });

    it("paid tiers only", async () => {
      expect((await (await setup({ tier: "free" })).issue()).json).toEqual({ error: "not_eligible" });
      expect((await (await setup({ tier: "VIP" })).issue()).status).toBe(201);
    });

    it("the kill switch: off means no credential", async () => {
      const s = await setup({ enabled: false });
      expect((await s.issue()).json).toEqual({ error: "managed_disabled" });
      s.setEnabled(true);
      expect((await s.issue()).status).toBe(201);
    });

    it("clients and the person can't get one; only the device's agent", async () => {
      const s = await setup();
      expect((await s.call("POST", "/v1/coding/credentials", "phone", { sid: "s1", agent: "codex" })).status).toBe(403);
      expect((await s.call("POST", "/v1/coding/credentials", "person", { sid: "s1", agent: "codex" })).status).toBe(
        403,
      );
    });

    it("live credentials per device are capped (sessions.yaml); re-issuing the same session doesn't count", async () => {
      const s = await setup({ maxLive: 2 });
      expect((await s.issue("s1")).status).toBe(201);
      expect((await s.issue("s2")).status).toBe(201);
      expect((await s.issue("s1")).status).toBe(201);
      expect((await s.issue("s3")).json).toEqual({ error: "session_limit" });
    });

    it("10 parallel issues on one device never exceed the live limit; the refused ones release their holds", async () => {
      const s = await setup({ maxLive: 3 });
      hub.activeStreams = 50;
      try {
        const results = await Promise.all(Array.from({ length: 10 }, (_, i) => s.issue(`par${i}`)));
        expect(results.filter((r) => r.status === 201)).toHaveLength(3);
        expect(results.filter((r) => r.status === 429).map((r) => r.json.error)).toEqual(
          Array(7).fill("session_limit"),
        );
        const live =
          await admin`select 1 from chalito_private.coding_credentials where owner = ${s.owner} and revoked_at is null`;
        expect(live).toHaveLength(3);
        const mine = hub.reservations.filter((r) => r.user === s.owner);
        expect(mine.filter((r) => r.status === "open")).toHaveLength(3);
        expect(mine.filter((r) => r.status === "cancelled")).toHaveLength(mine.length - 3);
      } finally {
        hub.activeStreams = 5;
      }
    });

    it("freezes the cap's zone at the first issue; a later tz change waits for that day to end", async () => {
      const s = await setup();
      expect((await s.issue("z1")).status).toBe(201);
      expect(
        (await admin`select cap_tz, cap_tz_next from chalito.coding_settings where owner = ${s.owner}`)[0],
      ).toEqual({
        cap_tz: "America/Mexico_City",
        cap_tz_next: null,
      });
      await admin`update chalito.users set tz = 'Asia/Tokyo' where id = ${s.owner}`;
      expect((await s.issue("z2")).status).toBe(201);
      const [z] =
        await admin`select cap_tz, cap_tz_next, cap_tz_from from chalito.coding_settings where owner = ${s.owner}`;
      expect(z).toMatchObject({ cap_tz: "America/Mexico_City", cap_tz_next: "Asia/Tokyo" });
      expect(z!.cap_tz_from.toISOString()).toBe("2026-10-22T06:00:00.000Z");
    });

    it("a failed write after the hold was admitted gives the hold back", async () => {
      const s = await setup({ failIssue: true });
      expect((await s.issue()).status).toBe(500);
      const mine = hub.reservations.filter((r) => r.user === s.owner);
      expect(mine.map((r) => r.status)).toEqual(["cancelled"]);
    });

    it("out of tokens: 402 out_of_energy, nothing stored", async () => {
      const s = await setup({ allocation: 10 });
      expect(await s.issue()).toMatchObject({ status: 402, json: { error: "out_of_energy" } });
      expect(await admin`select 1 from chalito_private.coding_credentials where owner = ${s.owner}`).toHaveLength(0);
    });

    it("over today's cap: 402 daily_cap before the hub is asked", async () => {
      const s = await setup();
      await admin`insert into chalito.coding_spend_daily (owner, day, agent, billable_tokens) values (${s.owner}, '2026-10-21', 'codex', ${providers.codingManaged.dailyCap.default})`;
      const before = hub.calls.length;
      expect(await s.issue()).toMatchObject({ status: 402, json: { error: "daily_cap" } });
      expect(hub.calls.length).toBe(before);
    });

    it("the hub's stream cap: 429 managed_busy", async () => {
      const s = await setup();
      hub.activeStreams = 1;
      try {
        expect((await s.issue("s1")).status).toBe(201);
        expect(await s.issue("s2")).toMatchObject({ status: 429, json: { error: "managed_busy" } });
      } finally {
        hub.activeStreams = 5;
      }
    });

    it("status and session end, only on the issuing device and owner", async () => {
      const s = await setup();
      const { json } = await s.issue();
      expect((await s.call("GET", `/v1/coding/credentials/${json.id}`, "agent")).json).toEqual({
        id: json.id,
        state: "active",
        blockedReason: null,
        revokedReason: null,
      });
      await admin`update chalito_private.coding_credentials set last_used_at = ${new Date(clock - (providers.codingManaged.credentialIdleSeconds + 1) * 1000)} where id = ${json.id}`;
      expect((await s.call("GET", `/v1/coding/credentials/${json.id}`, "agent")).json.state).toBe("expired");
      await admin`update chalito_private.coding_credentials set last_used_at = ${new Date(clock)} where id = ${json.id}`;
      expect((await s.call("DELETE", `/v1/coding/credentials/${json.id}`, "other-agent")).status).toBe(403);
      expect((await row(json.id))!.revoked_at).toBeNull();
      await admin`update chalito_private.coding_credentials set blocked_reason = 'out_of_energy' where id = ${json.id}`;
      expect((await s.call("GET", `/v1/coding/credentials/${json.id}`, "agent")).json.blockedReason).toBe(
        "out_of_energy",
      );
      expect((await s.call("DELETE", `/v1/coding/credentials/${json.id}`, "agent")).status).toBe(200);
      expect((await s.call("GET", `/v1/coding/credentials/${json.id}`, "agent")).json).toMatchObject({
        state: "revoked",
        revokedReason: "session_end",
      });
    });
  });

  describe("/v1/coding settings (daily cap)", () => {
    it("shows the default cap, the tier's ceiling and today's spend", async () => {
      const s = await setup();
      await admin`insert into chalito.coding_spend_daily (owner, day, agent, billable_tokens, requests) values
        (${s.owner}, '2026-10-21', 'codex', 1000, 2), (${s.owner}, '2026-10-21', 'gemini-cli', 500, 1), (${s.owner}, '2026-10-20', 'codex', 7, 1)`;
      const r = await s.call("GET", "/v1/coding/settings", "person");
      expect(r.json).toMatchObject({
        enabled: true,
        eligible: true,
        tier: "pro",
        dailyCapTokens: 1_250_000,
        defaultCapTokens: 1_250_000,
        ceilingTokens: providers.codingManaged.dailyCap.ceiling.pro,
        today: { day: "2026-10-21", billableTokens: 1500 },
      });
      expect(r.json.days).toHaveLength(3);
    });

    it("lowering is free, even without a passkey or a device", async () => {
      const s = await setup();
      expect((await s.call("POST", "/v1/coding/settings", "person", { dailyCapTokens: 100_000 })).status).toBe(200);
      expect((await s.call("GET", "/v1/coding/settings", "person")).json.dailyCapTokens).toBe(100_000);
    });

    it("raising needs the passkey on a client device, and never goes above the tier's ceiling", async () => {
      const s = await setup();
      const ceiling = providers.codingManaged.dailyCap.ceiling.pro!;
      expect(await s.call("POST", "/v1/coding/settings", "person", { dailyCapTokens: 2_000_000 })).toMatchObject({
        status: 403,
        json: { error: "step_up_required" },
      });
      // No passkey on the device yet: 403; with one but no assertion: 401.
      expect((await s.call("POST", "/v1/coding/settings", "phone", { dailyCapTokens: 2_000_000 })).status).toBe(403);
      await s.enrol();
      expect((await s.call("POST", "/v1/coding/settings", "phone", { dailyCapTokens: 2_000_000 })).status).toBe(401);
      expect(
        (
          await s.call("POST", "/v1/coding/settings", "phone", {
            dailyCapTokens: ceiling + 1,
            stepUp: await s.stepUp(),
          })
        ).json,
      ).toEqual({ error: "above_ceiling" });
      const ok = await s.call("POST", "/v1/coding/settings", "phone", {
        dailyCapTokens: 2_000_000,
        stepUp: await s.stepUp(),
      });
      expect(ok).toMatchObject({ status: 200, json: { dailyCapTokens: 2_000_000 } });
      expect(s.audit.events.at(-1)).toMatchObject({
        action: "coding.cap_changed",
        meta: { from: 1_250_000, to: 2_000_000, stepUp: true },
      });
      // An assertion is single-use.
      const reused = await s.stepUp();
      await s.call("POST", "/v1/coding/settings", "phone", { dailyCapTokens: 2_100_000, stepUp: reused });
      expect(
        (await s.call("POST", "/v1/coding/settings", "phone", { dailyCapTokens: 2_200_000, stepUp: reused })).status,
      ).toBe(401);
    });

    it("off the paid tiers: no cap to change", async () => {
      const s = await setup({ tier: "free" });
      expect((await s.call("POST", "/v1/coding/settings", "person", { dailyCapTokens: 1 })).json).toEqual({
        error: "not_eligible",
      });
    });
  });
}
