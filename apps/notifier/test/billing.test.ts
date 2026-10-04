import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signStandardWebhook } from "@chalito/adapters/voice";
import { smsSegments, twilioDestination } from "../src/billing.js";
import { twilioSignature } from "../src/signatures.js";
import {
  BASE,
  NOON_MX,
  OPENAI_WEBHOOK_SECRET,
  RID,
  SCHEDULER_SA,
  googleToken,
  hubState,
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
  hubState.admit = "allowed";
  hubState.remaining = 10_000;
});

const UID = "hub-user-1";
const item = (over: Record<string, unknown> = {}) => ({
  nid: "n1",
  source: "session_question",
  urgency: "high",
  level: "L4",
  counts: { approvals: 0, questions: 1, messages: 0, mesas: 0 },
  coalesceKey: "session:s1",
  deepLink: "/s/s1",
  createdAt: NOON_MX,
  ...over,
});

const billed = () => {
  const h = setup({ billing: true });
  h.store.prefs.set(UID, prefs());
  h.store.subs.set(UID, [pushSubscription("https://push.example.test/a")]);
  return h;
};

/** Fire scheduled ticks until the ladder ends. */
const drive = async (h: ReturnType<typeof billed>) => {
  for (let i = 0; i < 20; i++) {
    const l = (h.store.ladders.get(UID) ?? []).find((x) => x.state === "pending" && x.nextAt !== null);
    if (!l) return;
    h.setClock(l.nextAt!);
    await h.tick(UID, l.item.nid);
  }
};

