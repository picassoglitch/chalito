import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { basename, join } from "node:path";
import {
  claudeNow,
  codexDrift,
  codexEvent,
  codexNow,
  ledgerEvent,
  levelFor,
  parseClaudeTail,
  rank,
  reduceCodex,
  unreadThreads,
  type ClaudeTail,
  type CodexEvent,
  type CodexSession,
  type OwnSessionView,
  type RolloutMeta,
} from "./own-sessions.js";

/** Where the tools keep their files: the same layout under the home folder on macOS, Linux and Windows. */
export interface WatchPaths {
  claudeProjects: string;
  /** Claude Code's <pid>.json files: which process (and so which terminal tab) runs a session. */
  claudeSessions: string;
  codexHome: string;
  /** Chalito's own folder for the opt-in flag and the Codex hook's ledger (never the tools' folders). */
  own: string;
}

export const watchPaths = (chalitoDir: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): WatchPaths => ({
  claudeProjects: join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects"),
  claudeSessions: join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "sessions"),
  codexHome: env.CODEX_HOME || join(home, ".codex"),
  own: join(chalitoDir, "watch"),
});

export const ledgerPath = (p: Pick<WatchPaths, "own">): string => join(p.own, "codex-events.jsonl");
const gatePath = (p: Pick<WatchPaths, "own">): string => join(p.own, "settings.json");

const errCode = (e: unknown): string =>
  e && typeof e === "object" && "code" in e && typeof e.code === "string" ? e.code : "error";

/** The opt-in: off unless the person turned it on on this computer. A broken file reads as off. */
export const watchEnabled = (p: Pick<WatchPaths, "own">, onError?: (code: string) => void): boolean => {
  try {
    return (JSON.parse(readFileSync(gatePath(p), "utf8")) as { enabled?: unknown }).enabled === true;
  } catch (e) {
    if (errCode(e) !== "ENOENT") onError?.(errCode(e));
    return false;
  }
};

