import type { Emotion, EmotionTag } from "@chalito/protocol";
import { clamp, easeInOutCubic, lerp } from "./math.js";

/**
 * VRM 1.0 emotion expression presets (three-vrm `VRMExpressionPresetName`), plus `aa` (the
 * open-mouth viseme), which the VRM 0.x fallback for `surprised` borrows.
 */
export const EXPRESSIONS = ["happy", "angry", "sad", "relaxed", "surprised", "neutral", "aa"] as const;
export type ExpressionName = (typeof EXPRESSIONS)[number];
export type ExpressionWeights = Partial<Record<ExpressionName, number>>;

/** Gestures a tag may trigger (same names as `Gesture` in @chalito/protocol). */
export type EmotionGesture = "wave" | "nod" | "think" | "shrug" | "celebrate" | "yawn" | "talk";

export interface EmotionPose {
  /** Expression weights at intensity 1. */
  expressions: ExpressionWeights;
  /** A gesture to play when intensity is at least `gestureAt`. */
  gesture?: EmotionGesture;
  gestureAt?: number;
  /** Head pitch in degrees (+ = up) and body energy (0 slumped … 1 bouncy) at intensity 1. */
  headPitch: number;
  energy: number;
  /** Multiplies the blink rate (tired blinks slowly and long; excited/worried more often). */
  blinkRate: number;
  /** Baseline eyelid droop 0..1 (tired, sleepy). */
  eyelidDroop: number;
}

/**
 * Every EmotionTag in @chalito/protocol. The five VRM presets map 1:1; the rest are
 * combinations of expressions, a gesture and posture.
 */
export const EMOTIONS: Record<EmotionTag, EmotionPose> = {
  neutral: { expressions: { neutral: 1 }, headPitch: 0, energy: 0.5, blinkRate: 1, eyelidDroop: 0 },
  happy: {
    expressions: { happy: 1 },
    headPitch: 3,
    energy: 0.7,
    blinkRate: 1,
    eyelidDroop: 0,
    gesture: "nod",
    gestureAt: 0.8,
  },
  angry: { expressions: { angry: 1 }, headPitch: -4, energy: 0.6, blinkRate: 0.8, eyelidDroop: 0 },
  sad: { expressions: { sad: 1 }, headPitch: -8, energy: 0.2, blinkRate: 0.9, eyelidDroop: 0.15 },
  relaxed: { expressions: { relaxed: 1 }, headPitch: 1, energy: 0.4, blinkRate: 0.9, eyelidDroop: 0.1 },
  surprised: { expressions: { surprised: 1 }, headPitch: 4, energy: 0.8, blinkRate: 0.6, eyelidDroop: 0 },
  excited: {
    expressions: { happy: 0.85, surprised: 0.35 },
    headPitch: 5,
    energy: 1,
    blinkRate: 1.3,
    eyelidDroop: 0,
    gesture: "celebrate",
    gestureAt: 0.6,
  },
  tired: {
    expressions: { relaxed: 0.5, sad: 0.3 },
    headPitch: -10,
    energy: 0.1,
    blinkRate: 0.6,
    eyelidDroop: 0.45,
    gesture: "yawn",
    gestureAt: 0.5,
  },
  thinking: {
    expressions: { neutral: 0.6, relaxed: 0.2 },
    headPitch: 6,
    energy: 0.4,
    blinkRate: 0.7,
    eyelidDroop: 0.05,
    gesture: "think",
    gestureAt: 0.3,
  },
  worried: {
    expressions: { sad: 0.55, surprised: 0.3 },
    headPitch: -3,
    energy: 0.35,
    blinkRate: 1.4,
    eyelidDroop: 0,
    gesture: "shrug",
    gestureAt: 0.75,
  },
};

export interface ModelCaps {
  /** The model's expression names (from its VRM); VRM 0.x has no `surprised`. */
  available: ReadonlySet<string>;
}

export const VRM1_CAPS: ModelCaps = { available: new Set(EXPRESSIONS) };
export const VRM0_CAPS: ModelCaps = { available: new Set(EXPRESSIONS.filter((e) => e !== "surprised")) };

/**
 * Re-expresses weights the model can't show. VRM 0.x has no `surprised`: an open mouth
 * (`aa`) plus a little `happy` reads as surprise on most avatars. Anything else missing is
 * dropped. Weights are clamped to 0..1.
 */
