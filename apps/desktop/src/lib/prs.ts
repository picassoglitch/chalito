import type { Activity } from "@chalito/avatar";

/** The agent's PR watch (apps/agent/src/prs/watch.ts `PrWatchView`), as the panel reads it. */
export type PrEventKind = "approved" | "changes_requested" | "comments" | "ci_failed" | "ci_passed" | "merged";
export type PrWatchState = "off" | "starting" | "ok" | "gh_missing" | "logged_out" | "error";

export interface PrStatusView {
  repo: string;
  number: number;
  url: string;
  title: string;
  branch: string;
  draft: boolean;
  review: "approved" | "changes_requested" | "review_required" | null;
  ci: "passing" | "failing" | "pending" | null;
  comments: number;
}

export interface PrEventView {
  repo: string;
  number: number;
  url: string;
  title: string;
  kind: PrEventKind;
  key: string;
  by?: string;
  comments?: number;
  seenAt: number;
  session: { sid: string; label: string } | null;
}

export interface PrWatchView {
  enabled: boolean;
  state: PrWatchState;
  login: string | null;
  checkedAt: number | null;
  allow: string[];
  deny: string[];
  prs: PrStatusView[];
  events: PrEventView[];
  gh: "ready" | "missing" | "logged_out" | null;
}

export interface PrWatchSettings {
  enabled?: boolean;
  allow?: string[];
  deny?: string[];
}

/** Wants a look: the pet's alert glance. Good news gets the happy hop; green CI stays in the list only. */
const ALERT = new Set<PrEventKind>(["changes_requested", "ci_failed", "comments"]);
const HAPPY = new Set<PrEventKind>(["approved", "merged"]);

/** Counts PR news the way ActivityTracker counts alerts: each key once, only what the agent saw after
 * this panel started, so reopening the app never replays old news. */
export class PrNews {
  #seen = new Set<string>();
  #since: number | null = null;
  #alerts = 0;
  #happy = 0;

  update(view: PrWatchView | null, now: number): { alerts: number; happy: number } {
    this.#since ??= now;
    for (const e of view?.events ?? []) {
      if (this.#seen.has(e.key)) continue;
      this.#seen.add(e.key);
      if (e.seenAt < this.#since) continue;
      if (ALERT.has(e.kind)) this.#alerts++;
      else if (HAPPY.has(e.kind)) this.#happy++;
    }
    return { alerts: this.#alerts, happy: this.#happy };
  }
}

/** The last view the agent gave, refreshed on its own clock; the pet tick only reads it. */
export class PrFeed {
  #news = new PrNews();
  #view: PrWatchView | null = null;

  constructor(private readonly read: () => Promise<PrWatchView>) {}

  async refresh(): Promise<void> {
    try {
      this.#view = await this.read();
    } catch {
      // Agent away for now: keep the last view; its news is already counted.
    }
  }

  counts(now: number): { alerts: number; happy: number } {
    return this.#news.update(this.#view, now);
  }
}

/** Adds PR news to the sessions' activity so the pet reacts through the same path. */
export const withPrNews = (act: Activity, news: { alerts: number; happy: number }): Activity => ({
  ...act,
  alerts: act.alerts + news.alerts,
  done: act.done + news.happy,
});

/** The agent's limits (prs/watch.ts `RepoPattern`, ipc-handlers.ts `PrWatchSet`). */
export const REPO_LIST_MAX = 50;
const PATTERN = /^[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+|\*)$/;

/** `acme/app, acme, https://github.com/acme/web` → patterns, plus what it couldn't read (never dropped
 * silently: a deny list that lost an entry would keep alerting). A bare owner means `owner/*`. */
export const parseRepoList = (text: string): { valid: string[]; invalid: string[] } => {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of text
    .split(/[,\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)) {
    const s = raw
      .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "")
      .replace(/\.git$/, "")
      .replace(/\/+$/, "")
      .split("/")
      .slice(0, 2)
      .join("/");
    const p = s.includes("/") ? s : `${s}/*`;
    if (PATTERN.test(p) && p.length <= 140) {
      if (!valid.includes(p)) valid.push(p);
    } else invalid.push(raw);
  }
  return { valid, invalid };
};
