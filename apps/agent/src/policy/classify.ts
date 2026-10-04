import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { RiskTier, ToolCategory } from "@chalito/protocol";
import type { Policy } from "./schema.js";

/**
 * Risk classification of a single tool call (ADR 0008):
 *   LOW      auto-approved (reads inside workspaces, git status/diff/log, allowlisted test/lint/build)
 *   MED      one tap (edits in a workspace, other confined commands, package installs, new web domains)
 *   HIGH     tap + step-up (git push, deletes, config/CI/.env, anything outside workspaces, external writes)
 *   CRITICAL blocked (sudo, credentials, force-push to main, curl | sh, …)
 * `hardFloor` marks what nothing can unlock, Developer mode included (editing ~/.chalito).
 */
export interface Classification {
  tier: RiskTier;
  category: ToolCategory;
  reasons: string[];
  /** Never allowed, whatever the policy or Developer mode says. */
  hardFloor: boolean;
  /** CRITICAL only because of sudo/doas/su (unlockable with Developer mode allowSudo). */
  sudo: boolean;
  /** Plain file edit/create inside a workspace (what `acceptEdits` auto-allows). */
  workspaceEdit: boolean;
  /** No workspaces configured, or the session runs outside them: nothing runs. */
  noWorkspace: boolean;
  /**
   * Only reads or searches (Read/LS/Glob/Grep, read-only shell, BashOutput, allowlisted web
   * reads, read-only MCP tools, planning tools). Unsigned turns (mcp:, call:) get no auto-allow
   * for anything else (review R-C1).
   */
  readOnly: boolean;
}

export interface ClassifyContext {
  policy: Policy;
  home: string;
  cwd: string;
  /** Resolves symlinks so a link inside a workspace can't point outside it. */
  realpath?: (p: string) => string;
  /** The agent's own executables (`process.execPath` of the compiled agent, the installed `chalito`). Running them is the hard floor. */
  agentBinaries?: string[];
  /** Files the agent's integrity depends on outside ~/.chalito: the service unit/plist/task XML, the agent binary, the pinned `claude`. Hard floor. */
  protectedPaths?: string[];
  /** Directories on the session's PATH. Writing into them (outside workspaces) is CRITICAL: it replaces what later commands run. */
  pathDirs?: string[];
}

const RANK: Record<RiskTier, number> = { LOW: 0, MED: 1, HIGH: 2, CRITICAL: 3 };
const max = (a: RiskTier, b: RiskTier): RiskTier => (RANK[a] >= RANK[b] ? a : b);

/** Best-effort realpath: resolves the nearest existing ancestor and re-appends the rest. */
export const defaultRealpath = (p: string): string => {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      rest.push(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cur = parent;
    }
  }
};

const within = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** What a glob or unresolved prefix could reach: the hard floor, credentials, a persistence path, or neither. */
type Cover = "hard_floor" | "credentials" | "persistence" | null;

interface Paths {
  home: string;
  resolve(p: string, cwd?: string): string;
  inWorkspace(abs: string): boolean;
  hardFloor(abs: string): boolean;
  /** Why `abs` is the hard floor (~/.chalito, or an agent file outside it). */
  floorReason(abs: string): string;
  sensitive(abs: string): boolean;
  /** Shell startup files, autostart/service dirs and PATH dirs: writing there runs code later, outside the gate. */
  persistence(abs: string): boolean;
  /** The agent's own executables, resolved. */
  agentBinaries: string[];
  configOrCi(abs: string): boolean;
  /** Build/test manifests, lockfiles, tool configs and test code: editing them changes what a test or build run executes. */
  buildOrTest(abs: string): boolean;
  /** Whether a path that starts with `prefix` (then `next`, a glob/variable char) can land on a protected path. */
  covers(prefix: string, next: string, cwd: string): Cover;
}

const pathsFor = (ctx: ClassifyContext): Paths => {
  const real = ctx.realpath ?? defaultRealpath;
  const expand = (p: string) => (p === "~" ? ctx.home : p.startsWith("~/") ? join(ctx.home, p.slice(2)) : p);
  const res = (p: string, cwd = ctx.cwd) => real(resolve(cwd, expand(p)));
  const workspaces = ctx.policy.workspaces.map((w) => real(resolve(expand(w.path))));
  const h = (rel: string) => real(join(ctx.home, rel));
  const chalito = h(".chalito");
  const sensitiveDirs = [
    ".ssh",
    ".aws",
    ".azure",
    ".config/gcloud",
    ".kube",
    ".gnupg",
    ".password-store",
    ".config/gh",
    ".docker",
    ".local/share/keyrings",
    "Library/Keychains",
    ".codex",
  ].map(h);
  const sensitiveFiles = [
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    ".claude/.credentials.json",
    ".claude.json",
  ].map(h);
  const systemSecrets = ["/etc/shadow", "/etc/sudoers", "/etc/sudoers.d"];
  const inWorkspace = (abs: string) => workspaces.some((w) => within(abs, w));
  const protectedPaths = (ctx.protectedPaths ?? []).map((p) => real(resolve(expand(p))));
  const agentBinaries = (ctx.agentBinaries ?? []).map((p) => real(resolve(expand(p))));
  const floor = [chalito, ...protectedPaths, ...agentBinaries];
  const startupFiles = [
    ".bashrc",
    ".bash_profile",
    ".bash_login",
    ".bash_logout",
    ".profile",
    ".zshrc",
    ".zshenv",
    ".zprofile",
    ".zlogin",
    ".config/fish/config.fish",
    ".config/powershell/Microsoft.PowerShell_profile.ps1",
    ".config/powershell/profile.ps1",
    ".xprofile",
    ".xinitrc",
  ].map(h);
  const startupDirs = [
    ".local/bin",
    "bin",
    ".config/systemd/user",
    ".config/autostart",
    ".config/fish/conf.d",
    "Library/LaunchAgents",
    "Documents/PowerShell",
    "Documents/WindowsPowerShell",
    "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
  ].map(h);
  // PATH entries inside a workspace (node_modules/.bin, ./scripts) stay workspace paths.
  const pathDirs = (ctx.pathDirs ?? [])
    .filter((d) => isAbsolute(d) || d.startsWith("~"))
    .map((d) => real(resolve(expand(d))))
    .filter((d) => !inWorkspace(d) && d !== sep);
  const persistDirs = [...startupDirs, ...pathDirs];
  return {
    home: ctx.home,
    resolve: res,
    inWorkspace,
    hardFloor: (abs) => floor.some((f) => within(abs, f)),
    floorReason: (abs) => (within(abs, chalito) ? "touches ~/.chalito" : "touches the Chalito agent's own files"),
    persistence: (abs) => startupFiles.includes(abs) || persistDirs.some((d) => within(abs, d)),
    agentBinaries,
    sensitive: (abs) =>
      sensitiveDirs.some((d) => within(abs, d)) ||
      sensitiveFiles.includes(abs) ||
      abs === "/etc/shadow" ||
      abs === "/etc/sudoers" ||
      within(abs, "/etc/sudoers.d"),
    configOrCi: (abs) => {
      const parts = abs.split(sep);
      const base = parts[parts.length - 1] ?? "";
      return (
        /^\.env(\..*)?$/.test(base) ||
        parts.includes(".github") ||
        parts.includes(".circleci") ||
        parts.includes(".buildkite") ||
        ["Jenkinsfile", ".gitlab-ci.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml"].includes(base) ||
        // Files that can make code run later: git hooks, agent settings with hooks.
        abs.includes(`${sep}.git${sep}hooks${sep}`) ||
        abs.includes(`${sep}.git${sep}config`) ||
        (parts.includes(".claude") && /^settings(\.local)?\.json$/.test(base)) ||
        parts.includes(".husky")
      );
    },
    buildOrTest: (abs) => {
      const parts = abs.split(sep);
      const name = parts[parts.length - 1] ?? "";
      return (
        BUILD_FILES.has(name) ||
        TOOL_CONFIG.test(name) ||
        TEST_FILE.test(name) ||
        parts.slice(0, -1).some((p) => TEST_DIRS.has(p))
      );
    },
    covers: (prefix, next, cwd) => {
      // Split into a directory we can resolve and a partial last component ("~/.chal" → "~/", ".chal").
      const slash = prefix.lastIndexOf("/");
      let dirPart = prefix.slice(0, slash + 1);
      let partial = prefix.slice(slash + 1);
      if (partial === "." || partial === "..") {
        dirPart += partial;
        partial = "";
      }
      const dir = res(dirPart === "" ? "." : dirPart, cwd);
      const abs = (dir.endsWith(sep) ? dir : dir + sep) + partial;
      // `*`, `?` and `[…]` never match a leading dot; `{…}` and variables can produce anything.
      const dotSafe = partial === "" && "*?[".includes(next);
      const reaches = (target: string) => {
        if (within(abs.endsWith(sep) ? abs.slice(0, -1) || sep : abs, target)) return true;
        if (!target.startsWith(abs)) return false;
        return !(dotSafe && target.slice(abs.length).startsWith("."));
      };
      if (floor.some(reaches)) return "hard_floor";
      if ([...sensitiveDirs, ...sensitiveFiles, ...systemSecrets].some(reaches)) return "credentials";
      if ([...startupFiles, ...persistDirs].some(reaches)) return "persistence";
      return null;
    },
  };
};

