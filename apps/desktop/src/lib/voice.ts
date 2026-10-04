/**
 * Push-to-talk: the UI's contract plus the state machine. The WebRTC session (api-proxied
 * SDP, ./webrtc-voice.ts) implements VoiceSession.
 */
export interface VoiceSession {
  /** Mic open, streaming to the model. Resolves once connected. */
  start(): Promise<void>;
  /** Mic closed; the reply keeps playing. */
  stop(): Promise<void>;
  /** The companion's audio for lip-sync (AnalyserNode-backed), if any. */
  onOutputLevel?(cb: (rms: number) => void): () => void;
  /** The server ended the call (monthly cap, session maximum, credits, or a hang-up). */
  onEnded?(cb: (e: VoiceEndedError) => void): () => void;
}

/** Why the server ended a call: the api's heartbeat reasons, or the connection dropped. */
export type VoiceEndReason = "cap" | "max" | "stopped" | "ended" | "hangup";

export class VoiceEndedError extends Error {
  constructor(readonly reason: VoiceEndReason) {
    super(`voice_ended:${reason}`);
    this.name = "VoiceEndedError";
  }
}

export type VoiceProvider = () => Promise<VoiceSession>;

export class VoiceUnavailableError extends Error {
  constructor() {
    super("voice_unavailable");
    this.name = "VoiceUnavailableError";
  }
}

export const unavailableVoice: VoiceProvider = () => Promise.reject(new VoiceUnavailableError());

export type PttState = "idle" | "connecting" | "listening" | "error";

/**
 * Hold to talk: press → connecting → listening; release → idle. A release while still
 * connecting stops the session as soon as it's up (no stuck-open mic).
 */
export class PushToTalk {
  #state: PttState = "idle";
  #session: VoiceSession | null = null;
  #held = false;
  #error: unknown = null;
  readonly #listeners = new Set<() => void>();

  constructor(private readonly provider: VoiceProvider) {}

  get state(): PttState {
    return this.#state;
  }
  get error(): unknown {
    return this.#error;
  }

  subscribe = (l: () => void): (() => void) => {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  };

  async press(): Promise<void> {
    if (this.#held) return;
    this.#held = true;
    this.#set("connecting");
    try {
      if (!this.#session) {
        const s = await this.provider();
        this.#session = s;
        s.onEnded?.((e) => this.#ended(s, e));
      }
      await this.#session.start();
      if (!this.#held) {
        await this.#session.stop();
        return this.#set("idle");
      }
      this.#set("listening");
    } catch (e) {
      this.#held = false;
      this.#error = e;
      this.#set("error");
    }
  }

  async release(): Promise<void> {
    if (!this.#held) return;
    this.#held = false;
    if (this.#state !== "listening") return;
    await this.#session?.stop();
    this.#set("idle");
  }

  /** A server hang-up: the mic is already closed; the next press reconnects. */
  #ended(s: VoiceSession, e: VoiceEndedError): void {
    if (this.#session !== s) return;
    this.#held = false;
    this.#error = e;
    this.#set("error");
  }

  #set(s: PttState): void {
    if (s !== "error") this.#error = null;
    this.#state = s;
    for (const l of this.#listeners) l();
  }
}
