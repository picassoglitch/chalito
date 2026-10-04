import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { NotifierMessage } from "../src/app.js";
import { PostgresNotifyOutbox } from "../src/notify-outbox.js";

/** The notify-outbox triggers (migration 20261004003050) and PostgresNotifyOutbox, as CHALITO_DB_ROLE. */
const url = process.env.DATABASE_URL;
const role = process.env.CHALITO_DB_ROLE;

if (!url) {
  describe("notify outbox (pg)", () => it.skip("needs DATABASE_URL", () => {}));
} else {
  const admin = postgres(url, { onnotice: () => {} });
  const sql = postgres(url, { max: 6, onnotice: () => {}, ...(role ? { connection: { role } } : {}) });
  afterAll(async () => {
    await sql.end();
    await admin.end();
  });
  const box = new PostgresNotifyOutbox(sql);

  const user = async (prefix = "nb") => {
    const u = `${prefix}-${randomUUID()}`;
    const dev = `dv_${randomUUID().slice(0, 8)}`;
    await admin`insert into chalito.tenants (id) values (${u})`;
    await admin`insert into chalito.users (id, tenant_id) values (${u}, ${u})`;
    await admin`insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
                values (${u}, ${dev}, 'agent', 'desktop', 'linux', 'Desk', 'p', 'p', 'f', 'pairing', ${randomUUID()})`;
    return { u, dev };
  };
  const rows = (owner: string) =>
    admin<{ id: string; source_key: string; message: unknown; status: string }[]>`
      select id, source_key, message, status from chalito_private.notify_outbox where owner = ${owner} order by id`;
  const approval = (u: string, dev: string, aid: string, risk = "HIGH") =>
    admin`insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required, details_ct, expires_at)
          values (${u}, ${aid}, ${dev}, 's1', ${`rq_${aid}`}, 'tool', ${risk}, 'local', ${risk === "HIGH" || risk === "CRITICAL"}, '{}', now() + interval '5 minutes')`;

  describe("notify outbox triggers", () => {
    it("a pending approval queues a notify the notifier accepts; resolving it queues an ack, expiring it approval_expired", async () => {
      const { u, dev } = await user();
      await approval(u, dev, "apr_a", "HIGH");
      await approval(u, dev, "apr_b", "CRITICAL");
      await admin`update chalito.approvals set status = 'approved', resolved_at = now() where owner = ${u} and aid = 'apr_a'`;
      await admin`update chalito.approvals set status = 'expired' where owner = ${u} and aid = 'apr_b'`;
      const r = await rows(u);
      const msgs = r.map((x) => NotifierMessage.parse(x.message));
      expect(msgs.map((m) => m.type)).toEqual(["notify", "notify", "ack", "approval_expired"]);
      expect(msgs[0]).toMatchObject({
        uid: u,
        item: { nid: "apr_a", source: "approval", level: "L3", urgency: "high", deepLink: "/a/apr_a" },
      });
      expect(msgs[1]).toMatchObject({ item: { level: "L4", urgency: "critical" } });
      expect(r.map((x) => x.source_key)).toEqual([
        `approval:${u}:apr_a`,
        `approval:${u}:apr_b`,
        `approval_end:${u}:apr_a`,
        `approval_end:${u}:apr_b`,
      ]);
    });

    it("an agent question queues a session_question; other session events don't", async () => {
      const { u, dev } = await user();
      for (const [eid, type] of [
        ["e1", "question.asked"],
        ["e2", "tool.started"],
      ] as const)
        await admin`insert into chalito.session_events (owner, sid, eid, device_id, seq, t, type, doc)
                    values (${u}, 's9', ${eid}, ${dev}, 1, now(), ${type}, '{}')`;
      const r = await rows(u);
      expect(r).toHaveLength(1);
      expect(NotifierMessage.parse(r[0]!.message)).toMatchObject({
        item: { source: "session_question", level: "L3", deepLink: "/s/s9", nid: "q_s9_e1" },
      });
    });

    it("a room message nudges each other member once; presence doesn't", async () => {
      const mom = await user("nb-mom");
      const kid = await user("nb-kid");
      const ma = "chl_" + "m".repeat(26);
      const ka = "chl_" + "k".repeat(26);
      await admin`insert into chalito.companions (owner, companion_id, name) values (${mom.u}, ${ma}, 'Mamá'), (${kid.u}, ${ka}, 'Hijo')`;
      const room = `rm_${randomUUID().slice(0, 8)}`;
      await admin`insert into chalito.rooms (room_id, type, name, owner_uid, owner_companion_id) values (${room}, 'family', 'Casa', ${mom.u}, ${ma})`;
      await admin`insert into chalito.room_members (room_id, companion_id, uid, role) values (${room}, ${ma}, ${mom.u}, 'owner'), (${room}, ${ka}, ${kid.u}, 'member')`;
      for (const [eid, kind] of [
        ["ev1", "notice"],
        ["ev2", "presence"],
      ] as const)
        await admin`insert into chalito.room_events (room_id, eid, from_companion_id, kind, ct, key_epoch)
                    values (${room}, ${eid}, ${ma}, ${kind}, ${admin.json({ alg: "xchacha20poly1305", epoch: 1 })}, 1)`;
      expect(await rows(mom.u)).toHaveLength(0);
      const k = await rows(kid.u);
      expect(k).toHaveLength(1);
      expect(NotifierMessage.parse(k[0]!.message)).toMatchObject({
        uid: kid.u,
        item: { source: "room_event", deepLink: `/r/${room}`, coalesceKey: `room:${room}` },
      });
    });

    it("notifications written outside the notifier queue a notify; the notifier's own writes don't", async () => {
      const { u } = await user();
      const n = (nid: string) => admin`
        insert into chalito.notifications (owner, nid, level, source, urgency, counts, deep_link, coalesce_key)
        values (${u}, ${nid}, 'L3', 'security', 'critical', ${admin.json({ approvals: 0, questions: 0, messages: 0, mesas: 0 })}, '/', 'security:recovery')`;
      await n("recovery_1");
      await admin.begin(async (tx) => {
        await tx`select set_config('chalito.origin', 'notifier', true)`;
        await tx`insert into chalito.notifications (owner, nid, level, source, urgency, counts, deep_link, coalesce_key)
                 values (${u}, 'own_1', 'L1', 'budget', 'normal', ${tx.json({ approvals: 0, questions: 0, messages: 0, mesas: 0 })}, '/', 'cap:voice')`;
      });
      const r = await rows(u);
      expect(r.map((x) => x.source_key)).toEqual([`notification:${u}:recovery_1`]);
      expect(NotifierMessage.parse(r[0]!.message)).toMatchObject({ item: { source: "security", level: "L3" } });
    });

    it("queueing is idempotent on the source key", async () => {
      const { u } = await user();
      await admin`select chalito_private.notify_enqueue(${u}, ${`x:${u}`}, '{"v":1}')`;
      await admin`select chalito_private.notify_enqueue(${u}, ${`x:${u}`}, '{"v":1}')`;
      expect(await rows(u)).toHaveLength(1);
    });
  });

  describe("PostgresNotifyOutbox", () => {
    it("a poke and the drain racing for one row: exactly one gets it; then it's gone", async () => {
      const { u, dev } = await user();
      await approval(u, dev, "apr_race");
      const [row] = await rows(u);
      const id = Number(row!.id);
      const now = Date.now();
      const [pk, dr] = await Promise.all([
        box.claim({ id, limit: 1, now, leaseMs: 60_000 }),
        box.claim({ limit: 100, now, leaseMs: 60_000 }),
      ]);
      const got = [...pk, ...dr].filter((r) => r.id === id);
      expect(got).toHaveLength(1);
      await box.finish(id, now);
      expect((await box.claim({ id, limit: 1, now: now + 120_000, leaseMs: 60_000 })).length).toBe(0);
      expect((await rows(u))[0]!.status).toBe("sent");
    });

    it("a lease that runs out (a crashed instance) is claimed again; a failure backs off; dead stays dead", async () => {
      const { u, dev } = await user();
      await approval(u, dev, "apr_lease");
      const id = Number((await rows(u))[0]!.id);
      const now = Date.now();
      expect(await box.claim({ id, limit: 1, now, leaseMs: 1_000 })).toHaveLength(1);
      expect(await box.claim({ id, limit: 1, now: now + 500, leaseMs: 1_000 })).toHaveLength(0);
      expect(await box.claim({ id, limit: 1, now: now + 2_000, leaseMs: 1_000 })).toHaveLength(1);
      await box.fail(id, "boom", now + 60_000);
      expect(await box.claim({ id, limit: 1, now: now + 30_000, leaseMs: 1_000 })).toHaveLength(0);
      const again = await box.claim({ id, limit: 1, now: now + 61_000, leaseMs: 1_000 });
      expect(again[0]!.attempts).toBe(1);
      await box.fail(id, "boom", null);
      expect(await box.claim({ id, limit: 1, now: now + 10 * 3_600_000, leaseMs: 1_000 })).toHaveLength(0);
      expect((await rows(u))[0]!.status).toBe("dead");
    });
  });
}
