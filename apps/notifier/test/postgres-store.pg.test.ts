import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { Ladder } from "@chalito/escalation";
import { PostgresStore } from "../src/postgres-store.js";

/** A complete HubUsageEvent, as the outbox CHECK requires (source_id must match the row). */
const fixtureEvent = (sourceId: string, owner: string, kind: string, amount: number) => ({
  source_id: sourceId,
  kind,
  provider: "test",
  external_user_id: owner,
  amount,
  cost_usd_micros: 1,
  occurred_at: new Date().toISOString(),
});

/**
 * PostgresStore against a Chalito database with the notifier migrations (DATABASE_URL), acting as
 * CHALITO_DB_ROLE like the service does. A role-less connection seeds rows clients would write.
 */
const url = process.env.DATABASE_URL;
const role = process.env.CHALITO_DB_ROLE;

if (!url) {
  describe("PostgresStore", () => it.skip("needs DATABASE_URL", () => {}));
} else {
  const admin = postgres(url, { onnotice: () => {} });
  const sql = postgres(url, { max: 5, onnotice: () => {}, ...(role ? { connection: { role } } : {}) });
  const store = new PostgresStore(sql);
  afterAll(async () => {
    await sql.end();
    await admin.end();
  });

  const user = async (cols: Record<string, unknown> = {}) => {
    const id = `notifier-${randomUUID()}`;
    await admin`insert into chalito.tenants (id) values (${id})`;
    await admin`insert into chalito.users ${admin({ id, tenant_id: id, locale: "es", tz: "America/Mexico_City", ...cols })}`;
    return id;
  };
  const ladder = (nid: string, key: string, state: Ladder["state"] = "pending"): Ladder => ({
    item: {
      nid,
      source: "approval",
      urgency: "high",
      level: "L4",
      counts: { approvals: 1, questions: 0, messages: 0, mesas: 0 },
      coalesceKey: key,
      deepLink: "/a/x",
      createdAt: 1,
    },
    state,
    step: 1,
    openedAt: 1,
    startedAt: 1,
    nextAt: Date.now() + 60_000,
    ackedAt: null,
    ackedVia: null,
  });

  describe("PostgresStore (chalito schema)", () => {
    it.runIf(role)(`runs as ${role}`, async () => {
      expect((await sql`select current_user as u`)[0]?.u).toBe(role);
    });

    it("maps user columns to escalation prefs (quiet hours tri-state, phone, opt-ins)", async () => {
      const now = new Date();
      const verified = await user({
        phone_e164: `+5255${String(Date.now()).slice(-8)}`,
        phone_country: "MX",
        phone_verified_at: now,
        charges_notice_ack_at: now,
        whatsapp_opt_in: true,
        calls_enabled: true,
        quiet_hours: admin.json({ off: true }),
        l4_quiet_override: ["security"],
      });
      const p = await store.withUser(verified, (tx) => tx.prefs());
      expect(p).toMatchObject({
        tz: "America/Mexico_City",
        locale: "es",
        quietHours: null,
        phone: { country: "MX", verified: true, chargesNoticeAckAt: now.getTime() },
        whatsapp: { optIn: true },
        calls: { enabled: true },
        l4QuietOverride: ["security"],
      });
      expect(p).not.toHaveProperty("sms"); // null: country default
      const plain = await user();
      const q = await store.withUser(plain, (tx) => tx.prefs());
      expect(q).not.toHaveProperty("quietHours"); // null: the default window
      expect(q?.phone).toBeNull();
      expect(await store.withUser("nobody-here", (tx) => tx.prefs())).toBeNull();
    });

    it("persists ladders and sends; history returns active ladders and today's whatsapp/call/sms sends", async () => {
      const u = await user();
      await store.withUser(u, async (tx) => {
        await tx.saveLadder(ladder("n1", "k1"));
        await tx.saveLadder({ ...ladder("n1", "k1"), step: 3 });
        await tx.recordSent({ nid: "n1", channel: "call", at: Date.now() }, "k1");
        await tx.recordSent({ nid: "n1", channel: "whatsapp", at: Date.now() - 72 * 3_600_000 }, "k1");
      });
      const h = await store.withUser(u, (tx) => tx.history(Date.now() - 48 * 3_600_000));
      expect(h.ladders).toHaveLength(1);
      expect(h.ladders[0]!.step).toBe(3);
      expect(h.sent.map((s) => s.channel)).toEqual(["call"]);
    });

    it("upserts the notification row: channels merge, the level stays unless raised", async () => {
      const u = await user();
      const row = {
        nid: "n9",
        source: "approval" as const,
        urgency: "high" as const,
        counts: { approvals: 1, questions: 0, messages: 0, mesas: 0 },
        deepLink: "/a/x",
        coalesceKey: "approval:x",
        state: "pending" as const,
        step: 1,
        nextAt: null,
        createdAt: Date.now(),
        ackedAt: null,
        ackedVia: null,
      };
      await store.withUser(u, (tx) => tx.upsertNotification({ ...row, level: "L1", channels: ["desktop", "push"] }));
      await store.withUser(u, (tx) => tx.upsertNotification({ ...row, step: 2, channels: ["whatsapp"] }));
      const [n] =
        await admin`select level, step, channels from chalito.notifications where owner = ${u} and nid = 'n9'`;
      expect(n).toMatchObject({ level: "L1", step: 2 });
      expect([...n!.channels].sort()).toEqual(["desktop", "push", "whatsapp"]);
    });

    it("serialises decisions per user", async () => {
      const u = await user();
      const order: string[] = [];
      await Promise.all([
        store.withUser(u, async () => {
          order.push("a:start");
          await new Promise((r) => setTimeout(r, 200));
          order.push("a:end");
        }),
        new Promise((r) => setTimeout(r, 30)).then(() =>
          store.withUser(u, async () => {
            order.push("b:start");
          }),
        ),
      ]);
      expect(order).toEqual(["a:start", "a:end", "b:start"]);
    });

    it("phone lookup, opt-outs, push subscriptions, call items and relayed commands", async () => {
      const e164 = `+5255${String(Date.now() + 7).slice(-8)}`;
      const now = new Date();
      const u = await user({
        phone_e164: e164,
        phone_country: "MX",
        phone_verified_at: now,
        charges_notice_ack_at: now,
        whatsapp_opt_in: true,
        call_briefing: admin.json({ enabled: true }),
      });
      expect(await store.findUserByPhone(e164)).toBe(u);
      await store.optOut(u, "whatsapp");
      expect((await admin`select whatsapp_opt_in from chalito.users where id = ${u}`)[0]?.whatsapp_opt_in).toBe(false);

      const dev = `dev_${randomUUID().replace(/-/g, "")}`;
      await admin`insert into chalito.devices ${admin({
        owner: u,
        device_id: dev,
        role: "agent",
        kind: "laptop",
        platform: "linux",
        name: "Laptop",
        pub_sign: "ps",
        pub_box: "pb",
        fingerprint: "fp",
        enrolled_via: "pairing",
      })}`;
      await admin`insert into chalito.push_subscriptions ${admin({
        owner: u,
        device_id: dev,
        endpoint: "https://push.example.test/x",
        p256dh: "k",
        auth: "a",
      })}`;
      expect(await store.pushSubscriptions(u)).toEqual([
        { endpoint: "https://push.example.test/x", keys: { p256dh: "k", auth: "a" } },
      ]);
      await store.deletePushSubscription(u, "https://push.example.test/x");
      expect(await store.pushSubscriptions(u)).toEqual([]);
      // A revoked device's subscription is never used, even if its row is still there.
      await admin`insert into chalito.push_subscriptions ${admin({
        owner: u,
        device_id: dev,
        endpoint: "https://push.example.test/y",
        p256dh: "k",
        auth: "a",
      })}`;
      await admin`update chalito.devices set revoked = true where owner = ${u} and device_id = ${dev}`;
      expect(await store.pushSubscriptions(u)).toEqual([]);
      await admin`update chalito.devices set revoked = false where owner = ${u} and device_id = ${dev}`;

      await admin`insert into chalito.sessions ${admin({ owner: u, sid: "s1", device_id: dev, doc: admin.json({ label: "API de pagos" }) })}`;
      await admin`insert into chalito.call_lines ${admin({
        owner: u,
        lid: "l1",
        notification_id: "n1",
        device_id: dev,
        sid: "s1",
        line: "¿Corro las migraciones?",
        expires_at: new Date(Date.now() + 600_000),
      })}`;
      expect(await store.callItems(u)).toEqual({
        callBriefingEnabled: true,
        items: [
          {
            lid: "l1",
            deviceLabel: "Laptop",
            sessionLabel: "API de pagos",
            line: "¿Corro las migraciones?",
            deviceId: dev,
            sid: "s1",
          },
        ],
      });
      await admin`insert into chalito.approvals ${admin({
        owner: u,
        aid: "apr_1",
        device_id: dev,
        sid: "s1",
        request_id: "r1",
        kind: "tool",
        risk: "MED",
        origin: "local",
        step_up_required: false,
        details_ct: admin.json({}),
        expires_at: new Date(Date.now() + 300_000),
      })}`;
      expect(await store.pendingApprovals(u)).toEqual([
        { aid: "apr_1", deviceLabel: "Laptop", sessionLabel: "API de pagos" },
      ]);
      expect(await store.companionName(u)).toBeNull();
      expect(await store.agentPubBox(u, dev)).toBe("pb");
      await store.insertRelayedCommand(u, dev, "c1", { relayedBy: "notifier" } as never, Date.now() + 60_000);
      expect(
        (await admin`select from_device_id from chalito.commands where owner = ${u} and id = 'c1'`)[0]?.from_device_id,
      ).toBe("notifier");
    });

    it("voice call refs are single-use across instances", async () => {
      const hash = randomUUID().replace(/-/g, "").padEnd(64, "0");
      const [a, b] = await Promise.all([
        store.claimCallRef(hash, Date.now() + 60_000),
        store.claimCallRef(hash, Date.now() + 60_000),
      ]);
      expect([a, b].sort()).toEqual([false, true]);
      expect(await new PostgresStore(sql).claimCallRef(hash, Date.now() + 60_000)).toBe(false);
    });

    it("monthly cap queries: plan info, sends excluding suppressed, voice seconds, once-only notes", async () => {
      const u = await user({ tier: "pro" });
      expect(await store.planInfo(u)).toMatchObject({ hubTier: "pro", tz: "America/Mexico_City", locale: "es" });
      const since = Date.now() - 60_000;
      await store.withUser(u, async (tx) => {
        await tx.recordSent({ nid: "n1", channel: "call", at: Date.now() }, "k1");
        await tx.recordSent({ nid: "n2", channel: "call", at: Date.now() }, "k2");
        await tx.recordSent({ nid: "n2", channel: "sms", at: Date.now() }, "k2");
      });
      await store.markSuppressed(u, "n2", "call", "cap_reached");
      expect(await store.monthlySends(u, since)).toEqual({ whatsapp: 0, sms: 1, call: 1 });
      // The engine's daily caps don't count the suppressed send either.
      expect((await store.withUser(u, (tx) => tx.history(since))).sent.map((x) => x.nid).sort()).toEqual(["n1", "n2"]);
      await admin`insert into chalito_private.usage_outbox (owner, source_id, event)
                  values (${u}, ${`v:${u}`}, ${admin.json(fixtureEvent(`v:${u}`, u, "voice.seconds", 90))})`;
      expect(await store.voiceSecondsSince(u, since)).toBe(90);
      const note = {
        nid: "cap_call_2026_10",
        source: "budget" as const,
        urgency: "normal" as const,
        counts: { approvals: 0, questions: 0, messages: 0, mesas: 0 },
        deepLink: "/creditos",
        coalesceKey: "cap:call",
        state: "pending" as const,
        step: 0,
        nextAt: null,
        createdAt: Date.now(),
        level: "L1" as const,
        channels: ["desktop" as const],
        ackedAt: null,
        ackedVia: null,
      };
      await store.noteOnce(u, note);
      await store.noteOnce(u, { ...note, level: "L4" as const });
      expect(
        await admin`select level from chalito.notifications where owner = ${u} and nid = 'cap_call_2026_10'`,
      ).toEqual([{ level: "L1" }]);
    });
  });
}
