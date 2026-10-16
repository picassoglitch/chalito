import { promises as fsp, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCAN_DEPTH, SCAN_MAX_REPOS, hooksFor, resolveHooks, type HooksInfo, type HooksOptions } from "./git-hooks.js";

/**
 * Every git repo in (or around) each workspace, with how git runs its hooks, kept ready for the
 * classifier. Built off the classify path: an async scan (fs.promises) runs at daemon start, on
 * policy changes and on a timer; classification only reads the last completed index. Between
 * scans, the watched config files' mtimes are checked at most every few seconds, and the union is
 * rebuilt only when one changed.
 *
 * A scan cut short (repo cap, folder budget, unreadable folder) marks its workspace partial, and
 * a workspace with no completed scan yet is "missing": the classifier then applies the narrow
 * fallback (the repo's hooks/ and .githooks/).
 */

/** Folders a repo scan never enters: dependencies, build output, caches. */
const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  "Pods",
  ".gradle",
  ".terraform",
]);
/** Folders one scan may read before it gives up (the workspace is then partial). */
export const SCAN_DIR_BUDGET = 20_000;
/** How often the classifier may re-check the watched files' mtimes. */
export const MTIME_CHECK_MS = 5_000;

export interface RepoScanResult {
  roots: string[];
  complete: boolean;
}

interface WsIndex {
  ws: string;
  scan: RepoScanResult;
  /** How many repos get resolved; the rest are known by root only (narrow fallback). */
  max: number;
  /** Repos found inside the workspace, and the one around it (if any). */
  roots: string[];
  at: number;
}

export interface RepoUnion {
  /** Hooks folders (resolved and extra) of every known repo. */
  hooksDirs: string[];
  /** Git dirs and common dirs of every known repo. */
  gitDirs: string[];
  /** Every config file in any known repo's chain. */
  chain: Set<string>;
  /** Known repo roots, longest first, with whether their config couldn't be read with confidence. */
  roots: { root: string; unknown: boolean }[];
  /** Workspaces whose last scan was cut short. */
  partial: string[];
  /** Workspaces with no completed scan yet. */
  missing: string[];
}

const indexes = new Map<string, WsIndex>();
let version = 0;

const realOr = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

/** Breadth-first, async, never following symlinks; stops at the repo cap or the folder budget. */
export const scanReposAsync = async (ws: string, o: { budget?: number } = {}): Promise<RepoScanResult> => {
  let budget = o.budget ?? SCAN_DIR_BUDGET;
  const roots: string[] = [];
  let queue: [string, number][] = [[ws, 0]];
  while (queue.length) {
    const next: [string, number][] = [];
    for (const [dir, depth] of queue) {
      if (--budget < 0) return { roots, complete: false };
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return { roots, complete: false };
      }
      if (entries.some((e) => e.name === ".git")) roots.push(dir);
      if (depth < SCAN_DEPTH)
        for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name)) next.push([join(dir, e.name), depth + 1]);
    }
    queue = next;
  }
  return { roots, complete: true };
};

/** The same scan, synchronous: for tests and tools only, never the classify path. */
export const scanReposSync = (ws: string, o: { budget?: number } = {}): RepoScanResult => {
  let budget = o.budget ?? SCAN_DIR_BUDGET;
  const roots: string[] = [];
  let queue: [string, number][] = [[ws, 0]];
  while (queue.length) {
    const next: [string, number][] = [];
    for (const [dir, depth] of queue) {
      if (--budget < 0) return { roots, complete: false };
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return { roots, complete: false };
      }
      if (entries.some((e) => e.name === ".git")) roots.push(dir);
      if (depth < SCAN_DEPTH)
        for (const e of entries) if (e.isDirectory() && !SKIP.has(e.name)) next.push([join(dir, e.name), depth + 1]);
    }
    queue = next;
  }
  return { roots, complete: true };
};

