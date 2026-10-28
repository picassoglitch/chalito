import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { knownBinDirs } from "../apps/manager.js";
import { which, type ProcessRunner, type RunResult } from "../runner.js";
import {
  PR_QUERY,
  parseViewer,
  prEvents,
  prStatuses,
  repoAllowed,
  type PrEvent,
  type PrStatus,
  type RepoFilter,
} from "./events.js";
import { readSessionRepo, sessionFor, type LinkedSession, type SessionPlace, type SessionRepo } from "./link.js";

export const POLL_MS = 5 * 60 * 1000;
export const MAX_BACKOFF_MS = 60 * 60 * 1000;
export const GH_TIMEOUT_MS = 30_000;
/** A session's `git` gets less: it only decides which session the news goes to. */
export const GIT_TIMEOUT_MS = 5_000;
/** How long a "is gh signed in?" answer is reused while the watch is off. */
export const PROBE_TTL_MS = 10 * 60 * 1000;
/** Seen keys outlive the 3-day event window, so an old event never comes back. */
export const SEEN_TTL_MS = 4 * 24 * 60 * 60 * 1000;
const RECENT_MAX = 30;

/** `off` until the person turns it on; `gh_missing` and `logged_out` stop polling until they retry. */
export type PrWatchState = "off" | "starting" | "ok" | "gh_missing" | "logged_out" | "error";
export type GhProbe = "ready" | "missing" | "logged_out";

export interface PrEventView extends PrEvent {
  /** When this agent first saw it (epoch ms). */
  seenAt: number;
  session: LinkedSession | null;
}

export interface PrWatchView {
  enabled: boolean;
  state: PrWatchState;
  login: string | null;
  checkedAt: number | null;
  allow: string[];
  deny: string[];
  prs: PrStatus[];
  events: PrEventView[];
  /** Only when Settings asks while off: whether turning it on would work (null: couldn't tell). */
  gh: GhProbe | null;
}

export const RepoPattern = z
  .string()
  .max(140)
  .regex(/^[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+|\*)$/);

const LinkedSessionSchema = z.object({ sid: z.string(), label: z.string() });
const StoredEvent = z.object({
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  title: z.string(),
  branch: z.string(),
  headRepo: z.string().nullable(),
  kind: z.enum(["approved", "changes_requested", "comments", "ci_failed", "ci_passed", "merged"]),
  key: z.string(),
  at: z.number(),
  by: z.string().optional(),
  sha: z.string().optional(),
  comments: z.number().optional(),
  seenAt: z.number(),
  session: LinkedSessionSchema.nullable(),
});
const Filter = z.object({ allow: z.array(RepoPattern), deny: z.array(RepoPattern) });
const Stored = z.object({
  v: z.literal(1),
  enabled: z.boolean().default(false),
  allow: z.array(RepoPattern).default([]),
  deny: z.array(RepoPattern).default([]),
  /** False until a first poll has learned what was already there. */
  primed: z.boolean().default(false),
  /** The lists before the last change: events of repos they hid are learned, not news. */
  muteFrom: Filter.nullable().default(null),
  seen: z.record(z.string(), z.number()).default({}),
  recent: z.array(StoredEvent).default([]),
});
type Stored = z.infer<typeof Stored>;

const fresh = (): Stored => ({
  v: 1,
  enabled: false,
  allow: [],
  deny: [],
  primed: false,
  muteFrom: null,
  seen: {},
  recent: [],
});

export interface PrWatchDeps {
  runner: ProcessRunner;
  /** The person's `gh`, or null when it isn't installed. */
  ghPath: () => string | null;
  sessions: () => SessionPlace[];
  /** ~/.chalito */
  dir: string;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => { clear(): void };
  log?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

/** PATH first, then the folders installers use: a login service starts the agent with a short PATH. */
export const findGh = (env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform) => {
  const sep = platform === "win32" ? ";" : ":";
  const PATH = [env.PATH ?? env.Path ?? "", ...knownBinDirs(platform, env)].filter(Boolean).join(sep);
  return which("gh", { ...env, PATH }, platform);
};

/** gh exits 4 when signed out; a revoked token answers 401 "Bad credentials". */
export const isLoggedOut = (r: RunResult) =>
  r.code !== 0 &&
  (r.code === 4 || /gh auth login|not logged in|authentication required|bad credentials|HTTP 401/i.test(r.stderr));

/** The runner answers 127 for any spawn error; only ENOENT means gh isn't there. */
const isMissing = (r: RunResult) => r.code === 127 && /ENOENT|not found/i.test(r.stderr);

const TIMED_OUT: RunResult = { code: 124, stdout: "", stderr: "timeout" };

/** Polls the person's PRs with their own `gh` login (no token kept here) and raises each event once. */
export class PrWatch {
  #s: Stored;
  #state: PrWatchState;
  #login: string | null = null;
  #checkedAt: number | null = null;
  #prs: PrStatus[] = [];
  #timer: { clear(): void } | null = null;
  #failures = 0;
  #inFlight: Promise<void> | null = null;
  #probe: { at: number; value: GhProbe | null } | null = null;
  #probing: Promise<GhProbe | null> | null = null;
  #stopped = false;
  /** Bumped by every switch or list change: a poll that started before it learns nothing. */
  #gen = 0;

