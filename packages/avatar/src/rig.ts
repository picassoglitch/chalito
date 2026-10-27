import { clamp } from "./math.js";
import { ACTION_MS, fidgetAt, type CreatureAction, type CreatureMode } from "./actions.js";
import type { Gaze } from "./idle.js";
import { keyed, type Key } from "./retro.js";

/** Cutout rigs (2026-10-19): each part is a full-card image turned about its pivot (card space, 0..1
 * from the top left) so arms, head, lids and mouth move. A card without a rig moves as one piece. */
export type RigPartId = "body" | "armL" | "armR" | "head" | "lids" | "mouth";
export const RIG_PART_IDS: readonly RigPartId[] = ["body", "armL", "armR", "head", "lids", "mouth"];

export interface RigPart {
  id: RigPartId;
  /** One image, or one per drawing (the head changes with the expression). */
  src: string | Record<string, string>;
  pivot: readonly [number, number];
  z: number;
  /** Turns with this part (the eyelids and mouth sit on the head). */
  parent?: RigPartId;
  /** Shown only with these drawings (e.g. the eyelids fit the neutral face only). */
  only?: readonly string[];
}

export interface RigSpec {
  v: 1;
  parts: readonly RigPart[];
}

const isPair = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && n >= 0 && n <= 1);
const isFile = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9_.-]+\.webp$/i.test(v);

/** A card.json `rig`, checked: anything malformed is no rig (the card moves as one piece). */
export const parseRig = (v: unknown): RigSpec | null => {
  if (!v || typeof v !== "object") return null;
  const r = v as { v?: unknown; parts?: unknown };
  if (r.v !== 1 || !Array.isArray(r.parts)) return null;
  const parts: RigPart[] = [];
  for (const p of r.parts as Record<string, unknown>[]) {
    if (!p || !RIG_PART_IDS.includes(p.id as RigPartId) || !isPair(p.pivot)) return null;
    const src = p.src;
    const okSrc = isFile(src) || (!!src && typeof src === "object" && Object.values(src).every(isFile));
    if (!okSrc) return null;
    if (p.parent !== undefined && !RIG_PART_IDS.includes(p.parent as RigPartId)) return null;
    if (p.only !== undefined && !(Array.isArray(p.only) && p.only.every((s) => typeof s === "string"))) return null;
    parts.push({
      id: p.id as RigPartId,
      src: src as RigPart["src"],
      pivot: p.pivot,
      z: typeof p.z === "number" ? p.z : 0,
      ...(p.parent ? { parent: p.parent as RigPartId } : {}),
      ...(p.only ? { only: p.only as string[] } : {}),
    });
  }
  const ids = new Set(parts.map((p) => p.id));
  // A rig needs at least a body and a head; a parent must be one of its parts.
  if (!ids.has("body") || !ids.has("head") || ids.size !== parts.length) return null;
  if (parts.some((p) => p.parent && !ids.has(p.parent))) return null;
  return { v: 1, parts };
};

/** Every image a rig needs (for loading). */
export const rigFiles = (rig: RigSpec): string[] => [
  ...new Set(rig.parts.flatMap((p) => (typeof p.src === "string" ? [p.src] : Object.values(p.src)))),
];

/** The part's image for a drawing: its own, else the neutral one, else null (hidden). */
export const rigSrcFor = (part: RigPart, drawing: string): string | null => {
  if (part.only && !part.only.includes(drawing)) return null;
  if (typeof part.src === "string") return part.src;
  return part.src[drawing] ?? part.src.neutral ?? null;
};

/** A rig pose, renderer-free. Arms: degrees raised (0 down, 90 out, 180 up). Head: tilt in degrees (+ leans
 * to the card's left as seen), drop in card heights (+ down). Lids 0..1 (closed above 0.5), mouth 0..1. */
export interface RigPose {
  armL: number;
  armR: number;
  head: number;
  headDrop: number;
  lids: number;
  mouth: number;
}

export const RIG_REST: RigPose = { armL: 0, armR: 0, head: 0, headDrop: 0, lids: 0, mouth: 0 };

