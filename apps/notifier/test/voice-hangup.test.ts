import { describe, expect, it } from "vitest";
import { loadPrices } from "@chalito/config";
import { MemoryOutbox, MemoryVoiceSessions, type HubClient } from "@chalito/billing";
import { hubCommsBilling } from "../src/billing.js";

describe("the drain sweep hangs up a stale desktop call (api-proxied WebRTC)", () => {
  it("hangs up desktop sessions that carry a call id, bills them in full and settles", async () => {
    const T0 = 1_790_000_000_000;
    const settled: string[] = [];
    const hungUp: string[] = [];
    const voiceSessions = new MemoryVoiceSessions();
    const billing = hubCommsBilling({
      hub: {
        settle: async (b: { reservation_id: string }) => void settled.push(b.reservation_id),
      } as unknown as HubClient,
      outbox: new MemoryOutbox(),
      enqueue: async () => undefined,
      prices: loadPrices(),
      voiceModel: "gpt-realtime-2.1-mini",
      reserveBasis: "pre_margin",
      now: () => T0 + 60_000 + 121_000,
      alert: () => undefined,
      voiceSessions,
      desktopVoiceEvent: () => null,
      hangupCall: async (id) => void hungUp.push(id),
    });
    const base = { model: "gpt-realtime-2.1-mini", startedAt: T0, maxSeconds: 60 };
    await voiceSessions.open({
      ...base,
      sourceId: "vs_a",
      owner: "u1",
      channel: "desktop",
      deviceId: "d1",
      reservationId: "r_a",
    });
    await voiceSessions.setCallId("u1", "vs_a", "rtc_a");
    // Not connected yet (no call id): nothing to hang up, still billed and settled.
    await voiceSessions.open({
      ...base,
      sourceId: "vs_b",
      owner: "u2",
      channel: "desktop",
      deviceId: "d2",
      reservationId: "r_b",
    });
    const r = await billing.drain();
    expect(r.voiceSessionsSwept).toBe(2);
    expect(hungUp).toEqual(["rtc_a"]);
    expect(settled.sort()).toEqual(["r_a", "r_b"]);
  });
});
