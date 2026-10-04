import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { HubUsageEvent } from "@chalito/protocol";
import { PostgresVoiceSessions, sweepVoiceSessions, type VoiceEventFor } from "../src/index.js";

/** chalito_private.voice_sessions (migration 003010) + the usage outbox, as CHALITO_DB_ROLE. */
const url = process.env.DATABASE_URL;
const role = process.env.CHALITO_DB_ROLE;

if (!url) {
  describe("PostgresVoiceSessions", () => it.skip("needs DATABASE_URL", () => {}));
} else {
  const admin = postgres(url, { onnotice: () => {} });
  const sql = postgres(url, { max: 6, onnotice: () => {}, ...(role ? { connection: { role } } : {}) });
  afterAll(async () => {
    await sql.end();
    await admin.end();
  });
  const store = new PostgresVoiceSessions(sql);
  const RID = "55555555-5555-4555-8555-555555555555";
  const T0 = Date.UTC(2026, 9, 5, 12);
  const event: VoiceEventFor = (s, seconds, total): HubUsageEvent => ({
    source_id: `${s.sourceId}:${total}`,
    kind: "voice.seconds",
    provider: "openai",
    external_user_id: s.owner,
    amount: seconds,
    cost_usd_micros: seconds * 500,
    occurred_at: new Date(T0).toISOString(),
    reservation_id: s.reservationId,
  });
  const owner = async () => {
    const u = `vs-${randomUUID()}`;
    await admin`insert into chalito.tenants (id) values (${u})`;
    await admin`insert into chalito.users (id, tenant_id) values (${u}, ${u})`;
    return u;
  };
  const sid = () => `voice_${randomUUID().replace(/-/g, "")}`;
  const open = (u: string, sourceId: string, maxSeconds = 600) =>
    store.open({
      sourceId,
      owner: u,
      channel: "desktop",
      deviceId: "dev_x",
      reservationId: RID,
      model: "m",
      startedAt: T0,
      maxSeconds,
    });
  const billed = async (u: string) =>
    (
      await admin<{ amount: number; source_id: string }[]>`
        select (event ->> 'amount')::int as amount, source_id from chalito_private.usage_outbox where owner = ${u} order by created_at, source_id`
    ).map((r) => r.amount);

  describe("PostgresVoiceSessions", () => {
    it("one open session per owner; heartbeats bill server time once, in the same transaction as the event", async () => {
      const u = await owner();
      const s = sid();
      expect(await open(u, s)).toBe("opened");
      expect(await open(u, sid())).toBe("busy");
      expect((await store.advance({ owner: u, sourceId: s, now: T0 + 30_000, end: false, event })).billed).toBe(30);
      expect((await store.advance({ owner: u, sourceId: s, now: T0 + 30_000, end: false, event })).billed).toBe(0);
      // Another owner can't advance (or learn about) this session.
      expect(
        (await store.advance({ owner: "someone-else", sourceId: s, now: T0 + 90_000, end: true, event })).found,
      ).toBe(false);
      const end = await store.advance({ owner: u, sourceId: s, now: T0 + 45_000, end: true, event });
      expect(end).toMatchObject({ billed: 15, total: 45, ended: true });
      expect(await billed(u)).toEqual([30, 15]);
      expect(await open(u, sid())).toBe("opened");
    });

    it("concurrent heartbeats never bill the same seconds twice", async () => {
      const u = await owner();
      const s = sid();
      await open(u, s);
      await Promise.all(
        Array.from({ length: 8 }, () => store.advance({ owner: u, sourceId: s, now: T0 + 60_000, end: false, event })),
      );
      expect(await billed(u)).toEqual([60]);
    });

    it("the sweep bills a never-ended session in full and closes it", async () => {
      const u = await owner();
      const s = sid();
      await open(u, s, 120);
      await store.advance({ owner: u, sourceId: s, now: T0 + 20_000, end: false, event });
      const settled: string[] = [];
      expect(
        await sweepVoiceSessions({
          store,
          now: T0 + 60_000,
          owner: u,
          event,
          settle: async (r) => void settled.push(r),
        }),
      ).toBe(0);
      expect(
        await sweepVoiceSessions({
          store,
          now: T0 + 120_000 + 121_000,
          owner: u,
          event,
          settle: async (r) => void settled.push(r),
        }),
      ).toBe(1);
      expect(await billed(u)).toEqual([20, 100]);
      expect(settled).toEqual([RID]);
      const [r] = await admin`select closed_by from chalito_private.voice_sessions where source_id = ${s}`;
      expect(r!.closed_by).toBe("sweep");
    });

    it("records the call id of an open session, lists a device's open sessions, and the sweep hangs up", async () => {
      const u = await owner();
      const s = sid();
      await open(u, s, 60);
      expect(await store.setCallId(u, s, "rtc_abc")).toBe(true);
      expect(await store.setCallId("someone-else", s, "rtc_x")).toBe(false);
      const [first] = await store.openFor(u, "dev_x");
      expect(first).toMatchObject({ sourceId: s, callId: "rtc_abc" });
      const hung: string[] = [];
      await sweepVoiceSessions({
        store,
        now: T0 + 60_000 + 121_000,
        owner: u,
        event,
        settle: async () => undefined,
        hangup: async (v) => void hung.push(v.callId!),
      });
      expect(hung).toEqual(["rtc_abc"]);
      expect(await store.openFor(u, "dev_x")).toEqual([]);
      expect(await store.setCallId(u, s, "rtc_late")).toBe(false); // ended: no more call ids
    });
  });
}