export const adaptToModel = (w: ExpressionWeights, caps: ModelCaps): ExpressionWeights => {
  const out: ExpressionWeights = {};
  const add = (k: ExpressionName, v: number) => {
    if (v > 0 && caps.available.has(k)) out[k] = clamp((out[k] ?? 0) + v);
  };
  for (const [k, v] of Object.entries(w) as [ExpressionName, number][]) {
    if (caps.available.has(k)) add(k, v);
    else if (k === "surprised") {
      add("aa", v * 0.5);
      add("happy", v * 0.15);
    }
  }
  return out;
};

/** Expression weights for an emotion at its intensity (scaled from the intensity-1 pose). */
export const expressionTarget = (e: Emotion, caps: ModelCaps = VRM1_CAPS): ExpressionWeights => {
  // Neutral is the rest face, whatever its intensity.
  if (e.tag === "neutral") return adaptToModel({ neutral: 1 }, caps);
  const pose = EMOTIONS[e.tag];
  const i = clamp(e.intensity);
  const scaled: ExpressionWeights = {};
  for (const [k, v] of Object.entries(pose.expressions) as [ExpressionName, number][]) scaled[k] = v * i;
  // Low intensities keep some neutral underneath, so a 0.2 "happy" is a hint, not a grin.
  scaled.neutral = Math.max(scaled.neutral ?? 0, 1 - i);
  return adaptToModel(scaled, caps);
};

/** The gesture to play for an emotion, if its intensity reaches the pose's threshold. */
export const emotionGesture = (e: Emotion): EmotionGesture | null => {
  const p = EMOTIONS[e.tag];
  return p.gesture && clamp(e.intensity) >= (p.gestureAt ?? 0) ? p.gesture : null;
};

export interface BlendOptions {
  /** Transition time in ms at full change (shorter for small changes). */
  transitionMs?: number;
  /** How long the emotion holds before easing back to neutral; scaled up with intensity. */
  holdMs?: number;
  /** Ease back to neutral over this long. */
  releaseMs?: number;
}

interface Segment {
  from: ExpressionWeights;
  to: ExpressionWeights;
  start: number;
  duration: number;
}

const blendWeights = (a: ExpressionWeights, b: ExpressionWeights, t: number): ExpressionWeights => {
  const out: ExpressionWeights = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<ExpressionName>) {
    const v = lerp(a[k] ?? 0, b[k] ?? 0, t);
    if (v > 1e-4) out[k] = v;
  }
  return out;
};

const distance = (a: ExpressionWeights, b: ExpressionWeights) => {
  let d = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<ExpressionName>)
    d = Math.max(d, Math.abs((a[k] ?? 0) - (b[k] ?? 0)));
  return d;
};

/**
 * Blends expression weights over time: each new emotion eases in from wherever the face is
 * (ease-in-out), holds, then eases back to neutral. Pure function of the times passed in.
 */
export class EmotionBlender {
  #segments: Segment[] = [];
  #neutral: ExpressionWeights;
  readonly #opts: Required<BlendOptions>;

  constructor(
    private readonly caps: ModelCaps = VRM1_CAPS,
    opts: BlendOptions = {},
  ) {
    this.#opts = {
      transitionMs: opts.transitionMs ?? 450,
      holdMs: opts.holdMs ?? 3500,
      releaseMs: opts.releaseMs ?? 1200,
    };
    this.#neutral = expressionTarget({ tag: "neutral", intensity: 1 }, caps);
  }

  /** Starts blending toward `e` at time `now` (ms). */
  set(e: Emotion, now: number): void {
    const from = this.sample(now);
    const to = expressionTarget(e, this.caps);
    const dur = Math.max(120, this.#opts.transitionMs * Math.max(0.35, distance(from, to)));
    const hold = e.tag === "neutral" ? Infinity : this.#opts.holdMs * (0.6 + 0.8 * clamp(e.intensity));
    this.#segments = [{ from, to, start: now, duration: dur }];
    if (Number.isFinite(hold))
      this.#segments.push({ from: to, to: this.#neutral, start: now + dur + hold, duration: this.#opts.releaseMs });
  }

  /** Expression weights at time `now` (ms). */
  sample(now: number): ExpressionWeights {
    if (!this.#segments.length) return { ...this.#neutral };
    let current = this.#segments[0]!.from;
    for (const s of this.#segments) {
      if (now < s.start) break;
      const t = s.duration > 0 ? (now - s.start) / s.duration : 1;
      current = blendWeights(s.from, s.to, easeInOutCubic(t));
    }
    return current;
  }
}