const writeGate = (p: Pick<WatchPaths, "own">, enabled: boolean): void => {
  mkdirSync(p.own, { recursive: true, mode: 0o700 });
  const tmp = `${gatePath(p)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ enabled }), { mode: 0o600 });
  renameSync(tmp, gatePath(p));
};

/** Reads bytes appended since the last call and returns complete lines; a partial last line waits. */
export class Tail {
  #pos: number | null = null;
  #buf = "";
  #cut = false;
  // A read can end inside a multi-byte character; the decoder holds those bytes for the next one.
  #decoder = new StringDecoder("utf8");
  constructor(
    readonly path: string,
    private readonly fromEndBytes: number,
  ) {}

  read(): string[] {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    if (this.#pos === null) {
      this.#pos = Math.max(0, size - this.fromEndBytes);
      this.#cut = this.#pos > 0;
    }
    if (size < this.#pos) {
      this.#pos = 0;
      this.#buf = "";
      this.#decoder = new StringDecoder("utf8");
    }
    if (size === this.#pos) return [];
    // Grows by what was appended; a file that can't be read now is retried on the next poll.
    const chunk = readRange(this.path, this.#pos, Math.min(size - this.#pos, 8 * 1024 * 1024));
    this.#pos += chunk.length;
    this.#buf += this.#decoder.write(chunk);
    const lines = this.#buf.split("\n");
    this.#buf = lines.pop() ?? "";
    // Started mid-file: the first line is the tail end of one we never saw.
    if (this.#cut && lines.length) {
      lines.shift();
      this.#cut = false;
    }
    return lines.filter((l) => l.trim());
  }
}

const readRange = (path: string, start: number, len: number): Buffer => {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
};

const firstLine = (path: string): string | null => {
  try {
    const text = readRange(path, 0, 256 * 1024).toString("utf8");
    const nl = text.indexOf("\n");
    return nl === -1 ? null : text.slice(0, nl);
  } catch {
    return null;
  }
};

const list = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const mtimeOf = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

export interface WatcherOptions {
  paths: WatchPaths;
  now?: () => number;
  log?: (msg: string, meta: Record<string, unknown>) => void;
  /** Sessions untouched for longer drop off the list. */
  staleMs?: number;
}

const DAY_MS = 24 * 3600 * 1000;
/** A working session silent this long was most likely closed. */
const QUIET_WORKING_MS = 30 * 60 * 1000;
const LIST_EVERY_MS = 30_000;
/** The pet tick and the panel both ask; one read serves both. */
const CACHE_MS = 2_000;
const CLAUDE_TAIL_BYTES = 512 * 1024;
const ROLLOUT_SEED_BYTES = 1_000_000;

/** Read-only: the tools' files are only ever opened for reading, and not at all while the opt-in is off. */
export class OwnSessionWatcher {
  readonly paths: WatchPaths;
  readonly #now: () => number;
  readonly #log: (msg: string, meta: Record<string, unknown>) => void;
  readonly #staleMs: number;
  #claude = new Map<string, { size: number; mtime: number; tail: ClaudeTail }>();
  #rollouts = new Map<string, { tail: Tail; meta: RolloutMeta }>();
  #parents = new Map<string, string>();
  #codex = new Map<string, CodexSession>();
  #ledger: Tail | null = null;
  #listedAt = 0;
  #claudeFiles: string[] = [];
  #rolloutFiles: string[] = [];
  #titles = { at: 0, names: new Map<string, string>() };
  #read = { mtime: 0, unread: null as Set<string> | null };
  /** Drift already logged per file, so one odd line isn't reported on every poll. */
  #skippedLogged = new Map<string, number>();
  #lastError: string | null = null;
  #cache: { at: number; views: OwnSessionView[] } | null = null;

  constructor(o: WatcherOptions) {
    this.paths = o.paths;
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? (() => undefined);
    this.#staleMs = o.staleMs ?? DAY_MS;
  }

  get enabled(): boolean {
    return watchEnabled(this.paths, (code) => this.#warn("watch.gate_unreadable", code));
  }

  /** One gate read for the panel: the toggle and the list can't disagree. */
  snapshot(): { enabled: boolean; sessions: OwnSessionView[] } {
    const enabled = this.enabled;
    return { enabled, sessions: enabled ? this.#pollOn() : this.#off() };
  }

  #warn(msg: string, code: string): void {
    const key = `${msg}:${code}`;
    if (this.#lastError === key) return;
    this.#lastError = key;
    this.#log(msg, { code });
  }

  #skipped(file: string, source: string, count: number): void {
    if (count <= (this.#skippedLogged.get(file) ?? 0)) return;
    this.#skippedLogged.set(file, count);
    this.#log("watch.skipped_lines", { source, count });
  }

  /** Turning it off forgets everything read so far, including the hook's ledger (Chalito's own file). */
  setEnabled(on: boolean): void {
    writeGate(this.paths, on);
    if (on) return;
    this.#reset();
    // The watch is already off; a ledger that can't be removed (Windows lock, antivirus) is only logged.
    for (const f of [ledgerPath(this.paths), `${ledgerPath(this.paths)}.1`])
      try {
        rmSync(f, { force: true });
      } catch (e) {
        this.#warn("watch.ledger_not_removed", errCode(e));
      }
  }

  #reset(): void {
    this.#claude.clear();
    this.#rollouts.clear();
    this.#parents.clear();
    this.#codex.clear();
    this.#ledger = null;
    this.#listedAt = 0;
    this.#claudeFiles = [];
    this.#rolloutFiles = [];
    this.#skippedLogged.clear();
    this.#cache = null;
    this.#titles = { at: 0, names: new Map() };
    this.#read = { mtime: 0, unread: null };
  }

  /** The sessions right now, most urgent first; [] while the opt-in is off. */
  poll(): OwnSessionView[] {
    return this.enabled ? this.#pollOn() : this.#off();
  }

  #off(): OwnSessionView[] {
    if (this.#listedAt) this.#reset();
    return [];
  }

  #pollOn(): OwnSessionView[] {
    const now = this.#now();
    if (this.#cache && now - this.#cache.at >= 0 && now - this.#cache.at < CACHE_MS) return this.#cache.views;
    if (now - this.#listedAt >= LIST_EVERY_MS) {
      this.#claudeFiles = this.#listClaude(now);
      this.#rolloutFiles = this.#listRollouts(now);
      this.#listedAt = now;
    }
    const views = rank([...this.#pollClaude(now), ...this.#pollCodex(now)]);
    this.#cache = { at: now, views };
    return views;
  }

  #listClaude(now: number): string[] {
    const out: string[] = [];
    for (const d of list(this.paths.claudeProjects)) {
      const dir = join(this.paths.claudeProjects, d);
      // Only <project>/<session>.jsonl: subagent transcripts sit one level deeper.
      for (const n of list(dir)) {
        if (!n.endsWith(".jsonl")) continue;
        const p = join(dir, n);
        const m = mtimeOf(p);
        if (m !== null && now - m < this.#staleMs) out.push(p);
      }
    }
    return out;
  }

  #listRollouts(now: number): string[] {
    const root = join(this.paths.codexHome, "sessions");
    const out: string[] = [];
    const digits = (dir: string) => list(dir).filter((n) => /^\d+$/.test(n));
    // Rollouts stay in the folder of the day they started, so every day folder is a candidate.
    for (const y of digits(root))
      for (const m of digits(join(root, y)))
        for (const d of digits(join(root, y, m))) {
          const dir = join(root, y, m, d);
          for (const n of list(dir)) {
            if (!n.startsWith("rollout-") || !n.endsWith(".jsonl")) continue;
            const p = join(dir, n);
            const mt = mtimeOf(p);
            if (mt !== null && now - mt < this.#staleMs) out.push(p);
          }
        }
    return out;
  }

  #pollClaude(now: number): OwnSessionView[] {
    const out: OwnSessionView[] = [];
    const live = new Set(this.#claudeFiles);
    for (const p of this.#claude.keys())
      if (!live.has(p)) {
        this.#claude.delete(p);
        this.#skippedLogged.delete(p);
      }
    for (const p of this.#claudeFiles) {
      let st: { size: number; mtimeMs: number };
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      let hit = this.#claude.get(p);
      if (!hit || hit.size !== st.size || hit.mtime !== st.mtimeMs) {
        const start = Math.max(0, st.size - CLAUDE_TAIL_BYTES);
        let text: string;
        try {
          text = readRange(p, start, st.size - start).toString("utf8");
        } catch (e) {
          this.#warn("watch.read_failed", errCode(e));
          continue;
        }
        // A cut first line (mid-file start) and a last line still being written are not format drift.
        if (start > 0) text = text.slice(text.indexOf("\n") + 1);
        text = text.slice(0, text.lastIndexOf("\n") + 1);
        const tail = parseClaudeTail(text);
        this.#skipped(p, "claude", tail.skipped);
        hit = { size: st.size, mtime: st.mtimeMs, tail };
        this.#claude.set(p, hit);
      }
      const t = hit.tail;
      const id = t.id ?? basename(p, ".jsonl");
      const last = Math.max(t.last, hit.mtime);
      const cur = claudeNow(t, now, hit.mtime);
      if (cur.state === "working" && now - last > QUIET_WORKING_MS) continue;
      const waited = Math.max(0, (now - cur.since) / 1000);
      const quietS = Math.max(0, (now - last) / 1000);
      out.push({
        key: `claude:${id}`,
        source: "claude",
        id,
        cwd: t.cwd,
        title: t.title,
        state: cur.state,
        since: cur.since,
        detail: cur.detail,
        detailKey: cur.detailKey,
        level: levelFor(cur.state, waited, false, { guessed: cur.guessed, quietS }),
        reviewing: false,
        guessed: cur.guessed,
        seen: false,
      });
    }
    return out;
  }

  #pollCodex(now: number): OwnSessionView[] {
    const live = new Set(this.#rolloutFiles);
    for (const [p, r] of this.#rollouts) {
      if (live.has(p)) continue;
      this.#rollouts.delete(p);
      if (r.meta.id) this.#parents.delete(r.meta.id);
      if (r.meta.id && !existsSync(p)) this.#codex.delete(r.meta.id); // archived: the rollout moved away
    }
    // Learn every new thread's parent before reading any tail, so verdicts resolve to the root chat.
    for (const p of this.#rolloutFiles) {
      if (this.#rollouts.has(p)) continue;
      const meta: RolloutMeta = {};
      const first = firstLine(p);
      if (first) codexEvent(first, meta, this.#parents);
      this.#rollouts.set(p, { tail: new Tail(p, ROLLOUT_SEED_BYTES), meta });
    }
    let skipped = 0;
    // One unreadable file (archived mid-read, no permission) must not hide every other session.
    const each = (tail: Tail, line: (l: string) => void) => {
      try {
        for (const l of tail.read()) line(l);
      } catch (e) {
        this.#warn("watch.read_failed", errCode(e));
      }
    };
    const events: CodexEvent[] = [];
    for (const p of this.#rolloutFiles) {
      const r = this.#rollouts.get(p)!;
      each(r.tail, (line) => {
        if (codexDrift(line)) skipped++;
        const ev = codexEvent(line, r.meta, this.#parents);
        if (ev) events.push(ev);
      });
    }
    this.#ledger ??= new Tail(ledgerPath(this.paths), 200_000);
    each(this.#ledger, (line) => {
      const ev = ledgerEvent(line);
      if (ev) events.push(ev);
      else skipped++;
    });
    // Rollouts and the hook arrive by source; a verdict must land after the request it answers.
    events.sort((a, b) => a.ts - b.ts);
    for (const ev of events) reduceCodex(this.#codex, ev);
    // Tails only return new lines, so each count here is new drift.
    if (skipped) this.#log("watch.skipped_lines", { source: "codex", count: skipped });
    this.#refreshTitles(now);
    this.#refreshRead();
    const out: OwnSessionView[] = [];
    for (const s of this.#codex.values()) {
      if (now - s.last > this.#staleMs) {
        this.#codex.delete(s.id);
        continue;
      }
      const cur = codexNow(s, now);
      if (cur.state === "working" && now - s.last > QUIET_WORKING_MS) continue;
      // Opened in the Codex app after the turn ended (5 s margin for the app's own write).
      const seen =
        cur.state === "finished" &&
        !!this.#read.unread &&
        this.#read.mtime > s.since + 5000 &&
        !this.#read.unread.has(s.id);
      const waited = Math.max(0, (now - cur.since) / 1000);
      out.push({
        key: `codex:${s.id}`,
        source: "codex",
        id: s.id,
        cwd: s.cwd,
        title: this.#titles.names.get(s.id) ?? null,
        state: cur.state,
        since: cur.since,
        detail: cur.detail,
        detailKey: cur.detailKey,
        level: levelFor(cur.state, waited, cur.reviewing, { quietS: Math.max(0, (now - s.last) / 1000) }),
        reviewing: cur.reviewing,
        guessed: false,
        seen,
      });
    }
    return out;
  }

  #refreshTitles(now: number): void {
    if (now - this.#titles.at < 15_000) return;
    const names = new Map<string, string>();
    try {
      for (const l of readFileSync(join(this.paths.codexHome, "session_index.jsonl"), "utf8").split("\n")) {
        try {
          const d = JSON.parse(l) as { id?: unknown; thread_name?: unknown };
          if (typeof d.id === "string" && typeof d.thread_name === "string")
            names.set(d.id, d.thread_name.slice(0, 120));
        } catch {
          // a line being written, or one we don't know
        }
      }
    } catch {
      // no index: titles fall back to the folder name
    }
    this.#titles = { at: now, names };
  }

  #refreshRead(): void {
    const p = join(this.paths.codexHome, ".codex-global-state.json");
    const m = mtimeOf(p);
    if (m === null || m === this.#read.mtime) return;
    try {
      this.#read = { mtime: m, unread: unreadThreads(JSON.parse(readFileSync(p, "utf8"))) };
    } catch {
      // mid-write: keep the last good read
    }
  }
}
