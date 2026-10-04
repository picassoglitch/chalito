import type { Emotion } from "@chalito/protocol";
import type { EmotionGesture } from "./emotion.js";
import { EMOTIONS } from "./emotion.js";
import { clamp, easeInOutCubic } from "./math.js";

/** VRM humanoid bone names the gestures drive (three-vrm `VRMHumanBoneName`). */
export type Bone =
  | "hips"
  | "spine"
  | "chest"
  | "neck"
  | "head"
  | "leftUpperArm"
  | "leftLowerArm"
  | "leftHand"
  | "rightUpperArm"
  | "rightLowerArm"
  | "rightHand";

/** Euler rotation in degrees (x, y, z), added on top of the idle pose. */
export type Rot = readonly [number, number, number];

export interface Keyframe {
  /** 0..1 along the gesture. */
  t: number;
  rot: Rot;
}

export interface GestureDef {
  durationMs: number;
  /** Loops until stopped (talk); otherwise plays once. */
  loop?: boolean;
  tracks: Partial<Record<Bone, readonly Keyframe[]>>;
  /** Expression accents during the gesture (e.g. the mouth during a yawn). */
  expressions?: Partial<Record<"aa" | "happy" | "relaxed" | "blink", number>>;
}

const k = (t: number, x: number, y: number, z: number): Keyframe => ({ t, rot: [x, y, z] });

/**
 * The gesture library as data (brief §5 M7): wave, nod, think, shrug, celebrate, yawn,
 * talk. Keys start and end at rest so gestures blend in and out of the idle layer.
 */
export const GESTURES: Record<EmotionGesture, GestureDef> = {
  wave: {
    durationMs: 1800,
    tracks: {
      rightUpperArm: [k(0, 0, 0, 0), k(0.15, 0, 0, 75), k(0.85, 0, 0, 75), k(1, 0, 0, 0)],
      rightLowerArm: [k(0, 0, 0, 0), k(0.15, 0, -30, 0), k(0.85, 0, -30, 0), k(1, 0, 0, 0)],
      rightHand: [
        k(0, 0, 0, 0),
        k(0.2, 0, 0, 0),
        k(0.32, 0, 0, 25),
        k(0.44, 0, 0, -20),
        k(0.56, 0, 0, 25),
        k(0.68, 0, 0, -20),
        k(0.8, 0, 0, 0),
        k(1, 0, 0, 0),
      ],
      head: [k(0, 0, 0, 0), k(0.3, 0, 0, -5), k(0.8, 0, 0, -5), k(1, 0, 0, 0)],
    },
    expressions: { happy: 0.4 },
  },
  nod: {
    durationMs: 900,
    tracks: {
      head: [k(0, 0, 0, 0), k(0.25, 12, 0, 0), k(0.5, -2, 0, 0), k(0.75, 9, 0, 0), k(1, 0, 0, 0)],
      neck: [k(0, 0, 0, 0), k(0.25, 4, 0, 0), k(0.75, 3, 0, 0), k(1, 0, 0, 0)],
    },
  },
  think: {
    durationMs: 2600,
    tracks: {
      rightUpperArm: [k(0, 0, 0, 0), k(0.2, -30, 0, 55), k(0.85, -30, 0, 55), k(1, 0, 0, 0)],
      rightLowerArm: [k(0, 0, 0, 0), k(0.2, 0, -110, 0), k(0.85, 0, -110, 0), k(1, 0, 0, 0)],
      head: [k(0, 0, 0, 0), k(0.25, -8, 10, 6), k(0.85, -8, 10, 6), k(1, 0, 0, 0)],
    },
  },
  shrug: {
    durationMs: 1200,
    tracks: {
      leftUpperArm: [k(0, 0, 0, 0), k(0.35, 0, 0, -25), k(0.65, 0, 0, -25), k(1, 0, 0, 0)],
      rightUpperArm: [k(0, 0, 0, 0), k(0.35, 0, 0, 25), k(0.65, 0, 0, 25), k(1, 0, 0, 0)],
      leftLowerArm: [k(0, 0, 0, 0), k(0.35, 0, 40, 0), k(0.65, 0, 40, 0), k(1, 0, 0, 0)],
      rightLowerArm: [k(0, 0, 0, 0), k(0.35, 0, -40, 0), k(0.65, 0, -40, 0), k(1, 0, 0, 0)],
      head: [k(0, 0, 0, 0), k(0.4, 0, 0, 8), k(0.7, 0, 0, 8), k(1, 0, 0, 0)],
    },
  },
  celebrate: {
    durationMs: 1600,
    tracks: {
      leftUpperArm: [k(0, 0, 0, 0), k(0.2, 0, 0, -150), k(0.8, 0, 0, -150), k(1, 0, 0, 0)],
      rightUpperArm: [k(0, 0, 0, 0), k(0.2, 0, 0, 150), k(0.8, 0, 0, 150), k(1, 0, 0, 0)],
      hips: [k(0, 0, 0, 0), k(0.3, 0, 0, 4), k(0.5, 0, 0, -4), k(0.7, 0, 0, 4), k(1, 0, 0, 0)],
      head: [k(0, 0, 0, 0), k(0.25, -10, 0, 0), k(0.8, -10, 0, 0), k(1, 0, 0, 0)],
    },
    expressions: { happy: 0.8 },
  },
  yawn: {
    durationMs: 2800,
    tracks: {
      // Head back, mouth open, then a little drooping settle before returning to rest.
      head: [k(0, 0, 0, 0), k(0.3, -18, 0, 0), k(0.65, -18, 0, 0), k(0.85, 4, 0, 0), k(1, 0, 0, 0)],
      chest: [k(0, 0, 0, 0), k(0.3, -6, 0, 0), k(0.65, -6, 0, 0), k(0.85, 2, 0, 0), k(1, 0, 0, 0)],
      rightUpperArm: [k(0, 0, 0, 0), k(0.3, -40, 0, 50), k(0.65, -40, 0, 50), k(1, 0, 0, 0)],
      rightLowerArm: [k(0, 0, 0, 0), k(0.3, 0, -100, 0), k(0.65, 0, -100, 0), k(1, 0, 0, 0)],
    },
    expressions: { aa: 0.8, relaxed: 0.5, blink: 0.6 },
  },
  talk: {
    durationMs: 1400,
    loop: true,
    tracks: {
      head: [k(0, 0, 0, 0), k(0.25, 3, -4, 0), k(0.5, -1, 2, 2), k(0.75, 2, 4, -1), k(1, 0, 0, 0)],
      rightLowerArm: [k(0, 0, 0, 0), k(0.4, 0, -20, 0), k(0.7, 0, -10, 0), k(1, 0, 0, 0)],
    },
  },
};

