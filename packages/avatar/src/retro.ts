import { clamp, easeOutCubic } from "./math.js";

/** Retro motion (owner, 2026-10-25): poses step at 10 fps, held then snapped, not tweened. 100 ms is a
 * whole number of frames at the 30 and 60 FPS caps, so holds stay even. */
export const RETRO_HOLD_MS = 100;

/** The start of the hold `now` falls in. A fixed grid, so the same `now` always gives the same pose. */
export const steppedTime = (now: number, holdMs = RETRO_HOLD_MS): number =>
  holdMs > 0 && Number.isFinite(now) ? Math.floor(now / holdMs) * holdMs : now;

export interface Held<T> {
  /** steppedTime of the hold the value was taken in. */
  slot: number;
  value: T;
}

/** Sample-and-hold: keeps `held` while `now` is in the same hold, then takes `next`. */
export const holdPose = <T>(held: Held<T> | null, now: number, next: T, holdMs = RETRO_HOLD_MS): Held<T> => {
  const slot = steppedTime(now, holdMs);
  return held && held.slot === slot ? held : { slot, value: next };
};

/** A key pose for one channel: from `t` (0..1 along the move) the channel heads to `v`. */
export type Key = readonly [t: number, v: number];

/** Snappy key poses: each key is reached within `snap` (of the move), then held. Before the first
 * key the channel is 0 (rest), so a move whose last key is 0 starts and ends at rest. */
export const keyed = (keys: readonly Key[], u: number, snap = 0.06): number => {
  let from = 0;
  let to = 0;
  let start = 0;
  for (const [t, v] of keys) {
    if (u < t) break;
    from = to;
    to = v;
    start = t;
  }
  return from + (to - from) * easeOutCubic(clamp((u - start) / Math.max(1e-6, snap)));
};
