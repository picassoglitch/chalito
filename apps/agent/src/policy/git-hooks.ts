import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Where git runs a workspace repo's hooks from, as git itself resolves it (`core.hooksPath` with
 * includes, the global and system config, worktrees' gitdir files): the classifier keeps writes
 * there HIGH. Asked once per workspace and cached until one of the config files changes; never per
 * classified path.
 *
 * `null` = not a git repo. `"unknown"` = there is a `.git` but git failed or timed out: the
 * classifier then fails closed on every likely hooks folder.
 */
export type HooksDir = string | "unknown" | null;

/** Runs git with these args in `cwd`; throws on failure or timeout. Injected by tests. */
export type GitRunner = (args: string[], cwd: string, env: Record<string, string>) => string;

const TIMEOUT_MS = 1500;

export const execGit: GitRunner = (args, cwd, env) =>
  execFileSync("git", args, { cwd, env, timeout: TIMEOUT_MS, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

const mtime = (p: string): number => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return -1;
  }
};

/** The repo's git dir: `.git` itself, or what a worktree's / submodule's `.git` file points to. */
const gitDirOf = (ws: string): string | null => {
  const dotGit = join(ws, ".git");
  try {
    const st = statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    return m ? resolve(ws, m[1]!.trim()) : dotGit;
  } catch {
    return null;
  }
};

/** Files whose change can move hooksPath: the repo's configs (worktree and common dir) and the user's. */
const configStamp = (ws: string, gitDir: string, home: string): string => {
  let common = gitDir;
  try {
    common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
  } catch {
    /* not a worktree */
  }
  return [
    join(ws, ".git"),
    join(gitDir, "config"),
    join(gitDir, "config.worktree"),
    join(common, "config"),
    join(home, ".gitconfig"),
    join(home, ".config", "git", "config"),
  ]
    .map(mtime)
    .join(",");
};

const cache = new Map<string, { stamp: string; at: number; dir: HooksDir }>();
/** Includes can pull in other files whose mtime isn't tracked: re-ask at least this often. */
const MAX_AGE_MS = 60_000;

/** Only HOME and PATH: no GIT_DIR / GIT_CONFIG_* from the agent's environment steer the answer. */
const gitEnv = (home: string): Record<string, string> => {
  const env: Record<string, string> = { HOME: home, PATH: process.env.PATH ?? "" };
  if (process.platform === "win32") {
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    env.USERPROFILE = home;
  }
  return env;
};

export const hooksDirFor = (ws: string, home: string, run: GitRunner = execGit, now = Date.now()): HooksDir => {
  const gitDir = gitDirOf(ws);
  if (!gitDir) return null;
  const stamp = configStamp(ws, gitDir, home);
  const hit = cache.get(ws);
  if (hit && hit.stamp === stamp && now - hit.at < MAX_AGE_MS) return hit.dir;
  let dir: HooksDir;
  const env = gitEnv(home);
  // fsmonitor off: asking must never start a configured hook-like helper.
  const base = ["-C", ws, "-c", "core.fsmonitor=false"];
  try {
    const out = run([...base, "rev-parse", "--git-path", "hooks"], ws, env).trim();
    if (!out) throw new Error("empty");
    dir = isAbsolute(out) ? out : resolve(ws, out);
  } catch {
    try {
      const out = run([...base, "config", "--get", "core.hooksPath"], ws, env).trim();
      dir = out ? (isAbsolute(out) ? out : resolve(ws, out)) : "unknown";
    } catch {
      dir = "unknown";
    }
  }
  cache.set(ws, { stamp, at: now, dir });
  return dir;
};

/** Tests: forget cached answers. */
export const clearHooksCache = () => cache.clear();
