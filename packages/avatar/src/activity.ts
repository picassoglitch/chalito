import type { CreatureAction, CreatureMode } from "./actions.js";

/**
 * What the person's AI sessions are doing, as the companion shows it (owner decision 2026-10-19):
 * busy while one runs, leaning in while an answer waits, a hop when one finishes, a slump when one
 * fails. Session states are the protocol's (`starting`, `running`, `waiting_approval`, …).
 */
export interface SessionLike {
  sid: string;
  state?: string;
}

export interface Activity {
  mode: CreatureMode;
  /** Sessions that finished / failed since the tracker started (only ever go up). */
  done: number;
  failed: number;
}

const BUSY = new Set(["starting", "running"]);
const WAITING = new Set(["waiting_approval", "waiting_input"]);

/**
 * Counts finishes and failures from state changes it sees. The first snapshot only learns the
 * states (a session that finished before the app opened isn't celebrated again).
 */
export class ActivityTracker {
  #seen = new Map<string, string | undefined>();
  #primed = false;
  #done = 0;
  #failed = 0;

  update(sessions: readonly SessionLike[], pendingAnswers: number): Activity {
    for (const s of sessions) {
      const before = this.#seen.get(s.sid);
      if (this.#primed && before !== s.state) {
        if (s.state === "completed") this.#done++;
        else if (s.state === "failed") this.#failed++;
      }
      this.#seen.set(s.sid, s.state);
    }
    this.#primed = true;
    const waiting = pendingAnswers > 0 || sessions.some((s) => WAITING.has(s.state ?? ""));
    const busy = sessions.some((s) => BUSY.has(s.state ?? ""));
    return { mode: waiting ? "needs_you" : busy ? "working" : "rest", done: this.#done, failed: this.#failed };
  }
}

/** The one-off actions an activity change calls for (a finish, then a failure, in that order). */
export const activityActions = (before: Activity | null, now: Activity): CreatureAction[] => {
  if (!before) return [];
  const out: CreatureAction[] = [];
  if (now.done > before.done) out.push("hop");
  if (now.failed > before.failed) out.push("slump");
  return out;
};
