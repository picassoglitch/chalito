import { clamp, easeInOutCubic, easeOutCubic, rng } from "./math.js";
import type { CreaturePose } from "./gestures.js";
import { keyed } from "./retro.js";

/** Movement only shows something (owner 2026-10-19): a mode lasts while true (an AI busy, an answer
 * waiting); an action plays once (hop = done, slump = failed, go = started, glance = alert, perk = message). */
export type CreatureMode = "rest" | "working" | "needs_you";
export type CreatureAction = "hop" | "slump" | "wave" | "cheer" | "nod" | "go" | "glance" | "perk";

export const CREATURE_ACTIONS: readonly CreatureAction[] = [
  "hop",
  "slump",
  "wave",
  "cheer",
  "nod",
  "go",
  "glance",
  "perk",
];

export const ACTION_MS: Record<CreatureAction, number> = {
  hop: 700,
  slump: 2600,
  wave: 2000,
  cheer: 1400,
  nod: 900,
  go: 900,
  glance: 1300,
  perk: 800,
};

/** A layer over the rest pose: offsets add, scale multiplies, tilt adds (degrees). */
export interface CreatureLayer {
  offsetY: number;
  scale: readonly [number, number, number];
  tilt: readonly [number, number, number];
}

const NONE: CreatureLayer = { offsetY: 0, scale: [1, 1, 1], tilt: [0, 0, 0] };

/** Squash (s < 1) or stretch (s > 1) that keeps the volume. */
const squash = (s: number): readonly [number, number, number] => {
  const w = 1 / Math.sqrt(s);
  return [w, s, w];
};

/** 0 → 1 → 0 over u in 0..1 (a bell). */
const bell = (u: number) => Math.sin(Math.PI * clamp(u));

/** How many "hey" bounces needs_you makes when it starts; after them it only leans in. */
export const NEEDS_YOU_BOUNCES = 2;

/** A mode's layer `tMs` after it started: `working` leans in busily, `needs_you` leans toward the
 * person after a couple of bounces, never jumping the whole wait (owner, 2026-10-25). */
export const modeLayer = (mode: CreatureMode, tMs: number): CreatureLayer => {
  const t = tMs / 1000;
  switch (mode) {
    case "working": {
      const beat = Math.sin(t * 2 * Math.PI * 1.6);
      return { offsetY: -0.004 + Math.abs(beat) * 0.003, scale: squash(1 - Math.abs(beat) * 0.006), tilt: [4, 0, 0] };
    }
    case "needs_you": {
      // One small bounce (0.45 s) every 3.2 s, only the first few.
      const u = (t % 3.2) / 0.45;
      const b = u < 1 && t < 3.2 * NEEDS_YOU_BOUNCES ? bell(u) : 0;
      return { offsetY: b * 0.025, scale: squash(1 + b * 0.03), tilt: [-3, 0, Math.sin(t * 1.3) * 2] };
    }
    default:
      return NONE;
  }
};