/**
 * Files whose edit changes what a later build or test run executes (review R-C1): an Edit plus an
 * allowlisted `npm test` must never chain into running new code without a HIGH approval.
 */
const BUILD_FILES = new Set([
  // JS/TS
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  ".yarnrc",
  ".yarnrc.yml",
  ".npmrc",
  ".pnpmfile.cjs",
  "bun.lock",
  "bun.lockb",
  "bunfig.toml",
  "deno.json",
  "deno.jsonc",
  "turbo.json",
  "nx.json",
  "lerna.json",
  // make & task runners
  "Makefile",
  "makefile",
  "GNUmakefile",
  "justfile",
  "Justfile",
  "Taskfile.yml",
  "Taskfile.yaml",
  "CMakeLists.txt",
  // Python
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "conftest.py",
  "tox.ini",
  "noxfile.py",
  "pytest.ini",
  "requirements.txt",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  // Rust, Go, Ruby, JVM, PHP
  "Cargo.toml",
  "Cargo.lock",
  "build.rs",
  "go.mod",
  "go.sum",
  "Gemfile",
  "Gemfile.lock",
  "Rakefile",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradlew",
  "pom.xml",
  "composer.json",
  "composer.lock",
]);
/** `*.config.{js,ts,mjs,cjs,mts,cts}` (vitest, jest, playwright, vite, eslint, …). */
const TOOL_CONFIG = /\.config\.[cm]?[jt]s$/;
/** Test sources: `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`, `*_spec.rb`. */
const TEST_FILE = /\.(test|spec)\.[A-Za-z0-9]+$|_test\.[A-Za-z0-9]+$|^test_.*\.py$|_spec\.rb$/;
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e"]);

const base = (category: ToolCategory): Classification => ({
  tier: "LOW",
  category,
  reasons: [],
  hardFloor: false,
  sudo: false,
  workspaceEdit: false,
  noWorkspace: false,
  readOnly: false,
});

/** Reasons that made a classification CRITICAL, so `sudo` can mean "CRITICAL only because of sudo". */
const criticalReasons = new WeakMap<Classification, string[]>();
const crit = (out: Classification): string[] => {
  let list = criticalReasons.get(out);
  if (!list) criticalReasons.set(out, (list = []));
  return list;
};

const raise = (out: Classification, tier: RiskTier, reason: string): void => {
  out.tier = max(out.tier, tier);
  out.reasons.push(reason);
  if (tier === "CRITICAL") crit(out).push(reason);
};

const markHardFloor = (out: Classification, reason = "touches ~/.chalito"): void => {
  raise(out, "CRITICAL", reason);
  out.hardFloor = true;
};

/** Folds a nested classification (a `bash -c` script, a substitution) into `out`. */
const merge = (out: Classification, inner: Classification, floor: RiskTier = "LOW"): void => {
  out.tier = max(out.tier, max(inner.tier, floor));
  out.hardFloor ||= inner.hardFloor;
  out.reasons.push(...inner.reasons);
  crit(out).push(...crit(inner));
};

/**
 * Classifies access to a path for reading or writing. `configAlways` applies the
 * config/CI/.env check to reads too (shell arguments, where read vs write is a guess).
 */
const classifyPath = (
  paths: Paths,
  raw: string,
  write: boolean,
  out: Classification,
  cwd?: string,
  configAlways = false,
  persistAlways = configAlways,
): void => {
  const abs = paths.resolve(raw, cwd);
  if (paths.hardFloor(abs)) {
    markHardFloor(out, paths.floorReason(abs));
    return;
  }
  if (paths.sensitive(abs)) {
    raise(out, "CRITICAL", "credentials path");
    return;
  }
  // Shell arguments of anything but a read-only tool count as writes here: whether `curl -o` or `ln` writes is a guess.
  if ((write || persistAlways) && !paths.inWorkspace(abs) && paths.persistence(abs)) {
    raise(out, "CRITICAL", "startup file or PATH directory");
    return;
  }
  if (!paths.inWorkspace(abs)) {
    raise(out, "HIGH", "outside allowed folders");
    return;
  }
  if ((write || configAlways) && paths.configOrCi(abs)) {
    raise(out, "HIGH", "config/CI/.env");
    return;
  }
  if (write && paths.buildOrTest(abs)) {
    raise(out, "HIGH", "build/test manifest or test code");
    return;
  }
  out.tier = max(out.tier, write ? "MED" : "LOW");
};