  constructor(private readonly d: PrWatchDeps) {
    this.#s = this.#load();
    this.#state = this.#s.enabled ? "starting" : "off";
  }

  get file(): string {
    return join(this.d.dir, "pr-watch.json");
  }

  start(): void {
    this.#stopped = false;
    if (this.#s.enabled) this.#schedule(0);
  }

  stop(): void {
    this.#stopped = true;
    this.#timer?.clear();
    this.#timer = null;
  }

  /** `probe` only from Settings: while off, nothing else runs `gh`. */
  async view(probe = false): Promise<PrWatchView> {
    const gh = probe && !this.#s.enabled ? await this.#probeGh() : null;
    return {
      enabled: this.#s.enabled,
      state: this.#state,
      login: this.#login,
      checkedAt: this.#checkedAt,
      allow: [...this.#s.allow],
      deny: [...this.#s.deny],
      prs: this.#prs,
      events: [...this.#s.recent],
      gh,
    };
  }

  /** The panel's switch, its retry and the lists. Polls in the background; throws when it couldn't save. */
  async configure(c: { enabled?: boolean; allow?: string[]; deny?: string[] }): Promise<PrWatchView> {
    const turningOn = c.enabled === true && !this.#s.enabled;
    const retry = c.enabled === true && (this.#state === "gh_missing" || this.#state === "logged_out");
    const lists = c.allow !== undefined || c.deny !== undefined;
    if (lists && this.#s.primed) this.#s.muteFrom ??= { allow: [...this.#s.allow], deny: [...this.#s.deny] };
    if (c.allow) this.#s.allow = c.allow;
    if (c.deny) this.#s.deny = c.deny;
    if (c.enabled !== undefined) this.#s.enabled = c.enabled;
    if (turningOn) this.#s.primed = false;
    this.#gen++;
    const saved = this.#save();
    if (!this.#s.enabled) {
      this.#timer?.clear();
      this.#timer = null;
      this.#state = "off";
      this.#prs = [];
    } else if (turningOn || retry || lists) {
      if (turningOn || retry) {
        this.#state = "starting";
        this.#failures = 0;
        this.#probe = null;
      }
      if (!this.#stopped) this.#schedule(0);
    }
    if (!saved) throw new Error("save_failed");
    return this.view(true);
  }

  /** One poll now (the timer's and the tests'). */
  poll(): Promise<void> {
    this.#inFlight ??= this.#poll().finally(() => (this.#inFlight = null));
    return this.#inFlight;
  }

  #schedule(ms: number): void {
    this.#timer?.clear();
    this.#timer = this.d.setTimer(() => {
      this.#timer = null;
      void this.poll();
    }, ms);
  }

  async #poll(): Promise<void> {
    if (!this.#s.enabled) return;
    const gen = this.#gen;
    const gh = this.d.ghPath();
    if (!gh) return this.#disable("gh_missing");
    const r = await this.#run(gh, ["api", "graphql", "-f", `query=${PR_QUERY}`], GH_TIMEOUT_MS);
    if (!this.#s.enabled || gen !== this.#gen) return this.#superseded();
    if (isMissing(r)) return this.#disable("gh_missing");
    if (isLoggedOut(r)) return this.#disable("logged_out");
    const parsed = parseViewer(r.stdout);
    if (!parsed.ok) return this.#failed(r, parsed.reason, parsed.errors);
    if (r.code !== 0 || parsed.skipped)
      this.d.log?.warn("prs.partial", { code: r.code, skipped: parsed.skipped, errors: parsed.errors });
    this.#failures = 0;
    const now = this.d.now();
    const filter: RepoFilter = { allow: this.#s.allow, deny: this.#s.deny };
    const events = prEvents(parsed.viewer, filter, now);
    const news = this.#news(events);
    const places = news.length ? await this.#sessionRepos() : [];
    if (!this.#s.enabled || gen !== this.#gen) return this.#superseded();
    this.#login = parsed.viewer.login;
    this.#prs = prStatuses(parsed.viewer, filter);
    this.#checkedAt = now;
    this.#state = "ok";
    this.#learn(events, news, places, now);
    if (!this.#stopped) this.#schedule(POLL_MS);
  }

  /** A change landed mid-poll: its own poll timer handed back this one, so run a fresh one now. */
  #superseded(): void {
    if (this.#s.enabled && !this.#stopped) this.#schedule(0);
  }

  #failed(r: RunResult, reason: string, errors: string[]): void {
    this.#failures++;
    this.#state = "error";
    this.d.log?.warn("prs.poll_failed", {
      code: r.code,
      reason,
      errors,
      stderr: r.stderr.slice(0, 200),
      failures: this.#failures,
    });
    if (!this.#stopped) this.#schedule(Math.min(POLL_MS * 2 ** this.#failures, MAX_BACKOFF_MS));
  }

  /** Unseen events, none on the first poll, and none from repos the old lists hid. */
  #news(events: PrEvent[]): PrEvent[] {
    const mute = this.#s.muteFrom;
    const fresh = (e: PrEvent) => this.#s.seen[e.key] === undefined && (!mute || repoAllowed(e.repo, mute));
    return this.#s.primed ? events.filter(fresh) : [];
  }

  #learn(events: PrEvent[], news: PrEvent[], places: SessionRepo[], now: number): void {
    for (const e of events) this.#s.seen[e.key] ??= now;
    this.#s.primed = true;
    this.#s.muteFrom = null;
    const live = new Set(events.map((e) => e.key));
    // A key still in play (red CI on an old commit) is kept past the TTL, or it would alert again.
    this.#s.seen = Object.fromEntries(
      Object.entries(this.#s.seen).filter(([k, t]) => live.has(k) || now - t < SEEN_TTL_MS),
    );
    const added = news.map((e) => ({ ...e, seenAt: now, session: sessionFor(e, places) }));
    this.#s.recent = [...added, ...this.#s.recent].filter((e) => now - e.seenAt < SEEN_TTL_MS).slice(0, RECENT_MAX);
    this.#save();
  }

  /** Each session on its own: one that fails or hangs only loses its own link. */
  async #sessionRepos(): Promise<SessionRepo[]> {
    let places: SessionPlace[];
    try {
      places = this.d.sessions();
    } catch (err) {
      this.d.log?.warn("prs.sessions_failed", { error: err instanceof Error ? err.message : "error" });
      return [];
    }
    const runner: ProcessRunner = { run: (cmd, args) => this.#run(cmd, args, GIT_TIMEOUT_MS) };
    const read = await Promise.allSettled(places.map((s) => readSessionRepo(runner, s)));
    return read.flatMap((r, i) => {
      if (r.status === "fulfilled") return [r.value];
      this.d.log?.warn("prs.link_failed", { sid: places[i]!.sid, error: String(r.reason).slice(0, 200) });
      return [];
    });
  }

  #disable(state: "gh_missing" | "logged_out"): void {
    this.#state = state;
    this.#prs = [];
    this.#timer?.clear();
    this.#timer = null;
    this.d.log?.warn("prs.disabled", { state });
  }

  #probeGh(): Promise<GhProbe | null> {
    const now = this.d.now();
    if (this.#probe && now - this.#probe.at < PROBE_TTL_MS) return Promise.resolve(this.#probe.value);
    this.#probing ??= (async () => {
      const gh = this.d.ghPath();
      let value: GhProbe | null = "missing";
      if (gh) {
        const r = await this.#run(gh, ["auth", "status", "--hostname", "github.com"], GH_TIMEOUT_MS);
        value = r.code === 0 ? "ready" : isMissing(r) ? "missing" : isLoggedOut(r) ? "logged_out" : null;
      }
      this.#probe = { at: now, value };
      return value;
    })().finally(() => (this.#probing = null));
    return this.#probing;
  }

  /** A hung child counts as a failed run: the runner kills it, and this timer covers runners that can't. */
  #run(cmd: string, args: string[], ms: number): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      const t = this.d.setTimer(() => resolve(TIMED_OUT), ms + 1000);
      void this.d.runner.run(cmd, args, { timeoutMs: ms }).then(
        (r) => (t.clear(), resolve(r)),
        (err: unknown) => (t.clear(), resolve({ code: 1, stdout: "", stderr: String(err) })),
      );
    });
  }

  /** A bad file keeps what still reads (switch, lists, events one by one) and is copied aside. */
  #load(): Stored {
    if (!existsSync(this.file)) return fresh();
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
    } catch (err) {
      return this.#setAside("json", err);
    }
    const whole = Stored.safeParse(raw);
    if (whole.success) return whole.data;
    const recent = Array.isArray(raw?.recent) ? raw.recent.filter((e) => StoredEvent.safeParse(e).success) : [];
    const salvaged = Stored.safeParse({ ...raw, v: 1, recent, muteFrom: null });
    this.#setAside("schema", whole.error);
    return salvaged.success ? salvaged.data : fresh();
  }

  #setAside(reason: string, err: unknown): Stored {
    try {
      copyFileSync(this.file, `${this.file}.bad`);
    } catch {
      // Nothing more to keep.
    }
    this.d.log?.warn("prs.load_failed", { reason, error: err instanceof Error ? err.message.slice(0, 200) : "error" });
    return fresh();
  }

  #save(): boolean {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#s), { mode: 0o600 });
      // A .tmp left by a crash keeps its old mode.
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
      return true;
    } catch (err) {
      this.d.log?.warn("prs.save_failed", { error: err instanceof Error ? err.message : "error" });
      return false;
    }
  }
}
