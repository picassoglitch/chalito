import { VoiceEndedError, type VoiceEndReason, type VoiceProvider, type VoiceSession } from "./voice.js";

/** The parts of RTCPeerConnection the session uses (a fake in tests). */
export type Peer = Pick<
  RTCPeerConnection,
  | "addTrack"
  | "createDataChannel"
  | "createOffer"
  | "setLocalDescription"
  | "setRemoteDescription"
  | "close"
  | "connectionState"
  | "addEventListener"
>;

export interface WebRtcVoiceDeps {
  apiBase: string;
  /** This device's access token (the panel's device session). */
  token: () => Promise<string | null>;
  fetch?: typeof fetch;
  getUserMedia?: () => Promise<MediaStream>;
  createPeer?: () => Peer;
  /** Plays the companion's audio track. */
  play?: (stream: MediaStream) => void;
  now?: () => number;
  setInterval?: (f: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
  setTimeout?: (f: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  /** Heartbeat period: the api bills on its own clock, beats only report and get told to stop. */
  beatMs?: number;
  /** After the last release, the call is closed (and stops being billed) this long later. */
  idleMs?: number;
}

/** Errors from /v1/voice/session before any call exists. */
export class VoiceRefusedError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "VoiceRefusedError";
  }
}

interface Call {
  voiceToken: string;
  peer: Peer;
  mic: MediaStreamTrack[];
  beat: unknown;
  lastBeat: number;
  closing: boolean;
}

/**
 * Desktop voice over WebRTC, with the SDP exchange proxied by the api (POST
 * /v1/voice/session, then /v1/voice/session/sdp): the desktop never holds an OpenAI
 * credential and the api keeps the call id, so it can hang up at the monthly cap, the
 * session maximum or on revoke. A hang-up we didn't ask for — the api's `continue: false`
 * or the peer connection dropping — ends the session with a reason the panel can show.
 */
export const webrtcVoice = (deps: WebRtcVoiceDeps): VoiceProvider => {
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = deps.now ?? Date.now;
  const every = deps.setInterval ?? ((f, ms) => setInterval(f, ms));
  const stopEvery = deps.clearInterval ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>));
  const later = deps.setTimeout ?? ((f, ms) => setTimeout(f, ms));
  const cancel = deps.clearTimeout ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  const beatMs = deps.beatMs ?? 30_000;
  const idleMs = deps.idleMs ?? 20_000;

  const post = async (path: string, body: unknown) => {
    const token = await deps.token();
    if (!token) throw new VoiceRefusedError("signed_out");
    return doFetch(`${deps.apiBase}/v1/voice${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  };
  const refused = async (res: Response) => {
    const j = (await res.json().catch(() => ({}))) as { error?: unknown };
    return new VoiceRefusedError(typeof j.error === "string" ? j.error : `http_${res.status}`);
  };

  return async () => {
    let call: Call | null = null;
    let idle: unknown = null;
    const ended = new Set<(e: VoiceEndedError) => void>();

    /** Closes the call; `reason` set when the server (not the person) ended it. */
    const close = async (c: Call, reason: VoiceEndReason | null) => {
      if (c.closing) return;
      c.closing = true;
      if (call === c) call = null;
      stopEvery(c.beat);
      for (const t of c.mic) t.stop();
      c.peer.close();
      const seconds = Math.min(60, Math.round((now() - c.lastBeat) / 1000));
      await post("/session/end", { voiceToken: c.voiceToken, seconds }).catch(() => undefined);
      if (reason) for (const l of ended) l(new VoiceEndedError(reason));
    };

    const heartbeat = async (c: Call) => {
      const seconds = Math.min(60, Math.round((now() - c.lastBeat) / 1000));
      c.lastBeat = now();
      const res = await post("/session/heartbeat", { voiceToken: c.voiceToken, seconds }).catch(() => null);
      if (!res) return; // offline for a beat: the api's own clock still bills and stops it.
      const j = (await res.json().catch(() => ({}))) as { continue?: boolean; reason?: VoiceEndReason };
      if (!res.ok || j.continue === false) await close(c, j.reason ?? "ended");
    };

    const connect = async (): Promise<Call> => {
      const s = await post("/session", {});
      if (!s.ok) throw await refused(s);
      const { voiceToken } = (await s.json()) as { voiceToken: string };
      const stream = await (deps.getUserMedia ?? (() => navigator.mediaDevices.getUserMedia({ audio: true })))();
      const peer = (deps.createPeer ?? (() => new RTCPeerConnection()))();
      const mic = stream.getAudioTracks();
      const c: Call = { voiceToken, peer, mic, beat: null, lastBeat: now(), closing: false };
      try {
        for (const t of mic) {
          t.enabled = false;
          peer.addTrack(t, stream);
        }
        peer.addEventListener("track", (e) => {
          const remote = e.streams[0];
          if (remote) deps.play?.(remote);
        });
        // OpenAI's event channel; when the api hangs up, it and the connection close.
        peer.createDataChannel("oai-events").addEventListener("close", () => void close(c, "hangup"));
        peer.addEventListener("connectionstatechange", () => {
          if (peer.connectionState === "failed") void close(c, "hangup");
        });
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const a = await post("/session/sdp", { voiceToken, sdp: offer.sdp ?? "" });
        if (!a.ok) throw await refused(a);
        await peer.setRemoteDescription({ type: "answer", sdp: await a.text() });
      } catch (e) {
        c.closing = true;
        for (const t of mic) t.stop();
        peer.close();
        await post("/session/end", { voiceToken, seconds: 0 }).catch(() => undefined);
        throw e;
      }
      c.beat = every(() => void heartbeat(c), beatMs);
      return c;
    };

    const session: VoiceSession = {
      async start() {
        if (idle !== null) cancel(idle);
        idle = null;
        call ??= await connect();
        for (const t of call.mic) t.enabled = true;
      },
      async stop() {
        const c = call;
        if (!c) return;
        for (const t of c.mic) t.enabled = false;
        if (idle !== null) cancel(idle);
        idle = later(() => {
          idle = null;
          void close(c, null);
        }, idleMs);
      },
      onEnded(cb) {
        ended.add(cb);
        return () => ended.delete(cb);
      },
    };
    return session;
  };
};
