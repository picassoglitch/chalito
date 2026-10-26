// Adapted from Alux by Omar (homiomar), pet/vad.js: end of speech by loudness over a learned
// noise floor, so a fan or laptop hum doesn't count as talking.

export const rms = (pcm: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += pcm[i]! * pcm[i]!;
  return pcm.length ? Math.sqrt(s / pcm.length) : 0;
};

/** Why to stop listening: the person finished, the time cap, or nobody spoke. */
export type EndReason = "silence" | "max" | "nothing";

export interface EndpointerOptions {
  /** Quiet this long after speech ends the utterance. */
  silenceMs: number;
  maxMs: number;
  /** Nothing said for this long: give up. */
  noSpeechMs: number;
  /** Loud audio shorter than this is a click or a cough, not speech. */
  minSpeechMs: number;
  /** The first audio, used to learn the room. */
  floorMs: number;
  /** The quietest level that can count as speech, whatever the floor. */
  min: number;
}

export const COMMAND_ENDPOINTER: EndpointerOptions = {
  silenceMs: 1200,
  maxMs: 15_000,
  noSpeechMs: 6000,
  minSpeechMs: 200,
  floorMs: 250,
  min: 0.01,
};

export interface Endpointer {
  /** One frame's loudness and length: null while listening, or why to stop. */
  push(level: number, ms: number): EndReason | null;
  readonly spoke: boolean;
  readonly floor: number;
}

export const createEndpointer = (opts: Partial<EndpointerOptions> = {}): Endpointer => {
  const o = { ...COMMAND_ENDPOINTER, ...opts };
  let t = 0;
  let floor = 0;
  let floorN = 0;
  let speech = 0;
  let quiet = 0;
  return {
    push(level, ms) {
      t += ms;
      if (t <= o.floorMs) {
        floor = (floor * floorN + level) / ++floorN;
        return null;
      }
      const on = Math.max(o.min, floor * 3);
      if (level >= on) {
        speech += ms;
        quiet = 0;
      } else if (level < on * 0.6) {
        quiet += ms;
        // Keeps learning after the start: someone who talks right away mustn't become the floor.
        floor = level < floor ? level : floor * 0.95 + level * 0.05;
      }
      if (t >= o.maxMs) return "max";
      if (speech < o.minSpeechMs) return t >= o.noSpeechMs ? "nothing" : null;
      return quiet >= o.silenceMs ? "silence" : null;
    },
    get spoke() {
      return speech >= o.minSpeechMs;
    },
    get floor() {
      return floor;
    },
  };
};
