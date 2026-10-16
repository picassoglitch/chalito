import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Where git would run a workspace repo's hooks from, worked out WITHOUT running git (running a
 * `git` found from a workspace could run a planted binary as the agent). We read what git reads:
 * the `.git` file's `gitdir:`, the gitdir's `commondir`, then the user's and the repo's config
 * files with their `include.path` / `includeIf` targets (depth ≤ 5, relative to the including
 * file), and take the last `core.hooksPath`.
 *
 * The parser is deliberately small. Anything it can't read or understand with confidence (a
 * continued line, an unknown construct, an `includeIf` condition it can't evaluate, an unreadable
 * file) makes the answer "unknown", and the classifier then fails closed on every likely hooks
 * folder.
 */
export interface HooksInfo {
  /** The hooks folder, "unknown" (fail closed), or null when the workspace isn't a git repo. */
  dir: string | "unknown" | null;
  /** The repo's git dir and common dir (a worktree's are different). */
  gitDirs: string[];
  /** Every config file in the resolution chain, read or not (a missing include can be created). */
  chain: string[];
  /** Everything whose change can change the answer: the chain plus the .git file and commondir. */
  watched: string[];
}

export interface GitFs {
  read(path: string): string;
  /** mtime in ms, or -1 when the file doesn't exist. */
  mtime(path: string): number;
  isDir(path: string): boolean | null;
}

const nodeFs: GitFs = {
  read: (p) => readFileSync(p, "utf8"),
  mtime: (p) => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return -1;
    }
  },
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return null;
    }
  },
};

const MAX_DEPTH = 5;

class Unsure extends Error {}

interface Entry {
  section: string;
  sub: string | null;
  key: string;
  value: string | true;
}

/** One value: quotes, escapes, and `;`/`#` comments outside quotes. Throws Unsure on anything odd. */
const parseValue = (raw: string): string => {
  let out = "";
  let quoted = false;
  let pending = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "\\") {
      const n = raw[i + 1];
      if (n === undefined) throw new Unsure("line continuation");
      const map: Record<string, string> = { n: "\n", t: "\t", b: "\b", '"': '"', "\\": "\\" };
      if (!(n in map)) throw new Unsure(`escape \\${n}`);
      out += pending + map[n]!;
      pending = "";
      i++;
    } else if (c === '"') {
      out += pending;
      pending = "";
      quoted = !quoted;
    } else if (!quoted && (c === ";" || c === "#")) {
      break;
    } else if (!quoted && (c === " " || c === "\t")) {
      // Whitespace is kept between words, dropped at the ends.
      pending += c;
    } else {
      out += (out ? pending : "") + c;
      pending = "";
    }
  }
  if (quoted) throw new Unsure("unterminated quote");
  return out;
};

/** Parses a git config file into entries. Throws Unsure when it can't be sure. */
export const parseGitConfig = (text: string): Entry[] => {
  const entries: Entry[] = [];
  let section: string | null = null;
  let sub: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/^\uFEFF/, "").trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      const m = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
      if (!m) throw new Unsure("section header");
      const name = m[1]!;
      if (m[2] !== undefined) {
        section = name.toLowerCase();
        sub = m[2].replace(/\\(.)/g, "$1");
      } else {
        // Legacy [section.sub]: the subsection is lower-cased by git.
        const dot = name.indexOf(".");
        section = (dot === -1 ? name : name.slice(0, dot)).toLowerCase();
        sub = dot === -1 ? null : name.slice(dot + 1).toLowerCase();
      }
      line = line.slice(m[0].length).trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    }
    if (section === null) throw new Unsure("key before any section");
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!kv) throw new Unsure("key line");
    const value = kv[2] === undefined ? true : parseValue(kv[2]);
    entries.push({ section, sub, key: kv[1]!.toLowerCase(), value });
  }
  return entries;
};

/** A `gitdir:` pattern as a regex (git's wildmatch with `**`). */
const gitdirPattern = (pattern: string, fromFile: string, home: string, icase: boolean): RegExp => {
  let p = pattern;
  if (p.startsWith("~/")) p = join(home, p.slice(2));
  else if (p.startsWith("./")) p = join(dirname(fromFile), p.slice(2));
  else if (!isAbsolute(p)) p = `**/${p}`;
  if (p.endsWith("/")) p += "**";
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") throw new Unsure("bracket in includeIf");
    else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, icase ? "i" : "");
};

