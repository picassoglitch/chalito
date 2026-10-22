import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { loadPrices, loadProviders } from "@chalito/config";
import { CodingMeter, SETTLE_CUTOFF_MS, codingWorstCaseMicros, type CodingRequest } from "../src/coding.js";
import { HubClient } from "../src/hub.js";
import { drainOutbox } from "../src/outbox.js";
import { PostgresCodingStore } from "../src/postgres-coding.js";
import { PostgresOutbox } from "../src/postgres-outbox.js";
import { FakeHub } from "../src/testing/fake-hub.js";

/** The meter as chalito_ai_gateway (migration 20261021002000) against a hub ledger with admit_usage's rules. */
const url = process.env.DATABASE_URL;

if (!url) {
  describe("CodingMeter", () => it.skip("needs DATABASE_URL", () => {}));
} else {
  const admin = postgres(url, { onnotice: () => {} });
  const gw = postgres(url, { max: 6, onnotice: () => {}, connection: { role: "chalito_ai_gateway" } });
  const server = postgres(url, { max: 2, onnotice: () => {}, connection: { role: "chalito_server" } });
  afterAll(async () => {
    await Promise.all([gw.end(), server.end(), admin.end()]);
  });
  const prices = loadPrices();
  const real = loadProviders().codingManaged;
  // These tests move the clock by hours and days; the idle limit has its own test below.
  const cfg = { ...real, credentialIdleSeconds: 30 * 86_400 };
  let clock = Date.UTC(2026, 9, 21, 18); // 12:00 in Mexico City
  const now = () => clock;
  // One ledger for the file: a drain sends every pending row, whichever test wrote it.
  const hub = new FakeHub(now);

  const setup = async (o: { tier?: string; allocation?: number; tz?: string | null } = {}) => {
    const owner = `cm-${randomUUID()}`;
    await admin`insert into chalito.tenants (id) values (${owner})`;
    await admin`insert into chalito.users (id, tenant_id, tier, tz) values (${owner}, ${owner}, ${o.tier ?? "Pro"}, ${o.tz === undefined ? "America/Mexico_City" : o.tz})`;
    const desk = `desk_${randomBytes(6).toString("hex")}`;
    await admin`insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id, revoked)
      values (${owner}, ${desk}, 'agent', 'desktop', 'linux', 'Desk', 'pk', 'p', 'f', 'pairing', ${randomUUID()}, false)`;
    const id = `cc_${randomBytes(16).toString("hex")}`;
    await admin`insert into chalito_private.coding_credentials (id, token_hash, owner, device_id, sid, agent, provider, models, expires_at, created_at)
      values (${id}, ${createHash("sha256").update(id).digest("hex")}, ${owner}, ${desk}, 'sid1', 'codex', 'openai',
              ${["gpt-5.6-luna"]}, ${new Date(clock + 2 * 86_400_000)}, ${new Date(clock - 1000)})`;
    hub.setUser(owner, o.allocation ?? 10_000_000);
    const meter = new CodingMeter({
      store: new PostgresCodingStore(gw),
      hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "t", fetch: hub.fetch }),
      prices,
      cfg,
      reserveBasis: "pre_margin",
      now,
    });
    const drain = () =>
      drainOutbox({
        store: new PostgresOutbox(server),
        hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "t", fetch: hub.fetch }),
        // The outbox schedules on the database's clock, not the test's.
        now: () => Date.now() + 1000,
        alert: () => undefined,
      });
    return { owner, id, meter, drain };
  };
  const req: CodingRequest = {
    model: "gpt-5.6-luna",
    inputBytes: 40_000,
    maxInputTokens: 400_000,
    maxOutputTokens: 32_000,
  };
  const worst = codingWorstCaseMicros(prices, "openai", req); // 8_000 + 38_400
  const usage = { input: 9_000, output: 1_000, cacheRead: 2_000 }; // 1_800 + 1_200 + 40 micros
  const usageCost = 3_040;
  const admits = (id: string) =>
    hub.calls
      .filter(
        (c) =>
          c.path === "/usage/admit" &&
          String((c.body as Record<string, unknown>).external_job_id).startsWith(`coding:${id}:`),
      )
      .map((c) => c.body as Record<string, unknown>);
  const holds = (id: string) => hub.reservations.filter((r) => r.jobId.startsWith(`coding:${id}:`));
  const cred = async (id: string) =>
    (await admin`select * from chalito_private.coding_credentials where id = ${id}`)[0]!;
  const outbox = (owner: string) =>
    admin<
      { source_id: string; event: Record<string, unknown> & { metadata?: unknown } }[]
    >`select source_id, event from chalito_private.usage_outbox where owner = ${owner} order by id`;

  describe("CodingMeter", () => {
    it("a request: the hold covers its worst case (before margin), then its usage is billed once, by the hub", async () => {
      const { owner, id, meter, drain } = await setup();
      const b = await meter.begin(id, req);
      expect(b.ok).toBe(true);
      if (!b.ok) return;
      const admit = admits(id)[0]!;
      expect(admit).toMatchObject({
        class: "stream",
        operation: "coding.session",
        external_job_id: `coding:${id}:0`,
        est_tokens: Math.ceil(worst / 4),
      });
      // The hub adds its 160% when it holds.
      expect(holds(id)[0]!.est).toBe(Math.ceil(Math.ceil(worst / 4) * 2.6));
      expect(Number((await cred(id)).inflight_micros)).toBe(worst);

      await meter.finish(b.ticket, usage, { outputBytes: 0 });
      const [row] = await outbox(owner);
      expect(row!.source_id).toBe(`coding:${id}:r1`);
      expect(row!.event).toMatchObject({
        kind: "llm.tokens",
        provider: "openai",
        amount: 12_000,
        cost_usd_micros: usageCost,
        reservation_id: b.ticket.reservationId,
        metadata: {
          model: "gpt-5.6-luna",
          agent: "codex",
          purpose: "work",
          tokens: { input: 9_000, output: 1_000, cache_read: 2_000, cache_write: 0 },
        },
      });
      const [day] = await admin`select * from chalito.coding_spend_daily where owner = ${owner}`;
      expect(day).toMatchObject({ agent: "codex", requests: 1 });
      expect(day!.day.toISOString().slice(0, 10)).toBe("2026-10-21");
      expect(Number(day!.billable_tokens)).toBe(Math.ceil((usageCost * 2.6) / 4));
      expect(Number((await cred(id)).inflight_micros)).toBe(0);
      expect(Number((await cred(id)).spent_micros)).toBe(usageCost);

      expect((await drain()).sent).toBe(1);
      expect(hub.used(owner)).toBe(Math.ceil((usageCost * 2.6) / 4));
      // Finishing the same request again changes nothing (one event, one day's spend).
      await meter.finish(b.ticket, usage, { outputBytes: 0 });
      expect(await outbox(owner)).toHaveLength(1);
    });

    it("a retried finish (another gateway instance) adds nothing: one event, one day's spend, the other request still held", async () => {
      const { owner, id, meter } = await setup();
      const a = await meter.begin(id, req);
      const b = await meter.begin(id, req);
      if (!a.ok || !b.ok) throw new Error("refused");
      await meter.finish(a.ticket, usage, { outputBytes: 0 });
      const other = new CodingMeter({
        store: new PostgresCodingStore(gw),
        hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "t", fetch: hub.fetch }),
        prices,
        cfg,
        reserveBasis: "pre_margin",
        now,
      });
      await other.finish(a.ticket, usage, { outputBytes: 0 });
      await meter.finish(a.ticket, usage, { outputBytes: 0 });
      expect(await outbox(owner)).toHaveLength(1);
      const [day] =
        await admin`select requests, billable_tokens from chalito.coding_spend_daily where owner = ${owner}`;
      expect(day).toMatchObject({ requests: 1 });
      expect(Number(day!.billable_tokens)).toBe(Math.ceil((usageCost * 2.6) / 4));
      expect(Number((await cred(id)).inflight_micros)).toBe(worst);
    });

    it("a refused upstream call finished twice releases its hold once (another request stays held)", async () => {
      const { id, meter } = await setup();
      const a = await meter.begin(id, req);
      const b = await meter.begin(id, req);
      if (!a.ok || !b.ok) throw new Error("refused");
      await meter.finish(a.ticket, { input: 0, output: 0 }, { outputBytes: 0 });
      await meter.finish(a.ticket, { input: 0, output: 0 }, { outputBytes: 0 });
      expect(await cred(id)).toMatchObject({ inflight_requests: 1 });
      expect(Number((await cred(id)).inflight_micros)).toBe(worst);
    });

    it("a zero-usage finish retried by another instance (lost commit ack) releases the hold once", async () => {
      const { id, meter } = await setup();
      const a = await meter.begin(id, req);
      const b = await meter.begin(id, req);
      if (!a.ok || !b.ok) throw new Error("refused");
      await meter.finish(a.ticket, { input: 0, output: 0 }, { outputBytes: 0 });
      const other = new CodingMeter({
        store: new PostgresCodingStore(gw),
        hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "t", fetch: hub.fetch }),
        prices,
        cfg,
        reserveBasis: "pre_margin",
        now,
      });
      await other.finish(a.ticket, { input: 0, output: 0 }, { outputBytes: 0 });
      expect(await cred(id)).toMatchObject({ inflight_requests: 1 });
      expect(Number((await cred(id)).inflight_micros)).toBe(worst);
    });

    it("a token unused for credentialIdleSeconds is refused; each request renews it", async () => {
      const { id } = await setup();
      const strict = new CodingMeter({
        store: new PostgresCodingStore(gw),
        hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "t", fetch: hub.fetch }),
        prices,
        cfg: real,
        reserveBasis: "pre_margin",
        now,
      });
      expect((await strict.begin(id, req)).ok).toBe(true);
      clock += (real.credentialIdleSeconds - 10) * 1000;
      expect((await strict.begin(id, req)).ok).toBe(true);
      clock += (real.credentialIdleSeconds + 1) * 1000;
      expect(await strict.begin(id, req)).toEqual({ ok: false, reason: "expired" });
      clock = Date.UTC(2026, 9, 21, 18);
    });

    it("every top-up counts all of this hold's usage, sent or not, so the hub keeps in flight + worst case held", async () => {
      const { id, meter, drain } = await setup();
      const a = await meter.begin(id, req);
      if (!a.ok) throw new Error("refused");
      await meter.finish(a.ticket, usage, { outputBytes: 0 });
      await drain();
      const b = await meter.begin(id, req);
      if (!b.ok) throw new Error("refused");
      expect(admits(id).at(-1)).toMatchObject({
        external_job_id: `coding:${id}:0`,
        est_tokens: Math.ceil((usageCost + worst) / 4),
      });
      // The hub subtracts the reported usage from the hold: what's left still covers this request's worst case.
      expect(hub.held(holds(id)[0]!)).toBeGreaterThanOrEqual(Math.ceil((worst * 2.6) / 4) - 2);
      expect(holds(id)).toHaveLength(1);
    });

    it("concurrent requests on one session each get a ticket and the final hold covers both", async () => {
      const { id, meter } = await setup();
      const [x, y] = await Promise.all([meter.begin(id, req), meter.begin(id, req)]);
      expect(x.ok && y.ok).toBe(true);
      if (!x.ok || !y.ok) return;
      expect(new Set([x.ticket.seq, y.ticket.seq])).toEqual(new Set([1, 2]));
      expect(holds(id)[0]!.est).toBe(Math.ceil(Math.ceil((2 * worst) / 4) * 2.6));
    });

    it("out of tokens mid-session: the request in flight finishes and is billed; the next is refused, then passes after a recharge", async () => {
      const allocation = Math.ceil(Math.ceil(worst / 4) * 2.6) + 100;
      const { owner, id, meter, drain } = await setup({ allocation });
      const a = await meter.begin(id, req);
      if (!a.ok) throw new Error("first request refused");
      await meter.finish(a.ticket, usage, { outputBytes: 0 });
      await drain();
      expect(await meter.begin(id, req)).toEqual({ ok: false, reason: "out_of_energy" });
      expect((await cred(id)).blocked_reason).toBe("out_of_energy");
      expect(Number((await cred(id)).inflight_micros)).toBe(0);
      expect(hub.used(owner)).toBe(Math.ceil((usageCost * 2.6) / 4));
      hub.users.get(owner)!.allocation += 1_000_000;
      expect((await meter.begin(id, req)).ok).toBe(true);
      expect((await cred(id)).blocked_reason).toBeNull();
    });

    it("the daily cap: refused once today's spend reaches it, in the owner's local day; tomorrow passes", async () => {
      const { owner, id, meter } = await setup();
      const one = Math.ceil((worst * 2.6) / 4);
      // Room for a request's worst case after one real request, not after two.
      await admin`insert into chalito.coding_settings (owner, daily_cap_tokens) values (${owner}, ${one + 2_500})`;
      const a = await meter.begin(id, req);
      if (!a.ok) throw new Error("refused");
      await meter.finish(a.ticket, usage, { outputBytes: 0 }); // 1_976 billable
      const b = await meter.begin(id, req);
      if (!b.ok) throw new Error("refused under the cap");
      await meter.finish(b.ticket, usage, { outputBytes: 0 });
      expect(await meter.begin(id, req)).toEqual({ ok: false, reason: "daily_cap" });
      expect((await cred(id)).blocked_reason).toBe("daily_cap");
      // 23:59 in Mexico City is still the same day; 00:01 is the next.
      clock = Date.UTC(2026, 9, 22, 5, 59);
      expect(await meter.begin(id, req)).toEqual({ ok: false, reason: "daily_cap" });
      clock = Date.UTC(2026, 9, 22, 6, 1);
      expect((await meter.begin(id, req)).ok).toBe(true);
      clock = Date.UTC(2026, 9, 21, 18);
    });

    it("concurrent requests can't overshoot the cap: in-flight worst cases count against it, across sessions", async () => {
      const { owner, id, meter } = await setup();
      const second = `cc_${randomBytes(16).toString("hex")}`;
      await admin`insert into chalito_private.coding_credentials (id, token_hash, owner, device_id, sid, agent, provider, models, expires_at, created_at)
        select ${second}, ${createHash("sha256").update(second).digest("hex")}, owner, device_id, 'sid2', agent, provider, models, expires_at, created_at
        from chalito_private.coding_credentials where id = ${id}`;
      // Room for one worst case at the hub's margin, not two.
      const one = Math.ceil((worst * 2.6) / 4);
      await admin`insert into chalito.coding_settings (owner, daily_cap_tokens) values (${owner}, ${one + 10})`;
      const results = await Promise.all([meter.begin(id, req), meter.begin(second, req), meter.begin(id, req)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok).map((r) => (r.ok ? null : r.reason))).toEqual(["daily_cap", "daily_cap"]);
    });

    it("a session that ends while its request is still streaming keeps that request against the cap", async () => {
      const { owner, id, meter, drain } = await setup();
      const second = `cc_${randomBytes(16).toString("hex")}`;
      await admin`insert into chalito_private.coding_credentials (id, token_hash, owner, device_id, sid, agent, provider, models, expires_at, created_at)
        select ${second}, ${createHash("sha256").update(second).digest("hex")}, owner, device_id, 'sid2', agent, provider, models, expires_at, created_at
        from chalito_private.coding_credentials where id = ${id}`;
      const one = Math.ceil((worst * 2.6) / 4);
      await admin`insert into chalito.coding_settings (owner, daily_cap_tokens) values (${owner}, ${one + 2_500})`;
      const a = await meter.begin(id, req);
      if (!a.ok) throw new Error("refused");
      await admin`update chalito_private.coding_credentials set revoked_at = now(), revoked_reason = 'session_end' where id = ${id}`;
      // The hold stays while the request streams; the cap still counts it.
      expect(await meter.settle(id)).toBe("open");
      expect(await meter.begin(second, req)).toEqual({ ok: false, reason: "daily_cap" });
      await meter.finish(a.ticket, usage, { outputBytes: 0 });
      expect((await meter.begin(second, req)).ok).toBe(true);
      // Once the hub has the usage, the hold closes.
      expect(await meter.settle(id)).toBe("open");
      await drain();
      expect(hub.used(owner)).toBe(Math.ceil((usageCost * 2.6) / 4));
      expect(await meter.settle(id)).toBe("settled");
    });

    it("past the cutoff a hold closes even with a request that never finished; a hold the hub forgot (404) counts as closed", async () => {
      const { id, meter } = await setup();
      const a = await meter.begin(id, req);
      if (!a.ok) throw new Error("refused");
      await admin`update chalito_private.coding_credentials set revoked_at = ${new Date(clock)}, revoked_reason = 'session_end' where id = ${id}`;
      expect(await meter.settle(id)).toBe("open");
      clock += SETTLE_CUTOFF_MS + 1;
      expect(await meter.settle(id)).toBe("settled");
      expect(await cred(id)).toMatchObject({ inflight_requests: 0 });
      // The request that never finished is billed at its worst case, once.
      const orphan = await admin<
        { source_id: string; event: { cost_usd_micros: number; metadata: Record<string, unknown> } }[]
      >`
        select source_id, event from chalito_private.usage_outbox where source_id = ${`coding:${id}:orphan:0`}`;
      expect(orphan).toHaveLength(1);
      expect(orphan[0]!.event).toMatchObject({ cost_usd_micros: worst, metadata: { estimated: true, orphan: true } });
      expect(Number((await cred(id)).inflight_micros)).toBe(0);
      clock = Date.UTC(2026, 9, 21, 18);

      const other = await setup();
      const b = await other.meter.begin(other.id, req);
      if (!b.ok) throw new Error("refused");
      await other.meter.finish(b.ticket, usage, { outputBytes: 0 });
      await other.drain();
      await admin`update chalito_private.coding_credentials set revoked_at = now(), revoked_reason = 'session_end',
        reservation_id = ${randomUUID()} where id = ${other.id}`;
      expect(await other.meter.settle(other.id)).toBe("settled");
    });

    it("a session has at most maxInflightPerSession requests in flight", async () => {
      const { id, meter } = await setup();
      const n = cfg.maxInflightPerSession;
      const tickets = [];
      for (let i = 0; i < n; i++) {
        const r = await meter.begin(id, req);
        if (!r.ok) throw new Error(`refused at ${i}`);
        tickets.push(r.ticket);
      }
      expect(await meter.begin(id, req)).toEqual({ ok: false, reason: "busy" });
      await meter.finish(tickets[0]!, usage, { outputBytes: 0 });
      expect((await meter.begin(id, req)).ok).toBe(true);
    });

    it("switching time zone mid-day doesn't reset the cap: the frozen zone holds until its day ends", async () => {
      const { owner, id, meter } = await setup();
      const cap = Math.ceil((worst * 2.6) / 4) + 2_500;
      await admin`insert into chalito.coding_settings (owner, daily_cap_tokens, cap_tz) values (${owner}, ${cap}, 'America/Mexico_City')`;
      const a = await meter.begin(id, req);
      if (!a.ok) throw new Error("refused");
      await meter.finish(a.ticket, usage, { outputBytes: 0 });
      await admin`insert into chalito.coding_spend_daily (owner, day, agent, billable_tokens) values (${owner}, '2026-10-21', 'grok-build', 5000)`;
      // 23:00 in Mexico City is already tomorrow in Tokyo.
      clock = Date.UTC(2026, 9, 22, 5);
      await admin`update chalito.users set tz = 'Asia/Tokyo' where id = ${owner}`;
      expect(await meter.begin(id, req)).toEqual({ ok: false, reason: "daily_cap" });
      // The api schedules the new zone for when Mexico City's day ends.
      await admin`update chalito.coding_settings set cap_tz_next = 'Asia/Tokyo', cap_tz_from = '2026-10-22T06:00:00Z' where owner = ${owner}`;
      expect(await meter.begin(id, req)).toEqual({ ok: false, reason: "daily_cap" });
      clock = Date.UTC(2026, 9, 22, 6, 1);
      expect((await meter.begin(id, req)).ok).toBe(true);
      clock = Date.UTC(2026, 9, 21, 18);
    });

    it("a cap above the tier's ceiling is clamped to it; a tier off the paid list is refused", async () => {
      const { owner, id, meter } = await setup({ tier: "Pro" });
      await admin`insert into chalito.coding_spend_daily (owner, day, agent, billable_tokens) values (${owner}, '2026-10-21', 'gemini-cli', ${cfg.dailyCap.ceiling.pro!})`;
      await admin`insert into chalito.coding_settings (owner, daily_cap_tokens) values (${owner}, ${cfg.dailyCap.ceiling.vip!})`;
      expect(await meter.begin(id, req)).toEqual({ ok: false, reason: "daily_cap" });
      await admin`update chalito.users set tier = 'free' where id = ${owner}`;
      expect(await meter.begin(id, req)).toEqual({ ok: false, reason: "not_eligible" });
    });

    it("refuses a model outside the allowlist, a revoked credential and a revoked device, before the hub", async () => {
      const { owner, id, meter } = await setup();
      expect(await meter.begin(id, { ...req, model: "gpt-6-luna" })).toEqual({
        ok: false,
        reason: "model_not_allowed",
      });
      await admin`update chalito.devices set revoked = true where owner = ${owner}`;
      expect(await meter.begin(id, req)).toEqual({ ok: false, reason: "device_revoked" });
      expect((await cred(id)).revoked_reason).toBe("device_revoked");
      expect(await meter.begin(id, req)).toEqual({ ok: false, reason: "revoked" });
      expect(admits(id)).toHaveLength(0);
    });

    it("a lapsed hold is replaced under the next job id", async () => {
      const { id, meter } = await setup();
      const a = await meter.begin(id, req);
      if (!a.ok) throw new Error("refused");
      await meter.finish(a.ticket, usage, { outputBytes: 0 });
      clock += (cfg.holdTtlSeconds + 1) * 1000;
      const b = await meter.begin(id, req);
      expect(b.ok).toBe(true);
      expect(holds(id).map((r) => [r.jobId, r.status])).toEqual([
        [`coding:${id}:0`, "expired"],
        [`coding:${id}:1`, "open"],
      ]);
      expect((await cred(id)).hold_gen).toBe(1);
      clock = Date.UTC(2026, 9, 21, 18);
    });

    it("hub down: refused as hub_unavailable, nothing held or counted", async () => {
      const { id, meter } = await setup();
      hub.down = true;
      expect(await meter.begin(id, req)).toEqual({ ok: false, reason: "hub_unavailable" });
      hub.down = false;
      expect(Number((await cred(id)).inflight_micros)).toBe(0);
      expect((await cred(id)).requests).toBe(0);
    });

    it("no usage from the provider: billed at the worst-case input and the streamed bytes, marked estimated", async () => {
      const { owner, id, meter } = await setup();
      const a = await meter.begin(id, req);
      if (!a.ok) throw new Error("refused");
      const { costMicros } = await meter.finish(a.ticket, null, { outputBytes: 500 });
      // Hidden reasoning isn't streamed: the output is billed at its clamped limit, not the bytes seen.
      expect(costMicros).toBe(worst);
      const [row] = await outbox(owner);
      expect(row!.event.metadata).toMatchObject({ estimated: true, tokens: { input: 40_000, output: 32_000 } });
    });

    it("settle: a revoked credential's hold closes at the hub; the sweep closes expired ones too", async () => {
      const { id, meter, drain } = await setup();
      const a = await meter.begin(id, req);
      if (!a.ok) throw new Error("refused");
      await meter.finish(a.ticket, usage, { outputBytes: 0 });
      expect(await meter.settle(id)).toBe("open"); // still live
      await drain();
      clock += 2 * 86_400_000 + 1;
      expect(await meter.sweep()).toBeGreaterThanOrEqual(1);
      expect(holds(id)[0]!.status).toBe("succeeded");
      expect(await cred(id)).toMatchObject({ revoked_reason: "expired" });
      expect((await cred(id)).settled_at).not.toBeNull();
      expect(await meter.settle(id)).toBe("none");
      clock = Date.UTC(2026, 9, 21, 18);
    });
  });
}
