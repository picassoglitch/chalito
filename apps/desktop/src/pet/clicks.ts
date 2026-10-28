import type { CreatureAction } from "@chalito/avatar";

/** What a click does (owner, 2026-10-26): one click a trick, two the dashboard, a burst makes it dizzy. */
export const TRICKS: readonly CreatureAction[] = ["hop", "wave", "cheer", "spin", "giggle"];
/** Two clicks this close are a double click. */
export const DOUBLE_CLICK_MS = 300;
/** This many clicks inside BURST_MS make it dizzy. */
export const BURST_CLICKS = 4;
export const BURST_MS = 2000;

export type ClickResult = "trick" | "dizzy" | null;

/** Single, double and burst clicks. A double opens the dashboard only once no third click follows within
 * DOUBLE_CLICK_MS (`due`): someone clicking fast is playing, not asking for the dashboard. */
export class ClickTracker {
  #recent: number[] = [];
  #last = -Infinity;
  #doubleAt: number | null = null;

  /** A click at `now`: a trick, dizzy, or null when it may be the second half of a double click. */
  click(now: number): ClickResult {
    const prev = this.#last;
    this.#last = now;
    this.#recent = this.#recent.filter((t) => now - t < BURST_MS);
    this.#recent.push(now);
    if (this.#recent.length >= BURST_CLICKS) {
      // A click right after the dizzy starts over: it can't pair with the burst's last click into a double.
      this.#recent = [];
      this.#doubleAt = null;
      this.#last = -Infinity;
      return "dizzy";
    }
    if (this.#doubleAt !== null) {
      this.#doubleAt = null;
      return "trick";
    }
    if (now - prev < DOUBLE_CLICK_MS) {
      this.#doubleAt = now;
      return null;
    }
    return "trick";
  }

  /** True once, when a double click stood alone long enough to count. */
  due(now: number): boolean {
    if (this.#doubleAt === null || now - this.#doubleAt < DOUBLE_CLICK_MS) return false;
    this.#doubleAt = null;
    return true;
  }
}

/** A trick other than the last one. */
export const pickTrick = (last: CreatureAction | null, rand: () => number): CreatureAction => {
  const pool = TRICKS.filter((t) => t !== last);
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]!;
};