// ---- Shell ------------------------------------------------------------------------

/** A word plus whether it had unquoted `$`, globs, braces or backticks (expanded by the shell). */
interface Word {
  text: string;
  dyn: boolean;
}

interface Segment {
  words: string[];
  /** Per word: had expansion characters outside single quotes. */
  dyn: boolean[];
  /** Redirection targets written by this segment (> file, >> file, &> file). */
  writes: Word[];
  /** Input redirections (< file). */
  reads: Word[];
  /** Text fed on stdin by a here-string or heredoc. */
  stdin: string | null;
  /** The segment piping into this one (a | b), if any. */
  pipedFrom: Segment | null;
}

const newSegment = (pipedFrom: Segment | null): Segment => ({
  words: [],
  dyn: [],
  writes: [],
  reads: [],
  stdin: null,
  pipedFrom,
});

/**
 * Minimal POSIX-ish tokenizer: quotes, escapes, comments, redirections (> >> &> >| < <<< <<),
 * heredoc bodies, subshell parentheses, and the separators ; && || | |& & newline.
 */
export const splitShell = (command: string): Segment[] | null => {
  const segments: Segment[] = [];
  let seg = newSegment(null);
  let lastNonEmpty: Segment | null = null;
  let cur = "";
  let dyn = false;
  let quote: '"' | "'" | null = null;
  let hasWord = false;
  let pending: "write" | "read" | "herestring" | null = null;
  const heredocs: { seg: Segment; delim: string; strip: boolean }[] = [];

  const pushWord = () => {
    if (!hasWord) return;
    const w = { text: cur, dyn };
    if (pending === "write") seg.writes.push(w);
    else if (pending === "read") seg.reads.push(w);
    else if (pending === "herestring") seg.stdin = cur;
    else {
      seg.words.push(cur);
      seg.dyn.push(dyn);
    }
    pending = null;
    cur = "";
    dyn = false;
    hasWord = false;
  };
  /** Before a redirection: a bare fd number ("2>") is not a word. */
  const pushBeforeRedirect = () => {
    if (hasWord && !dyn && /^\d+$/.test(cur)) {
      cur = "";
      hasWord = false;
      return;
    }
    pushWord();
  };
  const isEmpty = (s: Segment) => !s.words.length && !s.writes.length && !s.reads.length && s.stdin === null;
  const endSegment = (pipe: boolean) => {
    pushWord();
    if (isEmpty(seg)) {
      // "( a ) | b": the pipe comes from the last real segment.
      seg = newSegment(pipe ? lastNonEmpty : null);
      return;
    }
    segments.push(seg);
    lastNonEmpty = seg;
    seg = newSegment(pipe ? lastNonEmpty : null);
  };
  const readHeredocs = (from: number): number => {
    let i = from;
    for (const h of heredocs) {
      let body = "";
      for (;;) {
        if (i >= command.length) break;
        const end = command.indexOf("\n", i);
        const line = command.slice(i, end === -1 ? command.length : end);
        i = end === -1 ? command.length : end + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        body += `${line}\n`;
      }
      h.seg.stdin = body;
    }
    heredocs.length = 0;
    return i - 1;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else {
        if (quote === '"' && (ch === "$" || ch === "`")) dyn = true;
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasWord = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      if (next === "\n") {
        i++; // line continuation
        continue;
      }
      cur += command[++i];
      hasWord = true;
      continue;
    }
    if (ch === "#" && !hasWord) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === "`") {
      // Backtick substitution: one word, scanned separately as a command.
      const end = command.indexOf("`", i + 1);
      if (end === -1) return null;
      cur += command.slice(i, end + 1);
      i = end;
      dyn = true;
      hasWord = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      pushWord();
      continue;
    }
    if (ch === "\n" || ch === ";") {
      endSegment(false);
      // Heredoc bodies start on the line after their `<<`.
      if (ch === "\n" && heredocs.length) i = readHeredocs(i + 1);
      continue;
    }
    if (ch === "(" && !hasWord) {
      endSegment(false);
      continue;
    }
    if (ch === ")") {
      endSegment(false);
      continue;
    }
    if (ch === "&") {
      if (next === ">") {
        // &> file, &>> file
        pushWord();
        i++;
        if (command[i + 1] === ">") i++;
        pending = "write";
        continue;
      }
      if (next === "&") i++;
      endSegment(false);
      continue;
    }
    if (ch === "|") {
      if (next === "|") {
        i++;
        endSegment(false);
        continue;
      }
      if (next === "&") i++; // |& pipes stderr too
      endSegment(true);
      continue;
    }
    if (ch === ">") {
      if (next === "(" && !hasWord) {
        // >(cmd) process substitution: kept as a word, scanned separately.
        cur += ch;
        dyn = true;
        hasWord = true;
        continue;
      }
      pushBeforeRedirect();
      if (next === ">" || next === "|") i++;
      if (command[i + 1] === "&") {
        // 2>&1 style: duplicates a descriptor, not a file.
        i++;
        while (/[\d-]/.test(command[i + 1] ?? "")) i++;
        continue;
      }
      pending = "write";
      continue;
    }
    if (ch === "<") {
      if (next === "(" && !hasWord) {
        cur += ch;
        dyn = true;
        hasWord = true;
        continue;
      }
      pushBeforeRedirect();
      if (next === "<" && command[i + 2] === "<") {
        i += 2;
        pending = "herestring";
        continue;
      }
      if (next === "<") {
        i++;
        let strip = false;
        if (command[i + 1] === "-") {
          strip = true;
          i++;
        }
        while (command[i + 1] === " " || command[i + 1] === "\t") i++;
        let delim = "";
        while (i + 1 < command.length && !/[\s;|&<>()]/.test(command[i + 1]!)) {
          const c = command[++i]!;
          if (c !== "'" && c !== '"' && c !== "\\") delim += c;
        }
        heredocs.push({ seg, delim, strip });
        if (seg.stdin === null) seg.stdin = "";
        continue;
      }
      if (next === "&") {
        i++;
        while (/[\d-]/.test(command[i + 1] ?? "")) i++;
        continue;
      }
      pending = "read";
      continue;
    }
    if ("$*?[{".includes(ch)) dyn = true;
    cur += ch;
    hasWord = true;
  }
  if (quote) return null;
  endSegment(false);
  if (heredocs.length) readHeredocs(command.length);
  return segments;
};

