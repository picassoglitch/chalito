import { describe, expect, it } from "vitest";
import { PushToTalk, VoiceEndedError } from "../src/lib/voice.js";
import { VoiceRefusedError, webrtcVoice, type Peer } from "../src/lib/webrtc-voice.js";

type Req = { path: string; auth: string | null; body: Record<string, unknown> };

const harness = (o: { session?: () => Response; sdp?: () => Response; beat?: () => unknown } = {}) => {
  const reqs: Req[] = [];
  let clock = 1_000_000;
  const timers = new Map<number, { f: () => void; ms: number; repeat: boolean }>();
  let nextId = 1;
  const track = {
    enabled: true,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const stream = { getAudioTracks: () => [track] } as unknown as MediaStream;
  const listeners: Record<string, (e: unknown) => void> = {};
  let channelClose: () => void = () => undefined;
  const peer = {
    connectionState: "new",
    closed: false,
    remote: null as unknown,
    addTrack: () => undefined,
    createDataChannel: () => ({ addEventListener: (_: string, f: () => void) => void (channelClose = f) }),
    createOffer: async () => ({ type: "offer", sdp: "v=0\r\noffer" }),
    setLocalDescription: async () => undefined,
    setRemoteDescription: async (d: unknown) => void (peer.remote = d),
    close: () => void (peer.closed = true),
    addEventListener: (ev: string, f: (e: unknown) => void) => void (listeners[ev] = f),
  };
  const played: unknown[] = [];
  const provider = webrtcVoice({
    apiBase: "https://api.test",
    token: async () => "device-token",
    fetch: (async (url: string, init: RequestInit) => {
      const path = url.replace("https://api.test/v1/voice", "");
      reqs.push({
        path,
        auth: new Headers(init.headers).get("authorization"),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      if (path === "/session")
        return o.session?.() ?? Response.json({ voiceToken: "vt_1", maxSeconds: 600 }, { status: 201 });
      if (path === "/session/sdp")
        return (
          o.sdp?.() ?? new Response("v=0\r\nanswer", { status: 201, headers: { "content-type": "application/sdp" } })
        );
      if (path === "/session/heartbeat") return Response.json(o.beat?.() ?? { ok: true, continue: true });
      return Response.json({ ok: true });
    }) as typeof fetch,
    getUserMedia: async () => stream,
    createPeer: () => peer as unknown as Peer,
    play: (s) => played.push(s),
    now: () => clock,
    setInterval: (f, ms) => (timers.set(nextId, { f, ms, repeat: true }), nextId++),
    clearInterval: (id) => void timers.delete(id as number),
    setTimeout: (f, ms) => (timers.set(nextId, { f, ms, repeat: false }), nextId++),
    clearTimeout: (id) => void timers.delete(id as number),
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  /** Advances the clock and fires due timers once. */
  const tick = async (ms: number) => {
    clock += ms;
    for (const [id, t] of [...timers]) {
      if (t.ms > ms) continue;
      if (!t.repeat) timers.delete(id);
      t.f();
    }
    await flush();
  };
  return { provider, reqs, track, peer, played, listeners, hangUp: () => channelClose(), tick, flush, timers };
};

describe("desktop WebRTC voice (SDP proxied by the api)", () => {
  it("opens a session, posts its offer to the api, and applies the answer; the mic opens only while held", async () => {
    const h = harness();
    const s = await h.provider();
    await s.start();
    expect(h.reqs.map((r) => r.path)).toEqual(["/session", "/session/sdp"]);
    expect(h.reqs[1]).toEqual({
      path: "/session/sdp",
      auth: "Bearer device-token",
      body: { voiceToken: "vt_1", sdp: "v=0\r\noffer" },
    });
    expect(h.peer.remote).toEqual({ type: "answer", sdp: "v=0\r\nanswer" });
    expect(h.track.enabled).toBe(true);
    await s.stop();
    expect(h.track.enabled).toBe(false);
    // Pressing again reuses the call.
    await s.start();
    expect(h.reqs.filter((r) => r.path === "/session")).toHaveLength(1);
  });

  it("heart-beats every 30 s and closes the call after it's been idle", async () => {
    const h = harness();
    const s = await h.provider();
    await s.start();
    await h.tick(30_000);
    expect(h.reqs.at(-1)).toMatchObject({ path: "/session/heartbeat", body: { voiceToken: "vt_1", seconds: 30 } });
    await s.stop();
    await h.tick(20_000);
    expect(h.reqs.at(-1)).toMatchObject({ path: "/session/end", body: { voiceToken: "vt_1" } });
    expect([h.peer.closed, h.track.stopped]).toEqual([true, true]);
    expect(h.timers.size).toBe(0);
  });

  it("`continue: false` from the api ends the call with its reason; push-to-talk shows it and can reconnect", async () => {
    let beat: unknown = { ok: true, continue: true };
    const h = harness({ beat: () => beat });
    const ptt = new PushToTalk(h.provider);
    await ptt.press();
    expect(ptt.state).toBe("listening");
    beat = { ok: true, continue: false, reason: "cap", billedSeconds: 30 };
    await h.tick(30_000);
    await h.flush();
    expect(ptt.state).toBe("error");
    expect((ptt.error as VoiceEndedError).reason).toBe("cap");
    expect([h.peer.closed, h.track.stopped]).toEqual([true, true]);
    await ptt.release();
    await ptt.press();
    expect(h.reqs.filter((r) => r.path === "/session")).toHaveLength(2);
  });

  it("a server hang-up (the event channel closes) is reported, not retried", async () => {
    const h = harness();
    const ptt = new PushToTalk(h.provider);
    await ptt.press();
    h.hangUp();
    await h.flush();
    expect(ptt.state).toBe("error");
    expect(ptt.error).toBeInstanceOf(VoiceEndedError);
    expect((ptt.error as VoiceEndedError).reason).toBe("hangup");
    expect(h.reqs.at(-1)?.path).toBe("/session/end");
  });

  it("refusals: the cap before connecting, and a failed SDP exchange ends the session and frees the mic", async () => {
    const capped = harness({ session: () => Response.json({ error: "voice_cap_reached" }, { status: 402 }) });
    const s = await capped.provider();
    await expect(s.start()).rejects.toEqual(new VoiceRefusedError("voice_cap_reached"));
    const bad = harness({ sdp: () => Response.json({ error: "voice_connect_expired" }, { status: 410 }) });
    const s2 = await bad.provider();
    await expect(s2.start()).rejects.toBeInstanceOf(VoiceRefusedError);
    expect([bad.peer.closed, bad.track.stopped]).toEqual([true, true]);
    expect(bad.reqs.at(-1)).toMatchObject({ path: "/session/end", body: { voiceToken: "vt_1", seconds: 0 } });
  });
});
