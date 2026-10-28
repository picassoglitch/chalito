import type { Activity, CreatureMode, NoticeLike, SessionLike } from "@chalito/avatar";
import type { Level } from "@chalito/protocol";
import { IpcUnavailableError, type AgentIpc, type OwnSessionView } from "./ipc.js";

// Sessions the person started outside Chalito, observed from local transcripts (owner, 2026-10-25).
// Only their derived state reaches the pet and the panel; none of it is sent to the account.

export interface OwnSnapshot {
  /** null: the agent didn't answer (not running, or an older agent without the watch). */
  enabled: boolean | null;
  sessions: readonly OwnSessionView[];
  /** The last read failed for another reason (e.g. an older agent): what's shown may be stale. */
  error: string | null;
}

const MIN_REFRESH_MS = 3_000;

const STATE: Record<OwnSessionView["state"], string> = {
  working: "running",
  question: "waiting_input",
  approval: "waiting_approval",
  error: "failed",
  finished: "completed",
  // Not a protocol state: the pet neither celebrates nor mourns a closed terminal.
  closed: "closed",
};

const RANK: Record<Level, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

/** One alert per state change: "Visto" hides it until the session asks again. */
export const alertId = (v: Pick<OwnSessionView, "key" | "since">): string => `own:${v.key}:${v.since}`;

/** What the pet's ActivityTracker sees: the protocol's session states, so the reactions are the same ones. */
export const ownSessionLikes = (views: readonly OwnSessionView[]): SessionLike[] =>
  views.map((v) => ({
    sid: `own:${v.key}`,
    // Codex's own reviewer is on it: busy, not waiting on the person.
    state: v.reviewing ? "running" : STATE[v.state],
    updatedAt: v.since,
  }));

export const ownNotices = (views: readonly OwnSessionView[], seen: ReadonlySet<string>): NoticeLike[] =>
  views
    .filter((v) => v.level !== null && !seen.has(alertId(v)))
    .map((v) => ({ nid: alertId(v), state: "pending", createdAt: v.since }));

/** The highest level among observed alerts not yet marked seen; never above L3. */
export const ownLevel = (views: readonly OwnSessionView[], seen: ReadonlySet<string>): Level | null => {
  let best: Level | null = null;
  for (const v of views)
    if (v.level && !seen.has(alertId(v)) && (best === null || RANK[v.level] > RANK[best])) best = v.level;
  return best;
};

export const maxLevel = (a: Level | null, b: Level | null): Level | null =>
  a === null ? b : b === null ? a : RANK[a] >= RANK[b] ? a : b;

const MODE: Record<CreatureMode, number> = { rest: 0, working: 1, needs_you: 2 };

/** Chalito's sessions and the observed ones, each from its own tracker: counts add up, the busier mode wins. */
export const mergeActivity = (a: Activity, b: Activity): Activity => ({
  mode: MODE[b.mode] > MODE[a.mode] ? b.mode : a.mode,
  done: a.done + b.done,
  failed: a.failed + b.failed,
  started: a.started + b.started,
  messages: a.messages + b.messages,
  alerts: a.alerts + b.alerts,
});

/** The ~/.codex/hooks.json entry the person pastes themselves; Chalito never edits ~/.codex. */
export const codexHookSnippet = (command: string | null): string => {
  const bin = command && /\s/.test(command) ? `"${command}"` : (command ?? "chalito");
  const entry = [{ hooks: [{ type: "command", command: `${bin} watch-hook codex`, timeout: 5 }] }];
  return JSON.stringify({ hooks: { PermissionRequest: entry, PostToolUse: entry } }, null, 2);
};

/** The panel's one read of the watch: the pet tick refreshes it, the cards and settings subscribe. */
export class OwnSessionsFeed {
  #snap: OwnSnapshot = { enabled: null, sessions: [], error: null };
  #seen = new Set<string>();
  #subs = new Set<() => void>();
  #at = -Infinity;
  #seq = 0;

  constructor(
    private readonly ipc: Pick<AgentIpc, "ownSessions">,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.#subs.add(fn);
    return () => void this.#subs.delete(fn);
  };

  getSnapshot = (): OwnSnapshot => this.#snap;

  get seen(): ReadonlySet<string> {
    return this.#seen;
  }

  /** Live-store updates tick the pet often; a read younger than MIN_REFRESH_MS is reused unless forced. */
  async refresh(force = false): Promise<OwnSnapshot> {
    const now = this.now();
    if (!force && now - this.#at < MIN_REFRESH_MS) return this.#snap;
    this.#at = now;
    // Replies can come back out of order; only the newest read (or toggle) may land.
    const n = ++this.#seq;
    try {
      const r = await this.ipc.ownSessions();
      if (n !== this.#seq) return this.#snap;
      this.#set({ enabled: r.enabled, sessions: r.sessions, error: null }, true);
    } catch (e) {
      if (n !== this.#seq) return this.#snap;
      // Only a missing agent means "unknown"; any other failure keeps what the person last saw and its toggle.
      if (e instanceof IpcUnavailableError) this.#set({ enabled: null, sessions: [], error: null }, true);
      else this.#set({ ...this.#snap, error: e instanceof Error ? e.message : "internal" }, false);
    }
    return this.#snap;
  }

  /** The agent confirmed a toggle: show it now, even if the next read fails. */
  confirmed(enabled: boolean): void {
    this.#seq++;
    this.#set({ ...this.#snap, enabled, ...(enabled ? {} : { sessions: [] }) }, true);
  }

  markSeen(v: Pick<OwnSessionView, "key" | "since">): void {
    this.#seen.add(alertId(v));
    this.#set({ ...this.#snap }, false);
  }

  #set(s: OwnSnapshot, prune: boolean): void {
    if (prune) {
      const live = new Set(s.sessions.map(alertId));
      for (const id of this.#seen) if (!live.has(id)) this.#seen.delete(id);
    }
    this.#snap = s;
    for (const fn of this.#subs) fn();
  }
}
