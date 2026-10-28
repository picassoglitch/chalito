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

/** One idle poll at a time, and only the latest one's reply counts: a hung desktop can't stack polls,
 * and a slow reply landing after a click or a drag woke the pet can't put it back to sleep. */
export class IdlePoll {
  #seq = 0;
  /** The token of the poll still out, if any. */
  #out: number | null = null;

  /** A token for a new poll, or null while one is still out. */
  start(): number | null {
    if (this.#out !== null) return null;
    this.#out = ++this.#seq;
    return this.#out;
  }

  /** The poll for `token` came back (or failed): true when its answer still counts. */
  land(token: number): boolean {
    if (token === this.#out) this.#out = null;
    return token === this.#seq;
  }

  /** Something woke the pet: the reply still out is stale. The next poll waits for it to land. */
  invalidate(): void {
    this.#seq++;
  }
}