const twilioStatus = (h: ReturnType<typeof billed>, url: string, params: Record<string, string>) => {
  const u = new URL(url);
  return h.app.request(`${u.pathname}${u.search}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilioSignature("twilio-auth-token-test", url, params),
    },
    body: new URLSearchParams(params).toString(),
  });
};

describe("paid channels go through the hub", () => {
  it("WhatsApp and SMS are admitted, then reported at prices.yaml cost and settled", async () => {
    const h = billed();
    await h.publish({ v: 1, type: "notify", uid: UID, item: item({ level: "L4" }) });
    await drive(h);
    expect(cap.whatsapp).toHaveLength(1);
    expect(cap.sms).toHaveLength(1);
    const admits = cap.hub.filter((c) => c.path === "admit").map((c) => c.body);
    expect(admits.map((a) => a.operation)).toEqual(["whatsapp.message", "call.briefing", "sms.message"]);
    expect(admits[0]).toMatchObject({ external_user_id: UID, class: "job" });
    expect(admits[1]).toMatchObject({ class: "stream" });
    const events = h.outbox.rows.map((r) => r.event);
    expect(events.map((e) => [e.kind, e.amount, e.cost_usd_micros, e.reservation_id])).toEqual([
      ["whatsapp.messages", 1, 8_500, RID], // MX utility
      ["sms.segments", 2, 363_800, RID], // the Spanish SMS is UCS-2 → 2 segments × MX rate
    ]);
    expect(cap.hub.filter((c) => c.path === "settle").map((c) => c.body.outcome)).toEqual(["succeeded", "succeeded"]);
    // The call is billed when Twilio reports it finished.
    expect(cap.calls[0]!.StatusCallback).toBe(`${BASE}/webhooks/twilio/status?uid=hub-user-1&c=MX&rid=${RID}`);
  });

  it("call minutes are metered from the status callback; a failed call releases its reservation", async () => {
    const h = billed();
    const url = `${BASE}/webhooks/twilio/status?uid=hub-user-1&c=MX&rid=${RID}`;
    expect(
      (await twilioStatus(h, url, { CallSid: `CA${"d".repeat(32)}`, CallStatus: "completed", CallDuration: "61" }))
        .status,
    ).toBe(204);
    expect(h.outbox.rows.map((r) => [r.event.kind, r.event.amount, r.event.cost_usd_micros])).toEqual([
      ["call.seconds", 61, 94_600],
    ]);
    expect(cap.hub.at(-1)).toEqual({ path: "settle", body: { reservation_id: RID, outcome: "succeeded" } });
    await twilioStatus(h, url, { CallSid: `CA${"e".repeat(32)}`, CallStatus: "no-answer" });
    expect(cap.hub.at(-1)).toEqual({ path: "settle", body: { reservation_id: RID, outcome: "failed" } });
    expect(h.outbox.rows).toHaveLength(1);
  });

  it("no tokens or an unreachable hub: paid channels are skipped, push keeps working", async () => {
    for (const state of ["no_tokens", "down"] as const) {
      for (const list of Object.values(cap)) list.length = 0;
      hubState.admit = state;
      const h = billed();
      await h.publish({ v: 1, type: "notify", uid: UID, item: item() });
      await drive(h);
      expect(cap.push.length).toBeGreaterThan(0);
      expect(cap.whatsapp.length + cap.sms.length + cap.calls.length).toBe(0);
      expect(h.outbox.rows).toHaveLength(0);
      const reason = state === "no_tokens" ? "no_tokens" : "hub_unavailable";
      expect(
        h.logs.some(
          (l) => l.msg === "notifier.suppressed" && l.meta?.channel === "whatsapp" && l.meta?.reason === reason,
        ),
      ).toBe(true);
    }
  });

  it("the voice on a call is metered when the call ends", async () => {
    const h = billed();
    const callSid = `CA${"f".repeat(32)}`;
    const path = "/webhooks/twilio/gather?uid=hub-user-1&nid=n1&lang=es";
    const params = { CallSid: callSid, Digits: "1" };
    const gather = await h.app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilioSignature("twilio-auth-token-test", `${BASE}${path}`, params),
      },
      body: new URLSearchParams(params).toString(),
    });
    const ref = /X-Chalito-Ref=([\w-]+\.[\w-]+)/.exec(await gather.text())![1]!;
    const raw = JSON.stringify({
      type: "realtime.call.incoming",
      data: { call_id: "call_v", sip_headers: [{ name: "X-Chalito-Ref", value: ref }] },
    });
    const ts = Math.floor(NOON_MX / 1000);
    await h.app.request("/webhooks/openai", {
      method: "POST",
      headers: {
        "webhook-id": "m1",
        "webhook-timestamp": String(ts),
        "webhook-signature": signStandardWebhook(OPENAI_WEBHOOK_SECRET, "m1", ts, raw),
      },
      body: raw,
    });
    h.setClock(NOON_MX + 90_000); // a 90-second conversation
    h.sockets[0]!.close();
    await new Promise((r) => setTimeout(r, 20));
    // Metered on the server (R-M8): one session row, billed in one go at close, settled.
    const [voice] = h.voiceSessions.events;
    // 90 s × $0.03/min + 2 SIP minutes × $0.004.
    expect([voice!.kind, voice!.amount, voice!.cost_usd_micros, voice!.source_id.split(":")[1]]).toEqual([
      "voice.seconds",
      90,
      45_000 + 8_000,
      "90",
    ]);
    expect([...h.voiceSessions.sessions.values()][0]).toMatchObject({
      channel: "call",
      deviceId: callSid,
      endedAt: NOON_MX + 90_000,
    });
  });
});

describe("outbox drain endpoint", () => {
  it("needs the scheduler's OIDC token, then drains to POST /usage", async () => {
    const h = billed();
    await h.outbox.enqueue(UID, [
      {
        source_id: "wa:x",
        kind: "whatsapp.messages",
        provider: "meta",
        external_user_id: UID,
        amount: 1,
        cost_usd_micros: 8_500,
        occurred_at: new Date(NOON_MX).toISOString(),
      },
    ]);
    const post = async (token?: string) =>
      h.app.request("/tasks/drain-usage", {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    expect((await post()).status).toBe(401);
    expect(
      (
        await post(
          await googleToken({ aud: `${BASE}/tasks/drain-usage`, email: "someone@else.iam.gserviceaccount.com" }),
        )
      ).status,
    ).toBe(401);
    const ok = await post(await googleToken({ aud: `${BASE}/tasks/drain-usage`, email: SCHEDULER_SA }));
    expect(await ok.json()).toEqual({ sent: 1, retried: 0, dead: 0, voiceSessionsSwept: 0 });
    expect(
      (cap.hub.find((c) => c.path === "usage")!.body.events as { source_id: string }[]).map((e) => e.source_id),
    ).toEqual(["wa:x"]);
  });
});

describe("helpers", () => {
  it("SMS segments: GSM-7 vs UCS-2; Twilio destinations", () => {
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("Á".repeat(70))).toBe(1);
    expect(smsSegments("Á".repeat(71))).toBe(2);
    expect([twilioDestination("mx"), twilioDestination("US"), twilioDestination("ES")]).toEqual([
      "MX_mobile",
      "US",
      "other:ES",
    ]);
  });
});

describe("R-L9: comms admits", () => {
  it("re-admitting the same send (a Cloud Tasks retry) uses the same hub job id; an empty balance is no_tokens", async () => {
    const h = billed();
    const a = await h.deps.billing!.admit(UID, "sms", "n1", "MX", "2");
    const b = await h.deps.billing!.admit(UID, "sms", "n1", "MX", "2");
    expect(a).toEqual(b);
    const jobs = cap.hub.filter((x) => x.path === "admit").map((x) => x.body.external_job_id);
    expect(jobs).toEqual(["sms:n1:2", "sms:n1:2"]);
    hubState.remaining = 0;
    expect(await h.deps.billing!.admit(UID, "sms", "n1", "MX", "3")).toEqual({ ok: false, reason: "no_tokens" });
    expect(cap.hub.at(-1)).toMatchObject({ path: "settle", body: { outcome: "cancelled" } });
  });
});
