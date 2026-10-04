import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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
}

export interface ClassifyContext {
  policy: Policy;
  home: string;
  cwd: string;
  /** Resolves symlinks so a link inside a workspace can't point outside it. */
  realpath?: (p: string) => string;
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

interface Paths {
  resolve(p: string): string;
  inWorkspace(abs: string): boolean;
  hardFloor(abs: string): boolean;
  sensitive(abs: string): boolean;
  configOrCi(abs: string): boolean;
}

const pathsFor = (ctx: ClassifyContext): Paths => {
  const real = ctx.realpath ?? defaultRealpath;
  const expand = (p: string) => (p === "~" ? ctx.home : p.startsWith("~/") ? join(ctx.home, p.slice(2)) : p);
  const res = (p: string) => real(resolve(ctx.cwd, expand(p)));
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
  return {
    resolve: res,
    inWorkspace: (abs) => workspaces.some((w) => within(abs, w)),
    hardFloor: (abs) => within(abs, chalito),
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
  };
};

const base = (category: ToolCategory): Classification => ({
  tier: "LOW",
  category,
  reasons: [],
  hardFloor: false,
  sudo: false,
  workspaceEdit: false,
  noWorkspace: false,
});

/** Classifies access to a path for reading or writing. */
const classifyPath = (paths: Paths, raw: string, write: boolean, out: Classification): void => {
  const abs = paths.resolve(raw);
  if (paths.hardFloor(abs)) {
    out.tier = "CRITICAL";
    out.hardFloor = true;
    out.reasons.push("touches ~/.chalito");
    return;
  }
  if (paths.sensitive(abs)) {
    out.tier = max(out.tier, "CRITICAL");
    out.reasons.push("credentials path");
    return;
  }
  if (!paths.inWorkspace(abs)) {
    out.tier = max(out.tier, "HIGH");
    out.reasons.push("outside allowed folders");
    return;
  }
  if (write && paths.configOrCi(abs)) {
    out.tier = max(out.tier, "HIGH");
    out.reasons.push("config/CI/.env");
    return;
  }
  out.tier = max(out.tier, write ? "MED" : "LOW");
};

// ---- Shell ------------------------------------------------------------------------

interface Segment {
  words: string[];
  /** Redirection targets written by this segment (> file, >> file). */
  writes: string[];
  /** The command this segment pipes into, if any. */
  pipesTo: string | null;
}

/** Minimal POSIX-ish tokenizer: quotes, escapes, and the separators ; && || | & newline. */
export const splitShell = (command: string): Segment[] | null => {
  const segments: Segment[] = [];
  let words: string[] = [];
  let writes: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let hasWord = false;
  let pendingRedirect = false;
  const pushWord = () => {
    if (!hasWord) return;
    if (pendingRedirect) {
      writes.push(cur);
      pendingRedirect = false;
    } else words.push(cur);
    cur = "";
    hasWord = false;
  };
  const endSegment = (pipe: boolean) => {
    pushWord();
    const seg = { words, writes, pipesTo: null as string | null };
    if (segments.length && segments[segments.length - 1]!.pipesTo === "")
      segments[segments.length - 1]!.pipesTo = words[0] ?? null;
    segments.push(seg);
    if (pipe) seg.pipesTo = "";
    words = [];
    writes = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasWord = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      cur += command[++i];
      hasWord = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      pushWord();
      continue;
    }
    if (ch === "\n" || ch === ";") {
      endSegment(false);
      continue;
    }
    if (ch === "&" || ch === "|") {
      const doubled = command[i + 1] === ch;
      if (doubled) i++;
      endSegment(ch === "|" && !doubled);
      continue;
    }
    if (ch === ">") {
      pushWord();
      if (command[i + 1] === ">") i++;
      if (command[i + 1] === "&") {
        i++; // 2>&1 style: not a file
        continue;
      }
      pendingRedirect = true;
      continue;
    }
    cur += ch;
    hasWord = true;
  }
  if (quote) return null;
  endSegment(false);
  // Strip a leading fd number from "2>" style redirections that tokenised as a word.
  return segments
    .map((s) => ({
      ...s,
      words: s.words.filter((w, i, a) => !(/^\d$/.test(w) && i === a.length - 1 && s.writes.length)),
    }))
    .filter((s) => s.words.length > 0 || s.writes.length > 0);
};

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "python", "python3", "node", "perl", "ruby", "pwsh"]);
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