export interface RigInput {
  tMs: number;
  mode: CreatureMode;
  action: { name: CreatureAction; elapsedMs: number } | null;
  /** Eyelid closure from the blink scheduler. */
  blink: number;
  /** Mouth openness from the visemes (talking). */
  mouth: number;
  gaze: Gaze;
  sleepy: boolean;
}

const bell = (u: number) => Math.sin(Math.PI * clamp(u));
const ramp = (u: number, a: number, b: number) => clamp((u - a) / (b - a));

/** In and out of a held pose: 0 → 1 over the first `inn`, 1 until `out`, back to 0 at the end. */
const hold = (u: number, inn = 0.15, out = 0.85) => (u < inn ? ramp(u, 0, inn) : u > out ? 1 - ramp(u, out, 1) : 1);

const WALK_SWING: readonly Key[] = [
  [0, 14],
  [0.5, -14],
  [0.9, 0],
];
const NOTICE_LIFT: readonly Key[] = [
  [0, 1],
  [0.6, 0],
];
const POKE_TILT: readonly Key[] = [
  [0, 1],
  [0.7, 0],
];
const POKE_SQUINT: readonly Key[] = [
  [0, 1],
  [0.3, 0],
];

export const rigPose = (i: RigInput): RigPose => {
  const t = i.tMs / 1000;
  // At rest: the arms rise a hair with each breath, the head follows the gaze and sways.
  const breathe = Math.sin(t * 1.4) * 1.5;
  const pose: RigPose = {
    armL: 2 + breathe,
    armR: 2 + breathe,
    head: clamp(-i.gaze.yaw * 0.12, -5, 5) + Math.sin(t * 0.5 + 0.7) * 1.2 + (i.sleepy ? 4 : 0),
    headDrop: clamp(-i.gaze.pitch * 0.0004, -0.006, 0.006) + (i.sleepy ? 0.006 : 0),
    lids: i.sleepy ? Math.max(i.blink, 0.6) : i.blink,
    mouth: clamp(i.mouth),
  };

  if (i.mode === "working") {
    // Typing: both arms lift a little and tap, alternating; the head bobs slightly down.
    pose.armL = 8 + Math.max(0, Math.sin(t * 2 * Math.PI * 3)) * 7;
    pose.armR = 8 + Math.max(0, Math.sin(t * 2 * Math.PI * 3 + Math.PI)) * 7;
    pose.head += Math.sin(t * 2 * Math.PI * 0.8) * 1.5;
    pose.headDrop += 0.004;
  } else if (i.mode === "needs_you") {
    // Points up at the person every few seconds ("you have something to look at").
    const u = (t % 4) / 1.6;
    const k = u < 1 ? hold(u, 0.25, 0.75) : 0;
    pose.armR = Math.max(pose.armR, 70 * k);
    pose.head -= 3 * k;
  } else if (!i.sleepy && !i.action) {
    const f = fidgetAt(i.tMs);
    if (f?.kind === "scratch")
      pose.armL = Math.max(
        pose.armL,
        keyed(
          [
            [0.05, 45],
            [0.3, 38],
            [0.45, 45],
            [0.75, 0],
          ],
          f.u,
        ),
      );
    else if (f)
      pose.head +=
        keyed(
          [
            [0.05, 9],
            [0.75, 0],
          ],
          f.u,
        ) * (f.kind === "look_left" ? 1 : -1);
  }

  if (i.action) {
    const u = clamp(i.action.elapsedMs / ACTION_MS[i.action.name]);
    switch (i.action.name) {
      case "wave": {
        const k = hold(u, 0.15, 0.85);
        pose.armR = 120 * k + Math.sin(u * Math.PI * 8) * 18 * k;
        pose.head -= 4 * k;
        break;
      }
      case "cheer": {
        const k = hold(u, 0.12, 0.75);
        pose.armL = 140 * k;
        pose.armR = 140 * k;
        break;
      }
      case "hop":
        pose.armL = Math.max(pose.armL, 35 * bell(u));
        pose.armR = Math.max(pose.armR, 35 * bell(u));
        break;
      case "slump": {
        const k = u < 0.25 ? ramp(u, 0, 0.25) : u < 0.7 ? 1 : 1 - ramp(u, 0.7, 1);
        pose.armL *= 1 - k;
        pose.armR *= 1 - k;
        pose.head += 7 * k;
        pose.headDrop += 0.012 * k;
        pose.lids = Math.max(pose.lids, 0.6 * k);
        break;
      }
      case "nod":
        pose.headDrop += Math.max(0, Math.sin(u * Math.PI * 2)) * 0.01 * bell(u);
        break;
      case "go":
        // A fist pump: up, a little dip, up again, down.
        pose.armR = Math.max(
          pose.armR,
          keyed(
            [
              [0.2, 110],
              [0.45, 80],
              [0.55, 110],
              [0.8, 0],
            ],
            u,
          ),
        );
        pose.head -= keyed(
          [
            [0.2, 4],
            [0.8, 0],
          ],
          u,
        );
        break;
      case "glance":
        // Looks aside and lifts a hand: a small "hey".
        pose.head += keyed(
          [
            [0.08, -9],
            [0.45, -6],
            [0.6, -9],
            [0.8, 0],
          ],
          u,
        );
        pose.armR = Math.max(
          pose.armR,
          keyed(
            [
              [0.25, 50],
              [0.4, 65],
              [0.55, 50],
              [0.8, 0],
            ],
            u,
          ),
        );
        break;
      case "perk":
        // Head up, arms out a little, eyes wide open.
        pose.headDrop -= keyed(
          [
            [0.06, 0.008],
            [0.7, 0],
          ],
          u,
        );
        pose.armL = Math.max(
          pose.armL,
          keyed(
            [
              [0.06, 28],
              [0.7, 0],
            ],
            u,
          ),
        );
        pose.armR = Math.max(
          pose.armR,
          keyed(
            [
              [0.06, 28],
              [0.7, 0],
            ],
            u,
          ),
        );
        if (u < 0.7) pose.lids = 0;
        break;
      case "walk": {
        const swing = keyed(WALK_SWING, u);
        pose.armL += Math.max(0, swing);
        pose.armR += Math.max(0, -swing);
        break;
      }
      case "notice": {
        const k = keyed(NOTICE_LIFT, u);
        pose.head -= 4 * k;
        pose.armL += 10 * k;
        pose.armR += 10 * k;
        break;
      }
      case "poke":
        pose.head += 5 * keyed(POKE_TILT, u);
        pose.lids = Math.max(pose.lids, 0.7 * keyed(POKE_SQUINT, u));
        break;
      case "spin": {
        // Arms out for balance while it turns.
        const k = hold(u, 0.1, 0.85);
        pose.armL = Math.max(pose.armL, 75 * k);
        pose.armR = Math.max(pose.armR, 75 * k);
        break;
      }
      case "giggle": {
        // Eyes squeezed, mouth open, a hand to the mouth.
        const k = hold(u, 0.1, 0.8);
        pose.lids = Math.max(pose.lids, 0.75 * k);
        pose.mouth = Math.max(pose.mouth, 0.6 * k * (0.6 + 0.4 * Math.abs(Math.sin(u * Math.PI * 10))));
        pose.armR = Math.max(pose.armR, 55 * k);
        break;
      }
      case "dizzy": {
        // Head lolls in circles, eyes half shut, arms flop.
        const k = Math.min(1, u / 0.1) * (1 - u);
        pose.head += Math.sin(u * Math.PI * 6) * 8 * k;
        pose.lids = Math.max(pose.lids, 0.5 * k);
        pose.mouth = Math.max(pose.mouth, 0.25 * k);
        pose.armL = 20 * k + Math.sin(u * Math.PI * 6) * 15 * k;
        pose.armR = 20 * k - Math.sin(u * Math.PI * 6) * 15 * k;
        break;
      }
    }
  }
  return pose;
};