const sampleTrack = (keys: readonly Keyframe[], u: number): Rot => {
  if (u <= keys[0]!.t) return keys[0]!.rot;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (u <= b.t) {
      const e = easeInOutCubic((u - a.t) / Math.max(1e-6, b.t - a.t));
      return [
        a.rot[0] + (b.rot[0] - a.rot[0]) * e,
        a.rot[1] + (b.rot[1] - a.rot[1]) * e,
        a.rot[2] + (b.rot[2] - a.rot[2]) * e,
      ];
    }
  }
  return keys[keys.length - 1]!.rot;
};

export interface GestureSample {
  bones: Partial<Record<Bone, Rot>>;
  expressions: GestureDef["expressions"];
  done: boolean;
}

/** Bone rotations for a gesture `tMs` after it started, scaled by `weight` (0..1). */
export const sampleGesture = (g: GestureDef, tMs: number, weight = 1): GestureSample => {
  const done = !g.loop && tMs >= g.durationMs;
  const u = g.loop ? (((tMs % g.durationMs) + g.durationMs) % g.durationMs) / g.durationMs : clamp(tMs / g.durationMs);
  const w = clamp(weight);
  const bones: Partial<Record<Bone, Rot>> = {};
  for (const [bone, keys] of Object.entries(g.tracks) as [Bone, readonly Keyframe[]][]) {
    const r = sampleTrack(keys, done ? 1 : u);
    bones[bone] = [r[0] * w, r[1] * w, r[2] * w];
  }
  // Accents fade in and out with the gesture (a bell over 0..1).
  const env = done ? 0 : Math.sin(Math.PI * u);
  const expressions = g.expressions
    ? Object.fromEntries(Object.entries(g.expressions).map(([k2, v]) => [k2, v * env * w]))
    : undefined;
  return { bones, expressions, done };
};

// ---------------------------------------------------------------- non-humanoid preset

export interface CreaturePose {
  /** Scale (x, y, z): squash-and-stretch with volume preserved (x·y·z ≈ 1). */
  scale: readonly [number, number, number];
  /** Vertical bob offset (model units). */
  offsetY: number;
  /** Body tilt in degrees (x = nod forward/back, z = side tilt). */
  tilt: readonly [number, number, number];
  /** 0..1: how strongly the body turns toward the look-at target. */
  lookAtWeight: number;
}

/**
 * Animals and other non-humanoid avatars (and the 2.5D image "card", M8): the same emotion
 * API drives procedural squash-and-stretch, a bob and look-at instead of bones and blend
 * shapes. Pure in t.
 */
export const creaturePose = (e: Emotion, tMs: number): CreaturePose => {
  const pose = EMOTIONS[e.tag];
  const i = clamp(e.intensity);
  const energy = 0.5 + (pose.energy - 0.5) * i;
  const t = tMs / 1000;
  const hz = 0.6 + energy * 1.8;
  const bob = Math.abs(Math.sin(Math.PI * hz * t));
  // Stretch on the way up, squash on landing; excited bounces more, tired barely moves.
  const amount = 0.02 + energy * 0.1;
  const sy = 1 + amount * (bob - 0.5) * 2;
  const sxz = 1 / Math.sqrt(sy);
  const sadSag = e.tag === "sad" || e.tag === "tired" ? 0.06 * i : 0;
  return {
    scale: [sxz, sy * (1 - sadSag), sxz],
    offsetY: bob * (0.01 + energy * 0.05),
    tilt: [pose.headPitch * i * 0.6, 0, e.tag === "thinking" || e.tag === "worried" ? 8 * i : 0],
    lookAtWeight: e.tag === "tired" ? 0.2 : 0.6 + 0.4 * energy,
  };
};
