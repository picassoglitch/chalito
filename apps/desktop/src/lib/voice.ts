/**
 * Push-to-talk. The api mints an ephemeral realtime-voice key (-41's m6-voice route); the
 * session itself is a follow-up. This is the UI's contract plus the state machine.
 */
export interface VoiceSession {
  /** Mic open, streaming to the model. Resolves once connected. */
  start(): Promise<void>;
  /** Mic closed; the reply keeps playing. */
  stop(): Promise<void>;
  /** The companion's audio for lip-sync (AnalyserNode-backed), if any. */
  onOutputLevel?(cb: (rms: number) => void): () => void;
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
      this.#session ??= await this.provider();
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

  #set(s: PttState): void {
    if (s !== "error") this.#error = null;
    this.#state = s;
    for (const l of this.#listeners) l();
  }
}