/** POSIX shells: `-c` scripts are parsed and classified like any command line. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"]);
/** Interpreters: inline code is opaque. Flags that take inline code, per interpreter. */
const INTERPRETERS: Record<string, string[]> = {
  python: ["-c"],
  python2: ["-c"],
  python3: ["-c"],
  node: ["-e", "-p", "--eval", "--print"],
  nodejs: ["-e", "-p", "--eval", "--print"],
  deno: ["eval"],
  bun: ["-e", "--eval", "-p", "--print"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
  php: ["-r"],
  lua: ["-e"],
  osascript: ["-e"],
  Rscript: ["-e"],
};
/** Windows shells: not modelled yet, so anything they run is opaque. */
const WINDOWS_SHELLS = new Set(["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const SUDO = new Set(["sudo", "doas", "pkexec", "su"]);
/** The agent's CLI names. A session must never drive the agent (pair, policy edit, keys, service). */
const AGENT_NAMES = new Set(["chalito", "chalito-agent", "chalito.exe", "chalito-agent.exe"]);
/** The CLI's source entry, run through node/tsx/bun from a checkout. */
const AGENT_ENTRY = /(^|\/)apps\/agent\/src\/cli\.[cm]?[jt]s$/;
/** Agent names as a token inside opaque code or a script string. */
const AGENT_TOKEN = /(^|[\s'"`;|&(=,[])(chalito|chalito-agent)(?=$|[\s'"`;|&),\]])/;
/** Commands that run another program named in their arguments (and aren't modelled as wrappers). */
const LAUNCHERS = new Set([
  "node",
  "nodejs",
  "bun",
  "bunx",
  "deno",
  "tsx",
  "ts-node",
  "npx",
  "pnpx",
  "pnpm",
  "npm",
  "yarn",
  "script",
  "expect",
  "unbuffer",
  "setsid",
  "nohup",
  "open",
  "start",
  "launchctl",
  "systemd-run",
]);
/** Options of sudo-like commands that take a value. */
const SUDO_VALUE_OPTS = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U", "-R", "--user"]);

const READ_ONLY = new Set([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "find",
  "stat",
  "file",
  "tree",
  "less",
  "echo",
  "printf",
  "which",
  "true",
  "diff",
  "du",
  "sort",
  "uniq",
  "jq",
]);
/** Commands whose path operands are written (or have their metadata changed). */
const WRITERS = new Set(["cp", "mv", "install", "ln", "tee", "truncate", "touch", "chmod", "chown", "chgrp", "mkdir"]);
const DELETERS = new Set(["rm", "rmdir", "unlink", "shred", "trash"]);
const EXTERNAL_WRITERS = new Set([
  "gcloud",
  "aws",
  "az",
  "kubectl",
  "terraform",
  "tofu",
  "helm",
  "vercel",
  "firebase",
  "flyctl",
  "heroku",
  "docker",
  "ssh",
  "scp",
  "rsync",
  "sftp",
  "gh",
  "npm-publish",
  "twine",
]);
const NETWORK = new Set(["curl", "wget", "http", "xh"]);
const INSTALLERS: [string, RegExp][] = [
  ["npm", /^(i|install|add|ci|update|upgrade)$/],
  ["pnpm", /^(i|install|add|update|up)$/],
  ["yarn", /^(add|install|upgrade)$/],
  ["bun", /^(add|install|i)$/],
  ["pip", /^install$/],
  ["pip3", /^install$/],
  ["uv", /^(add|pip)$/],
  ["brew", /^install$/],
  ["cargo", /^(add|install)$/],
  ["go", /^(get|install)$/],
  ["gem", /^install$/],
];
/** Leading tokens that aren't the command: subshells, groups, negation, compound-command keywords. */
const LEADING = new Set(["(", "{", "}", "!", "then", "do", "else", "elif", "if", "while", "until", "fi", "done"]);
/** Variables that change what later commands run or load. */
const EXEC_VARS =
  /^(PATH|LD_\w+|DYLD_\w+|NODE_OPTIONS|BASH_ENV|ENV|PYTHONPATH|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|GIT_\w+|PAGER|EDITOR|VISUAL|LESSOPEN|PROMPT_COMMAND|IFS)$/;
/** Flag values that are prose, not paths (commit messages, PR bodies). */
const MESSAGE_FLAGS = new Set(["-m", "--message", "--body", "--title"]);

/**
 * Commands that run another command. `value` lists options that take a value;
 * `positional` is how many operands come before the command (timeout's duration).
 * An option not listed in `value` or `bare` is unknown: HIGH.
 */
interface WrapperSpec {
  value: string[];
  bare: string[];
  positional?: number;
}
const WRAPPERS: Record<string, WrapperSpec> = {
  env: { value: ["-u", "--unset", "-C", "--chdir"], bare: ["-i", "-0", "-v", "--ignore-environment", "--null", "-"] },
  nohup: { value: [], bare: [] },
  exec: { value: ["-a"], bare: ["-c", "-l"] },
  command: { value: [], bare: ["-p", "-v", "-V"] },
  builtin: { value: [], bare: [] },
  time: {
    value: ["-f", "--format", "-o", "--output"],
    bare: ["-p", "-a", "-v", "--append", "--verbose", "--portability"],
  },
  nice: { value: ["-n", "--adjustment"], bare: [] },
  ionice: { value: ["-c", "-n", "-p", "--class", "--classdata"], bare: ["-t"] },
  timeout: {
    value: ["-s", "--signal", "-k", "--kill-after"],
    bare: ["-v", "--verbose", "--preserve-status", "--foreground"],
    positional: 1,
  },
  stdbuf: { value: ["-i", "-o", "-e", "--input", "--output", "--error"], bare: [] },
  xargs: {
    value: ["-n", "-L", "-P", "-I", "-d", "-a", "-E", "-s", "--max-args", "--max-procs", "--delimiter", "--arg-file"],
    bare: ["-0", "-r", "-t", "-p", "-x", "--null", "--no-run-if-empty", "--verbose", "--interactive", "--exit"],
  },
  caffeinate: { value: ["-t", "-w"], bare: ["-d", "-i", "-m", "-s", "-u"] },
  watch: {
    value: ["-n", "--interval"],
    bare: ["-t", "-b", "-e", "-g", "-c", "-x", "-p", "-d", "--differences", "--no-title", "--exec"],
  },
  setsid: { value: [], bare: ["-c", "-f", "-w", "--ctty", "--fork", "--wait"] },
  unbuffer: { value: [], bare: [] },
  flock: {
    value: ["-w", "-E", "--timeout", "--conflict-exit-code"],
    bare: ["-s", "-x", "-u", "-n", "-o"],
    positional: 1,
  },
};

const cmdName = (w: string | undefined) => (w ?? "").split("/").pop() ?? "";
const isAssignment = (w: Word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text);

/** Shell state across the segments of one command line. */
interface ShellState {
  /** null once a `cd` went somewhere we can't resolve. */
  cwd: string | null;
  vars: Map<string, string | null>;
  /** An exec-affecting variable (PATH, LD_PRELOAD, …) was set: nothing after it is LOW. */
  tainted: boolean;
  /** An allowlisted runner (tests, lint, build) ran: LOW, but it executes code, so not read-only. */
  ranCode?: boolean;
}

interface Expanded {
  text: string;
  /** A variable, substitution or `~user` we couldn't expand. */
  unresolved: boolean;
  glob: boolean;
}

const expandWord = (w: Word, st: ShellState, paths: Paths): Expanded => {
  let text = w.text;
  if (text.startsWith("~+")) text = st.cwd === null ? "$PWD" + text.slice(2) : st.cwd + text.slice(2);
  const tildeUser = /^~[^/]/.test(text);
  if (!w.dyn) return { text, unresolved: tildeUser, glob: false };
  const lookup = (name: string): string | null | undefined => {
    if (name === "HOME") return paths.home;
    if (name === "USER" || name === "LOGNAME") return basename(paths.home);
    if (name === "PWD") return st.cwd;
    return st.vars.get(name);
  };
  text = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a?: string, b?: string) => {
    const v = lookup((a ?? b)!);
    return typeof v === "string" ? v : m;
  });
  return { text, unresolved: tildeUser || /[$`]/.test(text), glob: /[*?[{]/.test(text) };
};

interface WordOpts {
  write?: boolean;
  /** Unresolved remainder is ignored (prose: echo arguments, commit messages). */
  prose?: boolean;
  /** The command only reads its operands (ls, cat, …): startup files and PATH dirs are just outside the workspace. */
  readOnly?: boolean;
}

/**
 * Classifies a shell word as a path after expanding what can be expanded. Unresolved
 * variables are HIGH; a glob or variable whose static prefix can reach ~/.chalito is the
 * hard floor, one that can reach credentials is CRITICAL.
 */
const classifyWord = (w: Word, st: ShellState, paths: Paths, out: Classification, opts: WordOpts = {}): void => {
  const e = expandWord(w, st, paths);
  const absolute = e.text.startsWith("/") || e.text.startsWith("~");
  if (!absolute && st.cwd === null) {
    if (!opts.prose) raise(out, "HIGH", "unknown working directory");
    return;
  }
  const cwd = st.cwd ?? paths.home;
  if (!e.unresolved && !e.glob) {
    classifyPath(paths, e.text, opts.write ?? false, out, cwd, true, !opts.readOnly);
    return;
  }
  const at = e.text.search(/[$`*?[{]/);
  const prefix = at === -1 ? e.text : e.text.slice(0, at);
  const next = at === -1 ? "" : e.text[at]!;
  // "~user/…" can't be resolved from here.
  const tildeUser = /^~[^/]/.test(prefix);
  if (!tildeUser) {
    const cover = paths.covers(prefix, next, cwd);
    if (cover === "hard_floor") return markHardFloor(out, "may touch ~/.chalito or the agent's own files");
    if (cover === "credentials") return raise(out, "CRITICAL", "credentials path");
    if (cover === "persistence" && (opts.write || (!opts.prose && !opts.readOnly)))
      return raise(out, "CRITICAL", "startup file or PATH directory");
  }
  if (e.unresolved) {
    if (!opts.prose) raise(out, "HIGH", "unresolved variable or substitution");
    return;
  }
  // Glob only: classify the directory the glob expands in.
  const dir = prefix === "" || prefix.endsWith("/") ? prefix || "." : dirname(prefix);
  classifyPath(paths, dir, opts.write ?? false, out, cwd, true, !opts.readOnly);
};

const looksPathy = (s: string) => s.includes("/") || s.startsWith("~") || s.startsWith("$") || s.startsWith(".");

/** Text a producer pipes into a shell, when we can know it (echo/printf arguments). */
const producedText = (seg: Segment | null): string | null => {
  if (!seg) return null;
  const cmd = cmdName(seg.words[0]);
  return cmd === "echo" || cmd === "printf" ? seg.words.slice(1).join(" ") : null;
};
const producerCmd = new WeakMap<Segment, string>();

/** Opaque code (interpreter -c/-e, stdin scripts): at least HIGH, hard floor if it names ~/.chalito. */
const opaqueCode = (code: string | null, reason: string, out: Classification): void => {
  raise(out, "HIGH", reason);
  if (code === null) return;
  if (AGENT_TOKEN.test(code)) markHardFloor(out, "runs the Chalito agent CLI");
  else if (/\.chalito(?![\w-])/.test(code)) markHardFloor(out);
  else if (
    /\.(ssh|aws|gnupg|kube|docker|azure|password-store|netrc|git-credentials)\b|\.config\/(gcloud|gh)\b/.test(code)
  )
    raise(out, "CRITICAL", "credentials path");
};

const classifySegment = (
  seg: Segment,
  ctx: ClassifyContext,
  paths: Paths,
  st: ShellState,
  out: Classification,
): void => {
  let words: Word[] = seg.words.map((text, i) => ({ text, dyn: seg.dyn[i] ?? false }));

  // Redirections are performed by the shell, whatever the command.
  for (const w of seg.writes) classifyWord(w, st, paths, out, { write: true });
  for (const w of seg.reads) classifyWord(w, st, paths, out);
  if (out.hardFloor) return;
  if (st.tainted) raise(out, "MED", "after an exec-affecting variable");

  const assign = (w: Word) => {
    const eq = w.text.indexOf("=");
    const name = w.text.slice(0, eq);
    const value: Word = { text: w.text.slice(eq + 1), dyn: w.dyn };
    if (value.text) classifyWord(value, st, paths, out, { prose: true });
    const e = expandWord(value, st, paths);
    st.vars.set(name, e.unresolved || e.glob ? null : e.text.startsWith("~") ? paths.resolve(e.text) : e.text);
    if (EXEC_VARS.test(name)) {
      raise(out, "MED", `sets ${name}`);
      st.tainted = true;
    }
  };
  const strip = () => {
    while (words[0] && LEADING.has(words[0].text)) words.shift();
    if (words[0]) words[0] = { ...words[0], text: words[0].text.replace(/^[({!]+/, "") };
    while (words[0] && isAssignment(words[0])) assign(words.shift()!); // FOO=bar cmd
  };
  strip();
  for (const w of ["export", "declare", "local", "readonly", "typeset"])
    if (words[0]?.text === w) {
      for (const a of words.slice(1)) if (isAssignment(a)) assign(a);
      return;
    }
  if (out.hardFloor) return;

  // Unwrap sudo/env/nohup/timeout/xargs/… so the real command is what gets classified.
  let viaXargs = false;
  for (let depth = 0; depth < 8 && words.length; depth++) {
    const w = cmdName(words[0]!.text);
    if (SUDO.has(w)) {
      raise(out, "CRITICAL", "sudo");
      let i = 1;
      while (i < words.length && words[i]!.text.startsWith("-")) {
        const flag = words[i]!.text;
        if (w === "su" && (flag === "-c" || flag === "--command")) {
          const script = words[i + 1];
          if (script) merge(out, classifyBash(script.text, ctx, paths, { ...st, vars: new Map(st.vars) }), "MED");
          return;
        }
        i += SUDO_VALUE_OPTS.has(flag) ? 2 : 1;
      }
      if (w === "su") return;
      words = words.slice(i);
      out.reasons.push(`via ${w}`);
      continue;
    }
    const spec = WRAPPERS[w];
    if (!spec) break;
    out.reasons.push(`via ${w}`);
    if (w === "xargs") viaXargs = true;
    let i = 1;
    while (i < words.length) {
      const t = words[i]!.text;
      if (w === "env" && isAssignment(words[i]!)) {
        assign(words[i]!);
        i++;
        continue;
      }
      if (!t.startsWith("-") || t === "--") {
        if (t === "--") i++;
        break;
      }
      if (w === "env" && (t === "-S" || t === "--split-string")) {
        const script = words[i + 1];
        if (script) merge(out, classifyBash(script.text, ctx, paths, { ...st, vars: new Map(st.vars) }), "MED");
        return;
      }
      const opt = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
      if (spec.value.includes(opt)) {
        if (w === "xargs" && (opt === "-a" || opt === "--arg-file") && words[i + 1])
          classifyWord(words[i + 1]!, st, paths, out);
        i += t.includes("=") ? 1 : 2;
      } else if (spec.bare.includes(opt) || (w === "nice" && /^-\d+$/.test(t))) {
        i++;
      } else if (spec.value.some((v) => v.length === 2 && t.startsWith(v))) {
        i++; // attached value: -n1, -oL
      } else {
        raise(out, "HIGH", `unknown ${w} option ${t}`);
        i++;
      }
    }
    for (let p = 0; p < (spec.positional ?? 0) && i < words.length; p++) {
      if (w === "flock") classifyWord(words[i]!, st, paths, out, { write: true });
      i++;
    }
    words = words.slice(i);
    strip();
  }
  if (out.hardFloor || words.length === 0) return;

  const cmd = cmdName(words[0]!.text);
  const args = words.slice(1);
  const texts = args.map((a) => a.text);
  producerCmd.set(seg, cmd);

  // The agent's own CLI: directly, by path, or through a launcher (npx chalito, tsx apps/agent/src/cli.ts, script -c …).
  const isAgent = (w: Word) => {
    const e = expandWord(w, st, paths);
    if (AGENT_NAMES.has(cmdName(e.text))) return true;
    if (!looksPathy(e.text) || e.unresolved) return false;
    const abs = paths.resolve(e.text, st.cwd ?? paths.home);
    return paths.agentBinaries.includes(abs) || AGENT_ENTRY.test(abs);
  };
  if (isAgent(words[0]!)) return markHardFloor(out, "runs the Chalito agent CLI");
  if (LAUNCHERS.has(cmd)) {
    if (args.some(isAgent) || (texts.includes("@chalito/agent") && texts.some((t) => /(^|\/)cli\.[cm]?[jt]s$/.test(t))))
      return markHardFloor(out, "runs the Chalito agent CLI");
    // script -c "…", script -qc "…": a command line run in a pty.
    if (cmd === "script") {
      const cIdx = args.findIndex((a) => /^-[A-Za-z]*c$/.test(a.text) || a.text === "--command");
      const inner = cIdx >= 0 ? texts[cIdx + 1] : texts.find((t) => t.startsWith("--command="))?.slice(10);
      if (inner !== undefined) {
        merge(out, classifyBash(inner, ctx, paths, { ...st, vars: new Map(st.vars) }), "MED");
        if (out.hardFloor) return;
      }
    }
    if (cmd === "expect" && texts.some((t) => AGENT_TOKEN.test(t)))
      return markHardFloor(out, "runs the Chalito agent CLI");
  }
  if (words[0]!.dyn && expandWord(words[0]!, st, paths).unresolved) raise(out, "HIGH", "dynamic command name");

  if (WINDOWS_SHELLS.has(cmd.toLowerCase())) {
    raise(out, "HIGH", "Windows shell (not modelled)");
    return;
  }

  const stdinCode = seg.stdin ?? producedText(seg.pipedFrom);
  const fedByDownload = seg.pipedFrom !== null && NETWORK.has(producerCmd.get(seg.pipedFrom) ?? "");

  // bash -c "…", sh -lc, eval "…": classify the inner script as a command line.
  if (SHELLS.has(cmd) || cmd === "eval") {
    const cIdx = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a.text));
    const script = cmd === "eval" ? texts.join(" ") : cIdx >= 0 ? texts[cIdx + 1] : undefined;
    if (script !== undefined) {
      merge(out, classifyBash(script, ctx, paths, { ...st, vars: new Map(st.vars) }), "MED");
      out.reasons.push(`inline ${cmd}`);
      return;
    }
    const file = args.find((a) => !a.text.startsWith("-"));
    if (file) {
      // `bash script.sh`: runs a file. Check the path, then treat as MED.
      classifyWord(file, st, paths, out);
      raise(out, "MED", "runs a script");
      return;
    }
    if (fedByDownload) return raise(out, "CRITICAL", "pipes a download into a shell");
    if (stdinCode !== null || seg.pipedFrom) {
      opaqueCode(stdinCode, "runs a script from input", out);
      if (stdinCode) merge(out, classifyBash(stdinCode, ctx, paths, { ...st, vars: new Map(st.vars) }));
      return;
    }
    raise(out, "MED", "interactive shell");
    return;
  }

  const inline = INTERPRETERS[cmd];
  if (inline) {
    const at = args.findIndex(
      (a) =>
        inline.includes(a.text) ||
        inline.some((f) => f.startsWith("--") && a.text.startsWith(`${f}=`)) ||
        ((cmd === "perl" || cmd === "ruby") && /^-[A-Za-z]*[eE][A-Za-z]*$/.test(a.text)),
    );
    if (at >= 0) {
      const t = args[at]!.text;
      opaqueCode(t.includes("=") ? t.slice(t.indexOf("=") + 1) : (texts[at + 1] ?? ""), `inline ${cmd} code`, out);
      return;
    }
    const file = args.find((a) => !a.text.startsWith("-"));
    if (file) {
      classifyWord(file, st, paths, out);
      raise(out, "MED", "runs a script");
      return;
    }
    if (fedByDownload) return raise(out, "CRITICAL", "pipes a download into a shell");
    opaqueCode(stdinCode, `${cmd} reads code from input`, out);
    return;
  }

  if (cmd === "cd" || cmd === "pushd" || cmd === "popd") {
    const target = args.find((a) => !a.text.startsWith("-") || a.text === "-");
    if (cmd === "popd" || target?.text === "-") {
      st.cwd = null;
      return;
    }
    const dest = target ?? { text: "~", dyn: false };
    classifyWord(dest, st, paths, out);
    const e = expandWord(dest, st, paths);
    const relativeToUnknown = st.cwd === null && !e.text.startsWith("/") && !e.text.startsWith("~");
    st.cwd = e.unresolved || e.glob || relativeToUnknown ? null : paths.resolve(e.text, st.cwd ?? paths.home);
    return;
  }

  if (["security", "secret-tool", "cmdkey", "keyctl"].includes(cmd)) return raise(out, "CRITICAL", "keychain access");
  if (["mkfs", "dd", "diskutil", "fdisk", "parted"].includes(cmd)) return raise(out, "CRITICAL", "disk tool");

  // Every argument is checked as a path (workspaces, credentials, config/CI, the hard floor).
  const prose = cmd === "echo" || cmd === "printf";
  const inPlace = (cmd === "sed" || cmd === "perl") && texts.some((t) => /^-[^-]*i/.test(t) || t === "--in-place");
  const writes = WRITERS.has(cmd) || inPlace;
  const readOnly = READ_ONLY.has(cmd) && !writes;
  const network = NETWORK.has(cmd);
  const vcs = ["git", "gh", "hg", "jj", "svn"].includes(cmd);
  // curl -d @file, -F name=@file / name=<file: the file is read and sent.
  const unAt = (t: string) => (network ? t.replace(/^[@<]/, "") : t);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const t = a.text;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) continue; // URLs
    if (t.startsWith("-")) {
      const eq = t.indexOf("=");
      if (eq > 0) {
        const value = unAt(t.slice(eq + 1));
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) continue;
        classifyWord({ text: value, dyn: a.dyn }, st, paths, out, {
          write: writes,
          prose: vcs && MESSAGE_FLAGS.has(t.slice(0, eq)),
          readOnly,
        });
      } else if (/^-[A-Za-z]./.test(t) && looksPathy(t.slice(2))) {
        // Attached short-option value: -o/path, -C~/dir.
        classifyWord({ text: t.slice(2), dyn: a.dyn }, st, paths, out, { write: writes, readOnly });
      }
      if (vcs && MESSAGE_FLAGS.has(t) && args[i + 1]) i++; // the message itself is prose
      if (out.hardFloor) return;
      continue;
    }
    const value = unAt(t.includes("=") && network ? t.slice(t.indexOf("=") + 1).replace(/^[@<]/, "") : t);
    classifyWord({ text: value, dyn: a.dyn }, st, paths, out, { write: writes, prose, readOnly });
    if (out.hardFloor) return;
  }
  if (writes) raise(out, viaXargs ? "HIGH" : "MED", viaXargs ? "writes to paths read from input" : "writes files");

  /** Marks `w` as written by the command (sort -o, find -fprint, …). */
  const writtenBy = (w: Word | undefined, reason: string) => {
    if (w) classifyWord(w, st, paths, out, { write: true });
    raise(out, "MED", reason);
  };
  const optValue = (names: string[]): Word | undefined => {
    for (let i = 0; i < args.length; i++) {
      const t = args[i]!.text;
      for (const n of names) {
        if (t === n) return args[i + 1];
        if (n.startsWith("--") && t.startsWith(`${n}=`)) return { text: t.slice(n.length + 1), dyn: args[i]!.dyn };
        if (!n.startsWith("--") && t.startsWith(n) && t.length > n.length)
          return { text: t.slice(n.length), dyn: args[i]!.dyn };
      }
    }
    return undefined;
  };

  if (cmd === "git") {
    // Global options before the subcommand.
    let i = 0;
    while (i < args.length && texts[i]!.startsWith("-")) {
      const t = texts[i]!;
      if (t === "-C" || t === "--git-dir" || t === "--work-tree" || t === "--namespace") {
        if (args[i + 1]) classifyWord(args[i + 1]!, st, paths, out);
        i += 2;
        continue;
      }
      if (t === "-c" || t.startsWith("--exec-path") || t.startsWith("--config-env")) {
        raise(out, "MED", "git with config override");
        i += t === "-c" ? 2 : 1;
        continue;
      }
      i++;
    }
    const sub = texts[i] ?? "";
    const rest = texts.slice(i + 1);
    if (sub === "push") {
      const force = rest.some(
        (a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || a.startsWith("+"),
      );
      const refs = rest.filter((a) => !a.startsWith("-"));
      const toMain = refs.some((r) => /(^|:|\+)(main|master)$/.test(r));
      if (force && (toMain || refs.length < 2)) raise(out, "CRITICAL", "force-push to main");
      else raise(out, "HIGH", "git push");
      return;
    }
    if (["status", "diff", "log", "show", "rev-parse", "blame", "ls-files"].includes(sub)) {
      const output = optValue(["--output"]);
      if (output) writtenBy(output, "git writes a file");
      if (rest.includes("--ext-diff")) raise(out, "MED", "external diff tool");
      return; // LOW
    }
    if (sub === "branch" && rest.length === 0) return;
    if (
      sub === "clean" ||
      (sub === "reset" && rest.includes("--hard")) ||
      (sub === "checkout" && rest.includes("--"))
    ) {
      raise(out, "HIGH", "discards work");
      return;
    }
    raise(out, "MED", "git write");
    return;
  }

  if (DELETERS.has(cmd) || (cmd === "find" && texts.includes("-delete"))) {
    raise(out, "HIGH", "deletes files");
    return;
  }
  if (EXTERNAL_WRITERS.has(cmd) || (cmd === "npm" && texts[0] === "publish")) {
    raise(out, "HIGH", "writes to an external service");
    return;
  }
  for (const [tool, re] of INSTALLERS) {
    if (cmd === tool && re.test(texts[0] ?? "")) {
      raise(out, "MED", "package install");
      return;
    }
  }
  if (network) {
    raise(out, "MED", "network fetch");
    return;
  }

  // Read-only tools with options that write files or run programs.
  if (cmd === "find") {
    for (let i = 0; i < args.length; i++) {
      const t = texts[i]!;
      if (["-exec", "-execdir", "-ok", "-okdir"].includes(t)) {
        let end = i + 1;
        while (end < args.length && texts[end] !== ";" && texts[end] !== "+") end++;
        const inner = args.slice(i + 1, end);
        const sub = newSegment(null);
        sub.words = inner.map((w) => w.text);
        sub.dyn = inner.map((w) => w.dyn);
        classifySegment(sub, ctx, paths, { ...st, vars: new Map(st.vars) }, out);
        raise(out, "MED", `find ${t}`);
        i = end;
      } else if (["-fprint", "-fprint0", "-fprintf", "-fls"].includes(t)) {
        writtenBy(args[i + 1], `find ${t}`);
        i++;
      }
    }
  }
  if (cmd === "rg") {
    const pre = optValue(["--pre"]);
    if (pre) {
      classifyWord(pre, st, paths, out);
      raise(out, "MED", "rg runs a preprocessor");
    }
  }
  if (cmd === "sort") {
    const o = optValue(["--output", "-o"]);
    if (o) writtenBy(o, "sort writes a file");
  }
  if (cmd === "tree") {
    const o = optValue(["-o"]);
    if (o) writtenBy(o, "tree writes a file");
  }
  if (cmd === "uniq") {
    const operands = args.filter((a) => !a.text.startsWith("-"));
    if (operands.length >= 2) writtenBy(operands[1], "uniq writes a file");
  }

  // Allowlisted test/lint/build commands: exact, or followed only by paths that are LOW on their own.
  const allowlisted = ctx.policy.allowlist.commands.some((c) => {
    const parts = c.split(/\s+/);
    if (parts.some((p, i) => words[i]?.text !== p)) return false;
    return words.slice(parts.length).every((w) => {
      if (w.text.startsWith("-") || w.dyn) return false;
      const probe = base("shell");
      classifyWord(w, st, paths, probe);
      return probe.tier === "LOW";
    });
  });
  if (allowlisted) {
    st.ranCode = true;
    return; // LOW, but runs project code
  }
  if (READ_ONLY.has(cmd)) return; // LOW unless an option above raised it
  raise(out, "MED", "command");
};

const classifyBash = (command: string, ctx: ClassifyContext, paths: Paths, state?: ShellState): Classification => {
  const out = base("shell");
  if (/\$\(|`|<\(|>\(/.test(command)) raise(out, "MED", "command substitution");
  const segments = splitShell(command);
  if (!segments) {
    raise(out, "HIGH", "unparseable command");
    return out;
  }
  const st: ShellState = state ?? { cwd: ctx.cwd, vars: new Map(), tainted: false };
  for (const seg of segments) {
    classifySegment(seg, ctx, paths, st, out);
    if (out.hardFloor) break;
  }
  // Substitutions are scanned as commands too (e.g. $(cat ~/.ssh/id_rsa), <(…)).
  for (const inner of command.matchAll(/\$\(([^)]*)\)|`([^`]*)`|[<>]\(([^)]*)\)/g)) {
    const sub = classifyBash(inner[1] ?? inner[2] ?? inner[3] ?? "", ctx, paths, {
      ...st,
      vars: new Map(st.vars),
    });
    merge(out, sub);
    if (!sub.readOnly) st.ranCode = true;
  }
  // sudo is unlockable (allowSudo) only when it's the sole reason for CRITICAL.
  const reasons = crit(out);
  out.sudo = reasons.length > 0 && reasons.every((r) => r === "sudo");
  // Read-only: every segment was a read-only command (no runner, no write, nothing raised).
  out.readOnly = out.tier === "LOW" && !st.ranCode && !/\$\(|`|<\(|>\(/.test(command);
  return out;
};

type Input = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export const classifyToolCall = (toolName: string, input: Input, ctx: ClassifyContext): Classification => {
  const paths = pathsFor(ctx);
  if (ctx.policy.workspaces.length === 0 || !paths.inWorkspace(paths.resolve(ctx.cwd))) {
    return { ...base("other"), tier: "CRITICAL", noWorkspace: true, reasons: ["no allowed workspace"] };
  }

  switch (toolName) {
    case "Read":
    case "NotebookRead":
    case "LS":
    case "Glob":
    case "Grep": {
      const out = base(toolName === "Grep" || toolName === "Glob" ? "search" : "read");
      const target = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) ?? ctx.cwd;
      classifyPath(paths, target, false, out);
      // Glob's pattern and Grep's glob filter are paths too ("/home/me/.ssh/**").
      const pattern = toolName === "Glob" ? str(input.pattern) : toolName === "Grep" ? str(input.glob) : undefined;
      if (pattern && !out.hardFloor) {
        const st: ShellState = { cwd: paths.resolve(target), vars: new Map(), tainted: false };
        classifyWord({ text: pattern, dyn: true }, st, paths, out);
      }
      return { ...out, readOnly: true };
    }
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const out = base(toolName === "Write" ? "create" : "edit");
      const target = str(input.file_path) ?? str(input.notebook_path);
      if (!target) return { ...out, tier: "HIGH", reasons: ["edit without a path"] };
      classifyPath(paths, target, true, out);
      out.workspaceEdit = out.tier === "MED";
      return out;
    }
    case "Bash":
    case "BashOutput":
    case "KillShell":
    case "KillBash": {
      if (toolName === "BashOutput") return { ...base("shell"), readOnly: true };
      if (toolName !== "Bash") return base("shell");
      return classifyBash(str(input.command) ?? "", ctx, paths);
    }
    case "WebFetch": {
      const out = base("web");
      let host = "";
      try {
        host = new URL(str(input.url) ?? "").hostname;
      } catch {
        return { ...out, tier: "HIGH", reasons: ["bad url"] };
      }
      const known = ctx.policy.web.allowDomains.some((d) => host === d || host.endsWith(`.${d}`));
      return known ? { ...out, readOnly: true } : { ...out, tier: "MED", reasons: [`new domain ${host}`] };
    }
    case "WebSearch":
      return { ...base("web"), tier: "MED", reasons: ["web search"] };
    case "TodoWrite":
    case "ExitPlanMode":
    case "EnterPlanMode":
    case "AskUserQuestion":
      return { ...base("other"), readOnly: true };
    case "Task":
    case "Agent":
      // Spawns a subagent; its own tool calls are gated, but starting one isn't a read.
      return base("other");
    default: {
      if (toolName.startsWith("mcp__")) {
        const readOnly = ctx.policy.mcp.readOnlyTools.includes(toolName);
        return readOnly
          ? { ...base("mcp"), readOnly: true }
          : { ...base("mcp"), tier: "HIGH", reasons: ["MCP tool may write externally"] };
      }
      return { ...base("other"), tier: "HIGH", reasons: [`unknown tool ${toolName}`] };
    }
  }
};

/** True when a path argument is absolute or home-relative (used by summaries). */
export const looksLikePath = (s: string) => isAbsolute(s) || s.startsWith("~");
