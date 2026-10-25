import { concat, downsample, SPEECH_RATE } from "./audio.js";
import type { SpeechEngine } from "./engine.js";
import { parseIntent, type VoiceCommand } from "./intent.js";
import { COMMAND_ENDPOINTER, createEndpointer, rms, type EndpointerOptions } from "./vad.js";

/** The microphone: calls `onFrame` with mono samples until the returned stop is called. */
export interface Recorder {
  start(onFrame: (pcm: Float32Array, rate: number) => void): Promise<() => void>;
}

export type OfflineVoiceState =
  | { phase: "idle" }
  | { phase: "listening" }
  | { phase: "transcribing" }
  /** Something to confirm: nothing runs until a click on the card. */
  | { phase: "card"; text: string; commands: VoiceCommand[] }
  | { phase: "unknown"; text: string }
  | { phase: "nothing" }
  | { phase: "error"; error: unknown };

export class MicSilentError extends Error {
  constructor() {
    super("mic_silent");
    this.name = "MicSilentError";
  }
}

/** Shorter than this, audio isn't worth decoding. */
const MIN_AUDIO_S = 0.3;
/** A press released sooner is a tap: keep listening until the person stops talking. */
export const TAP_MS = 300;

/** Hold to talk (ends on release) or tap and talk (ends when the person stops, or a second tap).
 * Then one decode, one parse, and a card. */
export class OfflineVoice {
  #state: OfflineVoiceState = { phase: "idle" };
  readonly #listeners = new Set<() => void>();
  #run = 0;
  #held = false;
  #pressedAt = 0;
  #stop: (() => void) | null = null;
  #chunks: Float32Array[] = [];
  #rate = SPEECH_RATE;

  constructor(
    private readonly deps: {
      recorder: Recorder;
      engine: SpeechEngine;
      now?: () => number;
      endpointer?: Partial<EndpointerOptions>;
      /** No audio at all this long after the mic opened is an error. */
      noAudioMs?: number;
    },
  ) {}

  get state(): OfflineVoiceState {
    return this.#state;
  }

  subscribe = (l: () => void): (() => void) => {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  };

  #now = () => (this.deps.now ?? Date.now)();
  /** Read fresh: awaits and frame callbacks change it under a narrowed check. */
  #phase = (): OfflineVoiceState["phase"] => this.#state.phase;

  #set(s: OfflineVoiceState) {
    this.#state = s;
    if (s.phase === "error") console.warn("offline-voice:", s.error);
    for (const l of this.#listeners) l();
  }

  async press(): Promise<void> {
    if (this.#held) return;
    if (this.#state.phase === "transcribing") return;
    if (this.#phase() === "listening") return this.#finish(this.#run, "tap");
    const run = ++this.#run;
    this.#held = true;
    this.#pressedAt = this.#now();
    this.#chunks = [];
    const ep = createEndpointer(this.deps.endpointer);
    this.#set({ phase: "listening" });
    // Armed before the mic opens: a start that hangs or a mic that never delivers can't listen forever.
    setTimeout(() => {
      if (run !== this.#run || this.#phase() !== "listening" || this.#chunks.length) return;
      this.#held = false;
      this.#stop?.();
      this.#stop = null;
      this.#set({ phase: "error", error: new MicSilentError() });
    }, this.deps.noAudioMs ?? 2000);
    // The endpointer's cap counts audio; this one counts the clock, for a mic that stalls midway.
    setTimeout(() => void this.#finish(run, "spoke"), (this.deps.endpointer?.maxMs ?? COMMAND_ENDPOINTER.maxMs) + 2000);
    try {
      const stop = await this.deps.recorder.start((pcm, rate) => {
        if (run !== this.#run || this.#phase() !== "listening") return;
        this.#rate = rate;
        this.#chunks.push(pcm);
        const end = ep.push(rms(pcm), (pcm.length / rate) * 1000);
        // While held, only the time cap ends it: a pause mid-sentence isn't the end.
        if (end === "max" || (end && !this.#held)) void this.#finish(run, end === "nothing" ? "nothing" : "spoke");
      });
      // A late start (after a timer below ended the run) closes its mic right away.
      if (run !== this.#run || this.#phase() !== "listening") return stop();
      this.#stop = stop;
    } catch (e) {
      this.#held = false;
      if (run === this.#run) this.#set({ phase: "error", error: e });
    }
  }

  async release(): Promise<void> {
    if (!this.#held) return;
    this.#held = false;
    if (this.#phase() !== "listening") return;
    if (this.#now() - this.#pressedAt < TAP_MS) return;
    return this.#finish(this.#run, "release");
  }

  /** Closes the card (or the message) without doing anything. */
  dismiss(): void {
    this.#run++;
    this.#held = false;
    this.#stop?.();
    this.#stop = null;
    this.#set({ phase: "idle" });
  }

  async #finish(run: number, why: "tap" | "release" | "spoke" | "nothing"): Promise<void> {
    if (run !== this.#run || this.#phase() !== "listening") return;
    this.#held = false;
    this.#stop?.();
    this.#stop = null;
    const pcm = downsample(concat(this.#chunks), this.#rate);
    this.#chunks = [];
    if (why === "nothing" || pcm.length < MIN_AUDIO_S * SPEECH_RATE) return this.#set({ phase: "nothing" });
    this.#set({ phase: "transcribing" });
    try {
      const heard = await this.deps.engine.transcribe(pcm, SPEECH_RATE);
      if (run !== this.#run) return;
      const parsed = parseIntent(heard.text);
      if (!parsed.text) return this.#set({ phase: "nothing" });
      this.#set(
        parsed.commands.length
          ? { phase: "card", text: parsed.text, commands: parsed.commands }
          : { phase: "unknown", text: parsed.text },
      );
    } catch (e) {
      if (run === this.#run) this.#set({ phase: "error", error: e });
    }
  }
}
