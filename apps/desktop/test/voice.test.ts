import { describe, expect, it } from "vitest";
import { PushToTalk, VoiceUnavailableError, unavailableVoice, type VoiceSession } from "../src/lib/voice.js";

const fakeSession = () => {
  const calls: string[] = [];
  let resolveStart: () => void = () => undefined;
  const session: VoiceSession = {
    start: () => {
      calls.push("start");
      return new Promise<void>((r) => (resolveStart = r));
    },
    stop: async () => void calls.push("stop"),
  };
  return { session, calls, connected: () => resolveStart() };
};

describe("push-to-talk", () => {
  it("press → connecting → listening; release → idle", async () => {
    const f = fakeSession();
    const ptt = new PushToTalk(async () => f.session);
    const seen: string[] = [];
    ptt.subscribe(() => seen.push(ptt.state));
    const pressed = ptt.press();
    await Promise.resolve();
    expect(ptt.state).toBe("connecting");
    f.connected();
    await pressed;
    expect(ptt.state).toBe("listening");
    await ptt.release();
    expect(ptt.state).toBe("idle");
    expect(f.calls).toEqual(["start", "stop"]);
    expect(seen).toEqual(["connecting", "listening", "idle"]);
  });

  it("releasing while connecting never leaves the mic open", async () => {
    const f = fakeSession();
    const ptt = new PushToTalk(async () => f.session);
    const pressed = ptt.press();
    await Promise.resolve();
    await ptt.release();
    f.connected();
    await pressed;
    expect(ptt.state).toBe("idle");
    expect(f.calls).toEqual(["start", "stop"]);
  });

  it("no voice route yet: an error state, and it can be retried", async () => {
    const ptt = new PushToTalk(unavailableVoice);
    await ptt.press();
    expect(ptt.state).toBe("error");
    expect(ptt.error).toBeInstanceOf(VoiceUnavailableError);
    await ptt.release();
    await ptt.press();
    expect(ptt.state).toBe("error");
  });
});
