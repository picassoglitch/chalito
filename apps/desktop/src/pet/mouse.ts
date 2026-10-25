import type { Gaze } from "@chalito/avatar";
import type { Rect } from "../lib/hitbox.js";

/** How far (CSS px) a press must travel before it's a drag instead of a click. */
export const DRAG_THRESHOLD_PX = 4;

export const pastThreshold = (
  from: { x: number; y: number },
  to: { x: number; y: number },
  threshold = DRAG_THRESHOLD_PX,
): boolean => Math.hypot(to.x - from.x, to.y - from.y) > threshold;

/** One press on the character: a click if it lifts in place, a drag once it moves past the threshold. */
export class PressTracker {
  #from: { x: number; y: number } | null = null;
  #dragged = false;

  constructor(readonly threshold = DRAG_THRESHOLD_PX) {}

  down(x: number, y: number): void {
    this.#from = { x, y };
    this.#dragged = false;
  }

  /** "drag" exactly once per press, when it first passes the threshold. */
  move(x: number, y: number): "drag" | null {
    if (!this.#from || this.#dragged || !pastThreshold(this.#from, { x, y }, this.threshold)) return null;
    this.#dragged = true;
    return "drag";
  }

  up(): "click" | null {
    const click = this.#from !== null && !this.#dragged;
    this.#from = null;
    this.#dragged = false;
    return click ? "click" : null;
  }

  cancel(): void {
    this.#from = null;
    this.#dragged = false;
  }
}

/** Head and eye limits for following the cursor: a glance, never a full turn. */
export const GAZE_LIMIT = { yaw: 30, pitch: 18 };
/** A virtual distance (logical px) from the screen to the pet's eyes: larger = calmer turns. */
const EYE_DEPTH_PX = 500;

const clamp = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v));
const deg = (rad: number) => (rad * 180) / Math.PI;

/** Where the eyes sit in a hit box: centred, a third of the way down. */
export const eyePoint = (hit: Rect): { x: number; y: number } => ({
  x: hit.x + hit.width / 2,
  y: hit.y + hit.height * 0.3,
});

/** The global cursor (physical px) → a gaze in degrees (+yaw right, +pitch up), capped. */
export const cursorGaze = (cursor: { x: number; y: number }, eye: { x: number; y: number }, scale: number): Gaze => {
  const s = scale > 0 ? scale : 1;
  const dx = (cursor.x - eye.x) / s;
  const up = (eye.y - cursor.y) / s;
  return {
    yaw: clamp(deg(Math.atan2(dx, EYE_DEPTH_PX)), GAZE_LIMIT.yaw),
    pitch: clamp(deg(Math.atan2(up, EYE_DEPTH_PX)), GAZE_LIMIT.pitch),
  };
};

/** Follows the cursor while it moves; once it rests this long, the gaze drifts back to centre. */
export const FOLLOW_MS = 4000;
export const FOLLOW_FADE_MS = 1500;

/** 1 while the cursor moved recently, fading to 0 so the gaze drifts back to the idle saccades. */
export const followWeight = (msSinceMove: number): number => {
  if (msSinceMove <= FOLLOW_MS) return 1;
  return Math.max(0, 1 - (msSinceMove - FOLLOW_MS) / FOLLOW_FADE_MS);
};

export const scaleGaze = (g: Gaze, w: number): Gaze => ({ yaw: g.yaw * w, pitch: g.pitch * w });

/** How long the cursor must rest on the character before it notices, and the gaps between reactions. */
export const HOVER_DWELL_MS = 250;
export const NOTICE_COOLDOWN_MS = 20_000;
export const POKE_COOLDOWN_MS = 1200;

/** Hover and poke reactions with cooldowns, so a busy mouse doesn't make it twitch. */
export class Reactions {
  #hoverSince: number | null = null;
  #noticedThisHover = false;
  #lastNotice = -Infinity;
  #lastPoke = -Infinity;

  /** Call every frame with whether the cursor is over the character; true = play the notice. */
  hover(over: boolean, now: number, allowed = true): boolean {
    if (!over) {
      this.#hoverSince = null;
      this.#noticedThisHover = false;
      return false;
    }
    this.#hoverSince ??= now;
    if (!allowed || this.#noticedThisHover || now - this.#hoverSince < HOVER_DWELL_MS) return false;
    if (now - this.#lastNotice < NOTICE_COOLDOWN_MS) return false;
    this.#noticedThisHover = true;
    this.#lastNotice = now;
    return true;
  }

  /** A click on the character; true = play the poke (the click itself always counts). */
  poke(now: number): boolean {
    if (now - this.#lastPoke < POKE_COOLDOWN_MS) return false;
    this.#lastPoke = now;
    // A poke is already a reaction: no notice right after it in the same hover.
    this.#noticedThisHover = true;
    return true;
  }
}
