import type { CreatureAction } from "@chalito/avatar";

/** What a click does (owner, 2026-10-26): one click a trick, two the dashboard, a burst makes it dizzy. */
export const TRICKS: readonly CreatureAction[] = ["hop", "wave", "cheer", "spin", "giggle"];
/** Two clicks this close are a double click. */
export const DOUBLE_CLICK_MS = 300;
/** This many clicks inside BURST_MS make it dizzy. */
export const BURST_CLICKS = 4;
export const BURST_MS = 2000;

/** What a click returns at once: dizzy, or a trick for a third quick click; null while it may still pair. */
export type ClickResult = "trick" | "dizzy" | null;
/** What a settled click turns into once the double-click window has passed (`due`). */
export type Settled = "trick" | "dashboard" | null;

/** Single, double and burst clicks. A lone click's trick waits out DOUBLE_CLICK_MS, so a double click
 * opens the dashboard without a trick first; a third quick click means play, not the dashboard. */
export class ClickTracker {
  #recent: number[] = [];
  /** The click waiting for its window: a single (maybe silent: it only woke the pet) or a double. */
  #pending: { kind: "single" | "silent" | "double"; at: number } | null = null;

  /** A click at `now`. `silent`: it woke the pet, so on its own it plays nothing, but it can still pair. */
  click(now: number, silent = false): ClickResult {
    this.#recent = this.#recent.filter((t) => now - t < BURST_MS);
    this.#recent.push(now);
    if (this.#recent.length >= BURST_CLICKS) {
      this.#recent = [];
      this.#pending = null;
      return "dizzy";
    }
    const p = this.#pending;
    if (p && now - p.at < DOUBLE_CLICK_MS) {
      if (p.kind === "double") {
        this.#pending = null;
        return "trick";
      }
      this.#pending = { kind: "double", at: now };
      return null;
    }
    this.#pending = { kind: silent ? "silent" : "single", at: now };
    return null;
  }

  /** Once per settled click, when its window has passed: a trick, the dashboard, or nothing. */
  due(now: number): Settled {
    const p = this.#pending;
    if (!p || now - p.at < DOUBLE_CLICK_MS) return null;
    this.#pending = null;
    return p.kind === "double" ? "dashboard" : p.kind === "single" ? "trick" : null;
  }
}

/** A trick other than the last one. */
export const pickTrick = (last: CreatureAction | null, rand: () => number): CreatureAction => {
  const pool = TRICKS.filter((t) => t !== last);
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]!;
};
