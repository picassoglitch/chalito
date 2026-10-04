import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { twilioSignature } from "../src/signatures.js";
import { BASE, MIN, NOON_MX, hubState, mockServer, prefs, pushSubscription, setup } from "./harness.js";

const { server, cap } = mockServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  for (const list of Object.values(cap)) list.length = 0;
  hubState.admit = "allowed";
  hubState.remaining = 10_000;
});

const item = (nid: string) => ({
  nid,
  source: "session_question",
  urgency: "high",
  level: "L4",
  counts: { approvals: 0, questions: 1, messages: 0, mesas: 0 },
  coalesceKey: `session:${nid}`,
  deepLink: "/s/s1",
  createdAt: NOON_MX,
});

/** A user on a hub tier, with caps and billing on; `prior` sends already made this month. */
const user = (
  uid: string,
  tier: string | null,
  prior: { channel: "whatsapp" | "sms" | "call"; n: number; at?: number }[] = [],
) => {
  const h = setup({ billing: true, caps: true });
  h.store.prefs.set(uid, prefs());
  if (tier) h.store.tiers.set(uid, tier);
  h.store.subs.set(uid, [pushSubscription("https://push.example.test/a")]);
  h.store.sent.set(
    uid,
    prior.flatMap((p) =>
      Array.from({ length: p.n }, (_, i) => ({
        nid: `old${p.channel}${i}`,
        channel: p.channel,
        at: p.at ?? NOON_MX - 3 * 24 * 60 * MIN,
      })),
    ),
  );
  return h;
};

const drive = async (h: ReturnType<typeof user>, uid: string) => {
  for (let i = 0; i < 20; i++) {
    const l = (h.store.ladders.get(uid) ?? []).find((x) => x.state === "pending" && x.nextAt !== null);
    if (!l) return;
    h.setClock(l.nextAt!);
    await h.tick(uid, l.item.nid);
  }
};

const reasons = (h: ReturnType<typeof user>) =>
  h.logs.filter((l) => l.msg === "notifier.suppressed").map((l) => `${l.meta?.channel}:${l.meta?.reason}`);

describe("monthly plan caps (per calendar month, user tz)", () => {
  it("a Pro user (Standard access: 30 calls) at the call cap: the call is suppressed, WhatsApp and push still go", async () => {
    const h = user("u-pro", "pro", [{ channel: "call", n: 30 }]);
    await h.publish({ v: 1, type: "notify", uid: "u-pro", item: item("n1") });
    await drive(h, "u-pro");
    expect(cap.calls).toHaveLength(0);
    expect(cap.whatsapp).toHaveLength(1);
    expect(cap.push.length).toBeGreaterThan(0);
    expect(reasons(h)).toContain("call:cap_reached");
    // Over the cap means no hub admit for that channel at all.
    expect(cap.hub.filter((c) => c.path === "admit").map((c) => c.body.operation)).not.toContain("call.briefing");
    // Suppressed sends don't count (Standard access includes no SMS either); one note per channel this month.
    expect(h.store.suppressedSends.map((s) => [s.channel, s.reason])).toEqual([
      ["call", "cap_reached"],
      ["sms", "cap_reached"],
    ]);
    expect(h.store.notifications.get("u-pro/cap_call_2026_10")).toMatchObject({
      source: "budget",
      deepLink: "/creditos",
      level: "L1",
    });
  });

  it("the note is once per month", async () => {
    const h = user("u-pro", "pro", [{ channel: "call", n: 30 }]);
    await h.publish({ v: 1, type: "notify", uid: "u-pro", item: item("n1") });
    await drive(h, "u-pro");
    await h.publish({ v: 1, type: "notify", uid: "u-pro", item: { ...item("n2"), createdAt: h.deps.now() } });
    await drive(h, "u-pro");
    expect(reasons(h).filter((r) => r === "call:cap_reached")).toHaveLength(2);
    // Two capped ladders, still one note per channel.
    expect([...h.store.notifications.keys()].filter((k) => k.startsWith("u-pro/cap_"))).toEqual([
      "u-pro/cap_call_2026_10",
      "u-pro/cap_sms_2026_10",
    ]);
  });

  it("last month's sends don't count", async () => {
    const h = user("u-pro", "pro", [{ channel: "call", n: 30, at: Date.UTC(2026, 9, 1, 5, 0) }]); // Sep 30, 23:00 in Mexico City
    await h.publish({ v: 1, type: "notify", uid: "u-pro", item: item("n1") });
    await drive(h, "u-pro");
    expect(cap.calls).toHaveLength(1);
  });

  it("Chalyb Gratis (no Chalito access) gets no paid channels, and the hub is never asked", async () => {
    const h = user("u-free", "free");
    await h.publish({ v: 1, type: "notify", uid: "u-free", item: item("n1") });
    await drive(h, "u-free");
    expect(cap.whatsapp.length + cap.calls.length + cap.sms.length).toBe(0);
    expect(cap.push.length).toBeGreaterThan(0);
    expect(cap.hub).toHaveLength(0);
    expect(reasons(h)).toEqual(["whatsapp:cap_reached", "call:cap_reached", "sms:cap_reached"]);
  });

  it("comped owners use the top tier's limits; VIP gets SMS", async () => {
    const owner = user("owner-1", null);
    await owner.publish({ v: 1, type: "notify", uid: "owner-1", item: item("n1") });
    await drive(owner, "owner-1");
    expect([cap.whatsapp.length, cap.calls.length, cap.sms.length]).toEqual([1, 1, 1]);
  });

  it("voice minutes used up: DTMF 1 tells the user to open the app instead of connecting, once-a-month note", async () => {
    const h = user("u-pro", "pro");
    h.store.voiceSeconds.set("u-pro", 120 * 60); // Standard access: 120 voice minutes
    const path = "/webhooks/twilio/gather?uid=u-pro&nid=n1&lang=es";
    const params = { CallSid: `CA${"a".repeat(32)}`, Digits: "1" };
    const res = await h.app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilioSignature("twilio-auth-token-test", `${BASE}${path}`, params),
      },
      body: new URLSearchParams(params).toString(),
    });
    const twiml = await res.text();
    expect(twiml).toContain("Abre tu app para responder");
    expect(twiml).not.toContain("<Sip>");
    expect(h.store.notifications.get("u-pro/cap_voice_2026_10")).toMatchObject({ source: "budget" });
  });
});