/** Whether git would follow an includeIf with this condition. Throws Unsure if we can't tell. */
const includeIfApplies = (cond: string, gitDir: string, fromFile: string, home: string): boolean => {
  const m = /^(gitdir|gitdir\/i):(.*)$/.exec(cond);
  if (!m) throw new Unsure(`includeIf ${cond.split(":")[0]}`);
  const dir = gitDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const re = gitdirPattern(m[2]!.replace(/\\/g, "/"), fromFile, home, m[1] === "gitdir/i");
  return re.test(dir) || re.test(`${dir}/`);
};

const expandHome = (p: string, home: string) => (p.startsWith("~/") ? join(home, p.slice(2)) : p);

export const resolveHooks = (ws: string, o: { home: string; xdgConfigHome?: string; fs?: GitFs }): HooksInfo => {
  const fs = o.fs ?? nodeFs;
  const dotGit = join(ws, ".git");
  const kind = fs.isDir(dotGit);
  // Watch .git even when it's missing: creating one makes this a repo.
  if (kind === null) return { dir: null, gitDirs: [], chain: [], watched: [dotGit] };
  const watched = [dotGit];
  const chain: string[] = [];
  let unsure = false;
  let gitDir = dotGit;
  if (kind === false) {
    try {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.read(dotGit));
      if (!m) throw new Unsure("gitdir file");
      gitDir = resolve(ws, m[1]!);
    } catch {
      return { dir: "unknown", gitDirs: [], chain, watched };
    }
  }
  let common = gitDir;
  const commondirFile = join(gitDir, "commondir");
  watched.push(commondirFile);
  if (fs.mtime(commondirFile) !== -1) {
    try {
      common = resolve(gitDir, fs.read(commondirFile).trim());
    } catch {
      unsure = true;
    }
  }

  let hooksPath: string | null = null;
  const readConfig = (file: string, depth: number) => {
    chain.push(file);
    watched.push(file);
    if (depth > MAX_DEPTH) {
      unsure = true;
      return;
    }
    if (fs.mtime(file) === -1) return; // git ignores a missing config or include
    let entries: Entry[];
    try {
      entries = parseGitConfig(fs.read(file));
    } catch {
      unsure = true;
      return;
    }
    for (const e of entries) {
      if (e.section === "core" && e.sub === null && e.key === "hookspath") {
        if (e.value === true) unsure = true;
        else hooksPath = e.value;
      } else if (e.section === "include" && e.sub === null && e.key === "path" && e.value !== true) {
        readConfig(resolve(dirname(file), expandHome(e.value, o.home)), depth + 1);
      } else if (e.section === "includeif" && e.sub !== null && e.key === "path" && e.value !== true) {
        const target = resolve(dirname(file), expandHome(e.value, o.home));
        let applies: boolean;
        try {
          applies = includeIfApplies(e.sub, gitDir, file, o.home);
        } catch {
          // Can't evaluate: watch the file, and fail closed.
          chain.push(target);
          watched.push(target);
          unsure = true;
          continue;
        }
        if (applies) readConfig(target, depth + 1);
        else {
          chain.push(target);
          watched.push(target);
        }
      }
    }
  };

  // git's order: global (XDG, then ~/.gitconfig), the repo's, the worktree's. The last value wins.
  readConfig(join(o.xdgConfigHome ?? join(o.home, ".config"), "git", "config"), 0);
  readConfig(join(o.home, ".gitconfig"), 0);
  readConfig(join(common, "config"), 0);
  readConfig(join(gitDir, "config.worktree"), 0);

  const gitDirs = [...new Set([gitDir, common])];
  if (unsure) return { dir: "unknown", gitDirs, chain, watched };
  const hp = hooksPath as string | null;
  const dir = hp ? resolve(ws, expandHome(hp, o.home)) : join(common, "hooks");
  return { dir, gitDirs, chain, watched };
};

const cache = new Map<string, { stamp: string; info: HooksInfo }>();

/** resolveHooks, cached per workspace until any watched file's mtime changes. */
export const hooksFor = (ws: string, o: { home: string; xdgConfigHome?: string; fs?: GitFs }): HooksInfo => {
  const fs = o.fs ?? nodeFs;
  const key = `${ws}\0${o.home}\0${o.xdgConfigHome ?? ""}`;
  const hit = cache.get(key);
  if (hit && hit.stamp === hit.info.watched.map((f) => fs.mtime(f)).join(",")) return hit.info;
  const info = resolveHooks(ws, o);
  cache.set(key, { stamp: info.watched.map((f) => fs.mtime(f)).join(","), info });
  return info;
};

/** Tests: forget cached answers. */
export const clearHooksCache = () => cache.clear();