/** An action's layer `elapsed` ms after it started; `done` once it's over (then it's NONE). */
export const actionLayer = (action: CreatureAction, elapsedMs: number): CreatureLayer & { done: boolean } => {
  const dur = ACTION_MS[action];
  if (elapsedMs >= dur || elapsedMs < 0) return { ...NONE, done: elapsedMs >= dur };
  const u = elapsedMs / dur;
  switch (action) {
    case "hop": {
      // Crouch (squash), spring up (stretch), land (squash), settle.
      if (u < 0.2) return { offsetY: 0, scale: squash(1 - 0.08 * easeOutCubic(u / 0.2)), tilt: [0, 0, 0], done: false };
      if (u < 0.75) {
        const k = (u - 0.2) / 0.55;
        return { offsetY: bell(k) * 0.12, scale: squash(1 + 0.06 * bell(k)), tilt: [0, 0, 0], done: false };
      }
      const k = (u - 0.75) / 0.25;
      return { offsetY: 0, scale: squash(1 - 0.06 * bell(k)), tilt: [0, 0, 0], done: false };
    }
    case "slump": {
      // Sinks and droops, holds, then slowly recovers.
      const env = u < 0.25 ? easeInOutCubic(u / 0.25) : u < 0.7 ? 1 : 1 - easeInOutCubic((u - 0.7) / 0.3);
      return { offsetY: -0.02 * env, scale: squash(1 - 0.07 * env), tilt: [8 * env, 0, -4 * env], done: false };
    }
    case "cheer": {
      const k = Math.min(1, u / 0.6);
      return { offsetY: bell(k) * 0.08, scale: squash(1 + 0.05 * bell(k)), tilt: [-4 * bell(u), 0, 0], done: false };
    }
    case "wave":
      return { offsetY: 0, scale: [1, 1, 1], tilt: [0, 0, Math.sin(u * Math.PI * 6) * 2 * bell(u)], done: false };
    case "nod":
      return { offsetY: 0, scale: [1, 1, 1], tilt: [Math.sin(u * Math.PI * 2) * 6 * bell(u), 0, 0], done: false };
    case "go": {
      // Crouch, pop up leaning forward, hold, settle; it barely leaves the ground (the finish owns the hop).
      const s = keyed(
        [
          [0, -0.06],
          [0.2, 0.05],
          [0.55, 0.02],
          [0.8, 0],
        ],
        u,
      );
      const lean = keyed(
        [
          [0.2, 7],
          [0.55, 4],
          [0.8, 0],
        ],
        u,
      );
      return { offsetY: Math.max(0, s) * 0.2, scale: squash(1 + s), tilt: [lean, 0, 0], done: false };
    }
    case "glance": {
      // A sideways look held a beat, a second look, back.
      const side = keyed(
        [
          [0.08, 6],
          [0.45, 4],
          [0.6, 6],
          [0.8, 0],
        ],
        u,
      );
      return { offsetY: 0, scale: [1, 1, 1], tilt: [-side / 3, 0, side], done: false };
    }
    case "perk": {
      // Stretches up, leaning back as if it heard something, then settles.
      const s = keyed(
        [
          [0.06, 0.06],
          [0.45, 0.03],
          [0.7, 0],
        ],
        u,
      );
      return { offsetY: 0, scale: squash(1 + s), tilt: [-s * 70, 0, 0], done: false };
    }
  }
};

/** At rest it looks around or fidgets now and then (owner, 2026-10-25): alive, never a jump. */
export const FIDGET_EVERY_MS = 11_000;
export const FIDGET_MS = 1600;
export type Fidget = "look_left" | "look_right" | "scratch";
const FIDGETS: readonly Fidget[] = ["look_left", "look_right", "scratch"];

/** The fidget playing `tMs` in (one per FIDGET_EVERY_MS, at a seeded moment) and how far in, or null. */
export const fidgetAt = (tMs: number): { kind: Fidget; u: number } | null => {
  const n = Math.floor(tMs / FIDGET_EVERY_MS);
  const r = rng(0x5eed + n);
  const start = n * FIDGET_EVERY_MS + r() * (FIDGET_EVERY_MS - FIDGET_MS);
  const u = (tMs - start) / FIDGET_MS;
  if (!(u >= 0 && u < 1)) return null;
  return { kind: FIDGETS[Math.floor(r() * FIDGETS.length)]!, u };
};

/** The body's part of a fidget: a small tilt toward where it looks. */
export const fidgetLayer = (tMs: number): CreatureLayer => {
  const f = fidgetAt(tMs);
  if (!f || f.kind === "scratch") return NONE;
  const side =
    keyed(
      [
        [0.05, 3],
        [0.75, 0],
      ],
      f.u,
    ) * (f.kind === "look_left" ? 1 : -1);
  return { offsetY: 0, scale: [1, 1, 1], tilt: [0, 0, side] };
};

/** The rest pose with a mode and an action on top. */
export const composeCreature = (rest: CreaturePose, layers: readonly CreatureLayer[]): CreaturePose => {
  let offsetY = rest.offsetY;
  let scale: [number, number, number] = [...rest.scale];
  let tilt: [number, number, number] = [...rest.tilt];
  for (const l of layers) {
    offsetY += l.offsetY;
    scale = [scale[0] * l.scale[0], scale[1] * l.scale[1], scale[2] * l.scale[2]];
    tilt = [tilt[0] + l.tilt[0], tilt[1] + l.tilt[1], tilt[2] + l.tilt[2]];
  }
  return { ...rest, offsetY, scale, tilt };
};
