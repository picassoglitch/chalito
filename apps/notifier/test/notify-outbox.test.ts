import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_ATTEMPTS, signPoke } from "../src/notify-outbox.js";
import {
  BASE,
  NOON_MX,
  POKE_SECRET,
  SCHEDULER_SA,
  googleToken,
  mockServer,
  prefs,
  pushSubscription,
  setup,
} from "./harness.js";

const { server, cap } = mockServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  for (const list of Object.values(cap)) list.length = 0;
});

const UID = "hub-user-1";
/** What the approvals trigger queues for a pending HIGH approval (migration 20261004003050). */
const approvalMessage = (aid = "apr_1") => ({
  v: 1,
  type: "notify",
  uid: UID,
  item: {
    nid: aid,
    source: "approval",
    urgency: "high",
    level: "L3",
    counts: { approvals: 1, questions: 0, messages: 0, mesas: 0 },
    coalesceKey: `approval:${aid}`,
    deepLink: `/a/${aid}`,
    createdAt: NOON_MX,
    approvalExpiresAt: NOON_MX + 10 * 60_000,
  },
});

const user = () => {
  const h = setup();
  h.store.prefs.set(UID, prefs());
  h.store.subs.set(UID, [pushSubscription("https://push.example.test/a")]);
  return h;
};
const poke = (h: ReturnType<typeof user>, id: number, o: { ts?: number; secret?: string; sig?: string } = {}) => {
  const ts = o.ts ?? NOON_MX;
  return h.app.request("/internal/notify-poke", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-chalito-poke-signature": o.sig ?? signPoke(o.secret ?? POKE_SECRET, id, ts),
    },
    body: JSON.stringify({ id, ts }),
  });
};
const drain = async (h: ReturnType<typeof user>, auth = true) =>
  h.app.request("/tasks/drain-notify", {
    method: "POST",
    headers: auth
      ? { authorization: `Bearer ${await googleToken({ aud: `${BASE}/tasks/drain-notify`, email: SCHEDULER_SA })}` }
      : {},
  });

describe("notify outbox: pg_net poke", () => {
  it("a signed poke delivers that row through the escalation path at once (push in seconds)", async () => {
    const h = user();
    const id = h.notifyOutbox.add(UID, approvalMessage());
    const res = await poke(h, id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delivered: 1, retried: 0, dead: 0 });
    expect(cap.push).toHaveLength(1);
    expect(h.notifyOutbox.rows[0]!.status).toBe("sent");
    expect(h.store.notifications.get(`${UID}/apr_1`)).toMatchObject({ source: "approval", deepLink: "/a/apr_1" });
  });

  it("a replayed poke is a no-op: nothing is sent twice", async () => {
    const h = user();
    const id = h.notifyOutbox.add(UID, approvalMessage());
    await poke(h, id);
    const again = await poke(h, id);
    expect(await again.json()).toEqual({ delivered: 0, retried: 0, dead: 0 });
    expect(cap.push).toHaveLength(1);
  });

  it("refuses unsigned, wrongly signed and stale pokes, and claims nothing", async () => {
    const h = user();
    const id = h.notifyOutbox.add(UID, approvalMessage());
    expect((await poke(h, id, { sig: "" })).status).toBe(401);
    expect((await poke(h, id, { secret: "not-the-secret" })).status).toBe(401);
    expect((await poke(h, id, { ts: NOON_MX - 10 * 60_000 })).status).toBe(401);
    expect(h.notifyOutbox.rows[0]!.status).toBe("pending");
    expect(cap.push).toHaveLength(0);
  });
});

describe("notify outbox: the scheduled drain", () => {
  it("needs the scheduler's OIDC token", async () => {
    const h = user();
    expect((await drain(h, false)).status).toBe(401);
  });

  it("delivers what no poke did; a poke for an already drained row does nothing (exactly once)", async () => {
    const h = user();
    const a = h.notifyOutbox.add(UID, approvalMessage("apr_1"));
    h.notifyOutbox.add(UID, approvalMessage("apr_2"));
    expect(await (await drain(h)).json()).toEqual({ delivered: 2, retried: 0, dead: 0 });
    expect(await (await poke(h, a)).json()).toEqual({ delivered: 0, retried: 0, dead: 0 });
    expect(await (await drain(h)).json()).toEqual({ delivered: 0, retried: 0, dead: 0 });
    expect(cap.push).toHaveLength(2);
  });

  it("acks from the approvals trigger stop the ladder", async () => {
    const h = user();
    h.notifyOutbox.add(UID, approvalMessage("apr_1"));
    h.notifyOutbox.add(UID, { v: 1, type: "ack", uid: UID, via: "app", nid: "apr_1" });
    await drain(h);
    expect(h.store.notifications.get(`${UID}/apr_1`)).toMatchObject({ state: "acked" });
  });

  it("an invalid message, or one for another user, is dead-lettered and alerted, never sent", async () => {
    const h = user();
    h.notifyOutbox.add(UID, { v: 1, type: "notify", uid: UID, item: { nid: "x" } });
    h.notifyOutbox.add(UID, { ...approvalMessage(), uid: "someone-else" });
    expect(await (await drain(h)).json()).toEqual({ delivered: 0, retried: 0, dead: 2 });
    expect(h.notifyOutbox.rows.every((r) => r.status === "dead")).toBe(true);
    expect(h.logs.filter((l) => l.msg === "notifier.outbox_dead")).toHaveLength(2);
    expect(cap.push).toHaveLength(0);
  });

  it("a failing delivery retries with backoff, then goes dead and is alerted after the last attempt", async () => {
    const h = user();
    const id = h.notifyOutbox.add(UID, approvalMessage());
    const withUser = h.store.withUser.bind(h.store);
    h.store.withUser = async () => Promise.reject(new Error("db down"));
    let clock = NOON_MX;
    h.setClock(clock);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(await (await drain(h)).json()).toEqual({ delivered: 0, retried: 1, dead: 0 });
      expect(await (await drain(h)).json()).toEqual({ delivered: 0, retried: 0, dead: 0 }); // not due yet
      clock = h.notifyOutbox.rows[0]!.nextAttemptAt;
      h.setClock(clock);
    }
    expect(await (await drain(h)).json()).toEqual({ delivered: 0, retried: 0, dead: 1 });
    expect(h.notifyOutbox.rows.find((r) => r.id === id)).toMatchObject({ status: "dead", attempts: MAX_ATTEMPTS });
    expect(h.logs.at(-1)).toMatchObject({ msg: "notifier.outbox_dead" });
    h.store.withUser = withUser;
  });
});
