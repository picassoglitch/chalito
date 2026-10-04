import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BASE, NOON_MX, SCHEDULER_SA, googleToken, hubState, mockServer, prefs, setup } from "./harness.js";

const { server, cap } = mockServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  for (const list of Object.values(cap)) list.length = 0;
  hubState.admit = "allowed";
});

const UID = "u-pro";
const SID = `CA${"c".repeat(32)}`;

/** A user on Standard access (120 voice minutes) with a phone call's voice open since NOON_MX. */
const onCall = async (o: { callId?: string; maxSeconds?: number } = {}) => {
  const h = setup({ billing: true, caps: true });
  h.store.prefs.set(UID, prefs());
  h.store.tiers.set(UID, "pro");
  await h.voiceSessions.open({
    sourceId: "voice_call1",
    owner: UID,
    channel: "call",
    deviceId: SID,
    reservationId: "6f1c2a4e-1b2c-4d3e-8f4a-5b6c7d8e9f01",
    model: "gpt-realtime-2.1-mini",
    startedAt: NOON_MX,
    maxSeconds: o.maxSeconds ?? 900,
  });
  if (o.callId) await h.voiceSessions.setCallId(UID, "voice_call1", o.callId);
  const drain = async () =>
    (await (
      await h.app.request("/tasks/drain-usage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${await googleToken({ aud: `${BASE}/tasks/drain-usage`, email: SCHEDULER_SA })}`,
        },
      })
    ).json()) as Record<string, number>;
  return { h, drain };
};

const hungUp = () => cap.openai.filter((c) => c.path.endsWith("/hangup")).map((c) => c.path);

describe("phone-call voice is hung up server-side", () => {
  it("at the cap: when the month's minutes run out mid-call (desktop voice shares them), both legs end", async () => {
    const { h, drain } = await onCall({ callId: "rtc_call_a" });
    h.store.voiceSeconds.set(UID, 120 * 60 - 100); // 100 s left this month
    h.setClock(NOON_MX + 60_000);
    expect((await drain()).callsEndedAtCap).toBe(0);
    expect(cap.callUpdates).toEqual([]);
    h.setClock(NOON_MX + 100_000);
    expect((await drain()).callsEndedAtCap).toBe(1);
    expect(cap.callUpdates).toEqual([{ callSid: SID, form: { Status: "completed" } }]);
    expect(hungUp()).toEqual(["/v1/realtime/calls/rtc_call_a/hangup"]);
    expect(h.store.notifications.get(`${UID}/cap_voice_2026_10`)).toMatchObject({ source: "budget" });
    // Still open: the call agent bills it when its socket closes (or the sweep, if that instance died).
    expect([...h.voiceSessions.sessions.values()][0]!.endedAt).toBeNull();
  });

  it("the stale sweep ends a call nobody closed: Twilio and OpenAI, then bills it in full", async () => {
    const { h, drain } = await onCall({ callId: "rtc_call_b", maxSeconds: 60 });
    h.setClock(NOON_MX + 60_000 + 121_000);
    expect(await drain()).toMatchObject({ voiceSessionsSwept: 1 });
    expect(cap.callUpdates.map((u) => u.callSid)).toEqual([SID]);
    expect(hungUp()).toEqual(["/v1/realtime/calls/rtc_call_b/hangup"]);
    expect([...h.voiceSessions.sessions.values()][0]!.billedSeconds).toBe(60);
  });

  it("a call OpenAI never accepted (no call id) is still ended at Twilio", async () => {
    const { h, drain } = await onCall({ maxSeconds: 60 });
    h.setClock(NOON_MX + 60_000 + 121_000);
    await drain();
    expect(cap.callUpdates.map((u) => u.callSid)).toEqual([SID]);
    expect(hungUp()).toEqual([]);
  });
});