const classifySegment = (seg: Segment, ctx: ClassifyContext, paths: Paths, out: Classification): void => {
  const words = [...seg.words];
  while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift(); // FOO=bar cmd
  const cmd = (words[0] ?? "").split("/").pop() ?? "";
  const args = words.slice(1);
  const line = words.join(" ");
  const bump = (tier: RiskTier, reason: string) => {
    out.tier = max(out.tier, tier);
    out.reasons.push(reason);
  };

  for (const w of seg.writes) classifyPath(paths, w, true, out);

  if (["sudo", "doas", "su", "pkexec"].includes(cmd)) {
    bump("CRITICAL", "sudo");
    out.sudo = true;
    return;
  }
  if (seg.pipesTo && SHELLS.has(seg.pipesTo) && ["curl", "wget"].includes(cmd)) {
    bump("CRITICAL", "pipes a download into a shell");
    return;
  }
  if (["security", "secret-tool", "cmdkey", "keyctl"].includes(cmd)) {
    bump("CRITICAL", "keychain access");
    return;
  }
  if (["mkfs", "dd", "diskutil", "fdisk", "parted"].includes(cmd)) {
    bump("CRITICAL", "disk tool");
    return;
  }

  // Any argument that looks like a path is checked against workspaces and sensitive paths.
  for (const a of args) {
    if (a.startsWith("-") && !a.includes("=")) continue;
    const candidate = a.includes("=") ? a.slice(a.indexOf("=") + 1) : a;
    if (
      candidate.startsWith("/") ||
      candidate.startsWith("~") ||
      candidate.startsWith("..") ||
      candidate.includes("/")
    ) {
      if (/^[a-z]+:\/\//i.test(candidate)) continue; // URLs
      classifyPath(paths, candidate, false, out);
      if (out.hardFloor) return;
    }
  }

  if (cmd === "git") {
    const sub = args[0] ?? "";
    if (sub === "push") {
      const force = args.some(
        (a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || a.startsWith("+"),
      );
      const refs = args.slice(1).filter((a) => !a.startsWith("-"));
      const toMain = refs.some((r) => /(^|:|\+)(main|master)$/.test(r));
      if (force && (toMain || refs.length < 2)) bump("CRITICAL", "force-push to main");
      else bump("HIGH", "git push");
      return;
    }
    if (["status", "diff", "log", "show", "rev-parse", "blame", "ls-files"].includes(sub)) return; // LOW
    if (sub === "branch" && args.length <= 1) return;
    if (
      sub === "clean" ||
      (sub === "reset" && args.includes("--hard")) ||
      (sub === "checkout" && args.includes("--"))
    ) {
      bump("HIGH", "discards work");
      return;
    }
    bump("MED", "git write");
    return;
  }

  if (DELETERS.has(cmd) || (cmd === "find" && args.includes("-delete"))) {
    bump("HIGH", "deletes files");
    return;
  }
  if (EXTERNAL_WRITERS.has(cmd) || (cmd === "npm" && args[0] === "publish")) {
    bump("HIGH", "writes to an external service");
    return;
  }
  for (const [tool, re] of INSTALLERS) {
    if (cmd === tool && re.test(args[0] ?? "")) {
      bump("MED", "package install");
      return;
    }
  }
  if (["curl", "wget", "http", "xh"].includes(cmd)) {
    bump("MED", "network fetch");
    return;
  }
  if (ctx.policy.allowlist.commands.some((c) => line === c || line.startsWith(`${c} `))) return; // LOW
  if (READ_ONLY.has(cmd) && !(cmd === "find" && args.includes("-exec"))) return; // LOW
  bump("MED", "command");
};

const classifyBash = (command: string, ctx: ClassifyContext, paths: Paths): Classification => {
  const out = base("shell");
  if (/\$\(|`|<\(/.test(command)) {
    out.tier = "MED";
    out.reasons.push("command substitution");
  }
  const segments = splitShell(command);
  if (!segments) {
    out.tier = "HIGH";
    out.reasons.push("unparseable command");
    return out;
  }
  for (const seg of segments) {
    classifySegment(seg, ctx, paths, out);
    if (out.hardFloor) break;
  }
  // Substitutions are scanned as commands too (e.g. $(cat ~/.ssh/id_rsa)).
  for (const inner of command.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)) {
    const sub = classifyBash(inner[1] ?? inner[2] ?? "", ctx, paths);
    out.tier = max(out.tier, sub.tier);
    out.hardFloor ||= sub.hardFloor;
    out.sudo ||= sub.sudo;
    out.reasons.push(...sub.reasons);
  }
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
      classifyPath(paths, str(input.file_path) ?? str(input.notebook_path) ?? str(input.path) ?? ctx.cwd, false, out);
      return out;
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
      return known ? out : { ...out, tier: "MED", reasons: [`new domain ${host}`] };
    }
    case "WebSearch":
      return { ...base("web"), tier: "MED", reasons: ["web search"] };
    case "TodoWrite":
    case "Task":
    case "Agent":
    case "ExitPlanMode":
    case "EnterPlanMode":
    case "AskUserQuestion":
      return base("other");
    default: {
      if (toolName.startsWith("mcp__")) {
        const readOnly = ctx.policy.mcp.readOnlyTools.includes(toolName);
        return readOnly ? base("mcp") : { ...base("mcp"), tier: "HIGH", reasons: ["MCP tool may write externally"] };
      }
      return { ...base("other"), tier: "HIGH", reasons: [`unknown tool ${toolName}`] };
    }
  }
};

/** True when a path argument is absolute or home-relative (used by summaries). */
export const looksLikePath = (s: string) => isAbsolute(s) || s.startsWith("~");
