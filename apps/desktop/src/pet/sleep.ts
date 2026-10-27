/** It dozes off when the person is away, not by the clock (owner, 2026-10-26). Idle = no input on the computer. */
export const DROWSY_AFTER_MS = 5 * 60_000;
export const AWAY_AFTER_MS = 15 * 60_000;
/** How often the pet asks the OS for idle time. */
export const IDLE_POLL_MS = 2000;

export type Rest = "awake" | "drowsy" | "away";

export const restFromIdle = (idleMs: number): Rest =>
  idleMs >= AWAY_AFTER_MS ? "away" : idleMs >= DROWSY_AFTER_MS ? "drowsy" : "awake";

/** True when the person came back: it was drowsy or asleep and now isn't. */
export const wokeUp = (before: Rest, now: Rest): boolean => before !== "awake" && now === "awake";