/** The repo around a workspace (a workspace inside a repo), or null. */
const enclosingRepo = async (ws: string): Promise<string | null> => {
  let cur = dirname(ws);
  for (;;) {
    try {
      await fsp.lstat(join(cur, ".git"));
      return cur;
    } catch {
      /* not here */
    }
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
};
const enclosingRepoSync = (ws: string): string | null => {
  let cur = dirname(ws);
  for (;;) {
    try {
      statSync(join(cur, ".git"));
      return cur;
    } catch {
      /* not here */
    }
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
};

const store = (ws: string, scan: RepoScanResult, around: string | null, max = SCAN_MAX_REPOS) => {
  indexes.set(ws, {
    ws,
    scan,
    max,
    roots: [...new Set([...(around ? [around] : []), ...scan.roots])],
    at: Date.now(),
  });
  version++;
};

/** Scans the workspaces (async) and keeps the result for the classifier. */
export const refreshRepoIndex = async (
  workspaces: string[],
  o: { max?: number; budget?: number } = {},
): Promise<void> => {
  for (const ws of workspaces) {
    const [scan, around] = await Promise.all([scanReposAsync(ws, o), enclosingRepo(ws)]);
    store(ws, scan, around, o.max);
  }
};

/** The same, synchronous: for tests and tools only, never the classify path. */
export const refreshRepoIndexSync = (workspaces: string[], o: { max?: number; budget?: number } = {}): void => {
  for (const ws of workspaces) store(ws, scanReposSync(ws, o), enclosingRepoSync(ws), o.max);
};

interface UnionCache {
  key: string;
  version: number;
  union: RepoUnion;
  infos: HooksInfo[];
  watched: string[];
  stamp: string;
  checkedAt: number;
}
let unionCache: UnionCache | null = null;

const mtime = (p: string) => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return -1;
  }
};

const build = (workspaces: string[], o: HooksOptions): Omit<UnionCache, "key" | "version" | "checkedAt"> => {
  const infos: { root: string; info: HooksInfo }[] = [];
  // Repos past the cap: known by root only, so their usual hooks folders count (narrow fallback).
  const unresolved: string[] = [];
  const partial: string[] = [];
  const missing: string[] = [];
  const gitDirEnv = o.env?.GIT_DIR;
  for (const ws of workspaces) {
    const idx = indexes.get(ws);
    if (gitDirEnv) {
      // GIT_DIR: the sessions' git uses that one git dir, with the workspace as its worktree.
      infos.push({ root: ws, info: resolveHooks(ws, o) });
      continue;
    }
    if (!idx) {
      missing.push(ws);
      continue;
    }
    if (!idx.scan.complete) partial.push(ws);
    idx.roots.forEach((root, i) => {
      if (i < idx.max) infos.push({ root, info: hooksFor(root, o) });
      else unresolved.push(root);
    });
  }
  const hooksDirs = new Set<string>();
  const gitDirs = new Set<string>();
  const chain = new Set<string>();
  const watched = new Set<string>();
  const roots = new Map<string, boolean>();
  for (const { root, info } of infos) {
    if (typeof info.dir === "string" && info.dir !== "unknown") hooksDirs.add(realOr(info.dir));
    for (const d of info.extraDirs) hooksDirs.add(realOr(d));
    for (const d of info.gitDirs) gitDirs.add(realOr(d));
    for (const f of info.chain) chain.add(realOr(f));
    for (const f of info.watched) watched.add(f);
    roots.set(realOr(root), (roots.get(realOr(root)) ?? false) || info.dir === "unknown");
  }
  for (const root of unresolved) roots.set(realOr(root), true);
  const watchedList = [...watched];
  return {
    union: {
      hooksDirs: [...hooksDirs],
      gitDirs: [...gitDirs],
      chain,
      roots: [...roots.entries()]
        .map(([root, unknown]) => ({ root, unknown }))
        .sort((a, b) => b.root.length - a.root.length),
      partial,
      missing,
    },
    infos: infos.map((i) => i.info),
    watched: watchedList,
    stamp: watchedList.map(mtime).join(","),
  };
};

/**
 * The union for these workspaces, from the last completed scans. Cheap on every call: it is
 * rebuilt only after a new scan, or when a watched file's mtime changed (checked at most every
 * MTIME_CHECK_MS). A workspace without a completed scan triggers one in the background and counts
 * as missing meanwhile; nothing here walks folders.
 */
export const repoUnion = (workspaces: string[], o: HooksOptions, now = Date.now()): RepoUnion => {
  const key = `${workspaces.join("\0")}\0${o.home}\0${o.xdgConfigHome ?? ""}\0${JSON.stringify(o.env ?? {})}\0${o.platform ?? ""}`;
  const c = unionCache;
  if (c && c.key === key && c.version === version) {
    if (now - c.checkedAt < MTIME_CHECK_MS) return c.union;
    c.checkedAt = now;
    if (c.watched.map(mtime).join(",") === c.stamp) return c.union;
  }
  const missingNow = workspaces.filter((w) => !indexes.has(w));
  if (missingNow.length) void refreshRepoIndex(missingNow).catch(() => undefined);
  const built = build(workspaces, o);
  unionCache = { key, version, checkedAt: now, ...built };
  return built.union;
};

/** Tests: forget everything. */
export const clearRepoIndex = () => {
  indexes.clear();
  unionCache = null;
  version++;
};
