import type { CreatureMode } from "./actions.js";

/** What the person's AI sessions are doing, as the companion shows it (owner, 2026-10-19 and 2026-10-25).
 * Session states are the protocol's (`starting`, `running`, `waiting_approval`, …). */
export interface SessionLike {
  sid: string;
  state?: string;
  /** Epoch ms of the last change; a session first seen with an older (or no) date isn't news. */
  updatedAt?: number;
}

/** A session event (the live store's EventView): only stored `message.assistant` rows count as messages. */
export interface EventLike {
  eid: string;
  /** Epoch ms (the agent's clock). */
  t: number;
  type: string;
  /** Came over the live path only (never a stored reply). */
  live?: boolean;
}

/** A notification (the live store's NotificationView): a new pending one is an agent alert. */
export interface NoticeLike {
  nid: string;
  state: string;
  createdAt?: number;
}

export interface Activity {
  mode: CreatureMode;
  /** Counts since the tracker started (only ever go up): finished, failed and started sessions,
   * agent replies and new alerts. */
  done: number;
  failed: number;
  started: number;
  messages: number;
  alerts: number;
}

export interface ActivitySources {
  /** By sid, as the live store keeps them. */
  events?: Readonly<Record<string, readonly EventLike[]>>;
  notifications?: readonly NoticeLike[];
  /** Wall clock (ms); defaults to Date.now(). */
  now?: number;
  /** The data is still loading: learn it, count nothing yet. */
  learning?: boolean;
}

/** The one-off moves activity can call for, most important first. */
export type ActivityAction = "slump" | "hop" | "go" | "glance" | "perk";

const BUSY = new Set(["starting", "running"]);
const WAITING = new Set(["waiting_approval", "waiting_input"]);

/** Counts changes it sees, each item once. The first update only learns what's there, and what shows
 * up later dated before it (data still loading) isn't news either: nothing old is celebrated again. */
export class ActivityTracker {
  #seen = new Map<string, string | undefined>();
  /** By sid, the stored replies already seen (ids, not seqs: rows can land out of order). */
  #replies = new Map<string, Set<string>>();
  #notices = new Set<string>();
  #primedAt: number | null = null;
  #done = 0;
  #failed = 0;
  #started = 0;
  #messages = 0;
  #alerts = 0;

  update(sessions: readonly SessionLike[], pendingAnswers: number, src: ActivitySources = {}): Activity {
    const primedAt = src.learning ? null : this.#primedAt;
    // The live store maps a missing date to 0 or NaN: not news.
    const fresh = (at: number | undefined) => primedAt !== null && at !== undefined && at >= primedAt;
    for (const s of sessions) {
      const known = this.#seen.has(s.sid);
      const before = this.#seen.get(s.sid);
      if (known ? primedAt !== null && before !== s.state : fresh(s.updatedAt)) {
        if (s.state === "completed") this.#done++;
        else if (s.state === "failed") this.#failed++;
        // Back from waiting on the person is the same task going on, not a new one.
        else if (BUSY.has(s.state ?? "") && !BUSY.has(before ?? "") && !WAITING.has(before ?? "")) this.#started++;
      }
      this.#seen.set(s.sid, s.state);
    }
    for (const [sid, events] of Object.entries(src.events ?? {})) {
      const seen = this.#replies.get(sid);
      const replies = events.filter((e) => e.type === "message.assistant" && !e.live);
      // A session whose history loads later counts only replies written since the tracker started.
      this.#messages += replies.filter((e) => (seen ? !seen.has(e.eid) : fresh(e.t))).length;
      if (replies.length) this.#replies.set(sid, new Set([...(seen ?? []), ...replies.map((e) => e.eid)]));
    }
    for (const n of src.notifications ?? []) {
      if (this.#notices.has(n.nid)) continue;
      this.#notices.add(n.nid);
      if (n.state === "pending" && fresh(n.createdAt)) this.#alerts++;
    }
    if (!src.learning) this.#primedAt ??= src.now ?? Date.now();
    const waiting = pendingAnswers > 0 || sessions.some((s) => WAITING.has(s.state ?? ""));
    const busy = sessions.some((s) => BUSY.has(s.state ?? ""));
    return {
      mode: waiting ? "needs_you" : busy ? "working" : "rest",
      done: this.#done,
      failed: this.#failed,
      started: this.#started,
      messages: this.#messages,
      alerts: this.#alerts,
    };
  }
}

/** The one-off moves an activity change calls for, most important first. */
export const activityActions = (before: Activity | null, now: Activity): ActivityAction[] => {
  if (!before) return [];
  const out: ActivityAction[] = [];
  if (now.failed > before.failed) out.push("slump");
  if (now.done > before.done) out.push("hop");
  if (now.started > before.started) out.push("go");
  if (now.alerts > before.alerts) out.push("glance");
  if (now.messages > before.messages) out.push("perk");
  return out;
};
