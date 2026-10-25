import type { BehaviourState, CreatureMode } from "@chalito/avatar";
import type { Rect } from "../lib/hitbox.js";

/** Distances in LOGICAL px (times the screen's scale), times in ms. */
export const WALK = {
  firstAfterMs: 90_000,
  gapMinMs: 60_000,
  gapMaxMs: 180_000,
  /** The person just put it somewhere: leave it there a while. */
  afterPersonMs: 300_000,
  stepMin: 60,
  stepMax: 180,
  /** How far from where it was put (or launched) it may wander. */
  roam: 240,
  speedPxPerS: 45,
};

export interface WalkGate {
  enabled: boolean;
  state: BehaviourState;
  activity: CreatureMode | null;
  fullscreen: boolean;
  dnd: boolean;
  quietHours: boolean;
  dragging: boolean;
  hovering: boolean;
  /** A finish hop or failure slump is playing. */
  acting: boolean;
  onFloor: boolean;
}

/** Only a calm pet standing on the taskbar walks: nothing pending, no AI busy, nobody holding it. */
export const mayWalk = (g: WalkGate): boolean =>
  g.enabled &&
  (g.state === "idle" || g.state === "tired") &&
  (g.activity === null || g.activity === "rest") &&
  !g.fullscreen &&
  !g.dnd &&
  !g.quietHours &&
  !g.dragging &&
  !g.hovering &&
  !g.acting &&
  g.onFloor;

/** Whether the window's bottom sits on the work area's bottom (the taskbar or dock). */
export const onFloor = (win: Rect, work: Rect, tolerancePx: number): boolean =>
  Math.abs(win.y + win.height - (work.y + work.height)) <= tolerancePx;

/** The x range a window of this width can take inside a work area. */
export const xBounds = (work: Rect, width: number): { min: number; max: number } => ({
  min: work.x,
  max: Math.max(work.x, work.x + work.width - width),
});

/** A short walk's goal: a random step, turned back at the roam range or the screen's edge. */
export const pickTarget = (
  x: number,
  home: number,
  bounds: { min: number; max: number },
  rand: () => number,
  scale = 1,
  cfg = WALK,
): number => {
  const lo = Math.max(bounds.min, Math.min(bounds.max, home - cfg.roam * scale));
  const hi = Math.min(bounds.max, Math.max(bounds.min, home + cfg.roam * scale));
  const dist = (cfg.stepMin + rand() * (cfg.stepMax - cfg.stepMin)) * scale;
  const dir = x - dist < lo ? 1 : x + dist > hi ? -1 : rand() < 0.5 ? -1 : 1;
  const inRange = Math.max(lo, Math.min(hi, x + dir * dist));
  // Outside its range (put elsewhere, screens changed) it heads back one step at a time, never a long trek.
  return Math.round(Math.max(x - dist, Math.min(x + dist, inRange)));
};

/** How long a walk from `from` to `to` takes. */
export const walkMs = (from: number, to: number, scale = 1, cfg = WALK): number =>
  (Math.abs(to - from) / (cfg.speedPxPerS * scale)) * 1000;

/** Where a walk from `from` to `to` is after `elapsedMs`, and whether it arrived. */
export const walkAt = (
  from: number,
  to: number,
  elapsedMs: number,
  scale = 1,
  cfg = WALK,
): { x: number; done: boolean } => {
  const travelled = (Math.max(0, elapsedMs) / 1000) * cfg.speedPxPerS * scale;
  const dist = Math.abs(to - from);
  if (travelled >= dist) return { x: to, done: true };
  return { x: Math.round(from + Math.sign(to - from) * travelled), done: false };
};

/** When the next walk may start: not soon after launch, between walks, or after the person moved it. */
export class WalkPlanner {
  #nextAt: number;

  constructor(
    readonly rand: () => number,
    startedAt: number,
    readonly cfg = WALK,
  ) {
    this.#nextAt = startedAt + cfg.firstAfterMs;
  }

  get nextAt(): number {
    return this.#nextAt;
  }

  personMoved(now: number): void {
    this.#nextAt = Math.max(this.#nextAt, now + this.cfg.afterPersonMs);
  }

  /** A target x to walk to now, or null. Starting (or finding no room) waits a gap before the next. */
  plan(
    now: number,
    gate: WalkGate,
    x: number,
    home: number,
    bounds: { min: number; max: number },
    scale = 1,
  ): number | null {
    if (now < this.#nextAt || !mayWalk(gate)) return null;
    const gap = this.cfg.gapMinMs + this.rand() * (this.cfg.gapMaxMs - this.cfg.gapMinMs);
    this.#nextAt = now + gap;
    const target = pickTarget(x, home, bounds, this.rand, scale, this.cfg);
    return Math.abs(target - x) >= 2 ? target : null;
  }
}
