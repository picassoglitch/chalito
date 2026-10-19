import { rememberMatchFor, ruleMatchText, type AutoKind } from "@chalito/protocol";
import { splitShell, type Classification } from "../policy/classify.js";

/**
 * Coordinator mode (ADR 0025 §6): what Chalito answers for the owner on a helper's prompt. Runs
 * only after `decide` said "ask", only for a coordinator helper session, and only on a computer
 * whose signed local policy turned coordinator mode on. It can only turn an "ask" into an allow;
 * a deny (hard floor, no workspace, policy block, plan mode) never reaches it.
 *
 * Every classifier reason must map to an allowed kind: a command that mixes `git add` with `rm`
 * or `curl` carries an unmapped reason and asks the owner.
 */

/** Local git subcommands Chalito may run for the owner (the owner's "commits and branches"). */
const GIT_LOCAL = new Set(["add", "commit", "branch", "checkout", "switch", "merge", "stash"]);
/** Options that make those subcommands delete something: always the owner's call. */
const GIT_DELETING: Record<string, RegExp> = {
  branch: /^(-d|-D|--delete|-m|-M|--move|-c|-C|--copy|-f|--force)$/,
  stash: /^(drop|clear)$/,
  switch: /^(-f|--force|--discard-changes|-C|--force-create)$/,
  merge: /^(--abort|--quit)$/,
};

/**
 * Installs that change only the project (its manifest, lockfile and local packages). Global
 * installs and installers that write into the system or the user's home ask (owner: "anything
 * outside the project folder").
 */
const PROJECT_INSTALLS: [string, RegExp][] = [
  ["npm", /^(i|install|add|ci)$/],
  ["pnpm", /^(i|install|add)$/],
  ["yarn", /^(add|install)$/],
  ["bun", /^(add|install|i)$/],
  ["uv", /^add$/],
  ["cargo", /^add$/],
  ["go", /^get$/],
];
/** Every install the classifier calls "package install" (policy/classify.ts INSTALLERS). */
const ANY_INSTALL: [string, RegExp][] = [
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
const isInstall = (w: string[]): boolean => ANY_INSTALL.some(([tool, re]) => w[0] === tool && re.test(w[1] ?? ""));
const GLOBAL_FLAG = /^(-g|--global|--location=global|--prefix(=.*)?|--target(=.*)?|--root(=.*)?|--user)$/;

/** A named remote (never a URL or path) and a branch under the plan's prefix, nothing else. */
const REMOTE_NAME = /^[A-Za-z0-9._-]+$/;
const BRANCH_REST = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

type Words = string[];

/** The plain words of each segment, or null when any segment has redirections or expansions. */
const plainSegments = (command: string): Words[] | null => {
  if (/\$\(|`|<\(|>\(/.test(command)) return null;
  const segs = splitShell(command);
  if (!segs || segs.length === 0) return null;
  const out: Words[] = [];
  for (const s of segs) {
    if (s.words.length === 0) continue;
    if (s.writes.length || s.reads.length || s.stdin !== null || s.dyn.some(Boolean)) return null;
    out.push(s.words);
  }
  return out;
};

const gitSub = (w: Words): { sub: string; rest: Words } | null => {
  if (w[0] !== "git") return null;
  // Global options (`-C`, `-c`, `--git-dir`, …) are the owner's call.
  if (w[1]?.startsWith("-")) return null;
  return { sub: w[1] ?? "", rest: w.slice(2) };
};

const isLocalGit = (w: Words): boolean => {
  const g = gitSub(w);
  if (!g || !GIT_LOCAL.has(g.sub)) return false;
  // `git checkout <path>` throws work away and looks just like `git checkout <branch>`: only the
  // new-branch form is Chalito's call (switching branches is `git switch`).
  if (g.sub === "checkout")
    return (
      /^-[bB]$/.test(g.rest[0] ?? "") &&
      g.rest.length >= 2 &&
      g.rest.length <= 3 &&
      g.rest.slice(1).every((a) => !a.startsWith("-") && a !== ".")
    );
  const deleting = GIT_DELETING[g.sub];
  return !deleting || !g.rest.some((a) => deleting.test(a));
};

const isProjectInstall = (w: Words): boolean =>
  PROJECT_INSTALLS.some(([tool, re]) => w[0] === tool && re.test(w[1] ?? "")) && !w.some((a) => GLOBAL_FLAG.test(a));

/** `git push [-u|--set-upstream] <remote> <prefix>…`, with nothing else. */
const isPlanBranchPush = (w: Words, prefix: string): boolean => {
  const g = gitSub(w);
  if (!g || g.sub !== "push") return false;
  const args = g.rest.filter((a) => a !== "-u" && a !== "--set-upstream");
  if (args.length !== 2) return false;
  const [remote, ref] = args as [string, string];
  if (!REMOTE_NAME.test(remote) || !ref.startsWith(prefix)) return false;
  const rest = ref.slice(prefix.length);
  return BRANCH_REST.test(rest) && !rest.split("/").some((p) => p === "." || p === "..");
};

/** Which allowed kind a classified prompt is, or null when the owner must answer it. */
export const autoKindOf = (
  c: Classification,
  toolName: string,
  input: Record<string, unknown>,
  branchPrefix: string,
): AutoKind | null => {
  if (c.hardFloor || c.noWorkspace) return null;
  if (c.readOnly) return "read";
  if (c.tier === "LOW") return c.category === "shell" ? "tests" : "read";
  if (c.tier === "MED" && c.workspaceEdit && c.reasons.length === 0) return "workspace_edit";
  // Test code and build manifests are HIGH for any edit (review R-C1: edit-then-test runs code
  // without the phone). The owner chose "edit code and run tests" for helpers (D-072), so here they
  // are workspace edits too; config, CI and .env files still ask.
  if (
    (c.category === "edit" || c.category === "create") &&
    c.tier === "HIGH" &&
    c.reasons.length > 0 &&
    c.reasons.every((r) => r === "build/test manifest or test code")
  )
    return "workspace_edit";
  if (toolName !== "Bash" || typeof input.command !== "string") return null;
  const segs = plainSegments(input.command);
  if (!segs) return null;

  if (c.tier === "HIGH") {
    // Only a single push of the plan's own branch.
    const only = c.reasons.length === 1 && c.reasons[0] === "git push";
    return only && segs.length === 1 && isPlanBranchPush(segs[0]!, branchPrefix) ? "coord_branch_push" : null;
  }
  if (c.tier !== "MED") return null;
  const reasons = new Set(c.reasons);
  const kinds = new Set<AutoKind>();
  for (const r of reasons) {
    if (r === "git write") kinds.add("git_local");
    else if (r === "package install") kinds.add("package_install");
    else return null;
  }
  // Each git or installer segment must be one the owner allowed (read-only git rides along); the
  // other segments are read-only or allowlisted, or the classifier would have added a reason.
  for (const w of segs) {
    if (w[0] === "git") {
      const g = gitSub(w);
      if (!g) return null;
      if (!["status", "diff", "log", "show"].includes(g.sub) && !isLocalGit(w)) return null;
    } else if (isInstall(w) && !isProjectInstall(w)) return null;
  }
  // A command mixing local git and installs needs both.
  if (kinds.size !== 1) return null;
  return [...kinds][0]!;
};

export type CoordAnswer = { via: "coordinator_auto"; kind: AutoKind } | { via: "remembered_rule"; match: string };

export interface CoordAnswerInput {
  classification: Classification;
  toolName: string;
  input: Record<string, unknown>;
  workspaceLabel: string;
  /** `coord/<plan>/`: the only branches a helper may push on its own. */
  branchPrefix: string;
  /** The kinds this computer's signed policy lets Chalito answer (empty: none). */
  ceiling: readonly AutoKind[];
  /** Match hashes of the owner's remembered rules that verified against the local trusted list. */
  rules: ReadonlySet<string>;
  hash: (text: string) => string;
}

/** Chalito's answer for the owner, or null to ask them. */
export const coordAnswer = (a: CoordAnswerInput): CoordAnswer | null => {
  const c = a.classification;
  if (c.hardFloor || c.noWorkspace) return null;
  const kind = autoKindOf(c, a.toolName, a.input, a.branchPrefix);
  if (kind && a.ceiling.includes(kind)) return { via: "coordinator_auto", kind };
  // "Siempre así": MED only; HIGH and CRITICAL always ask.
  if (c.tier !== "MED" || a.rules.size === 0) return null;
  const m = rememberMatchFor({ toolName: a.toolName, input: a.input, workspaceLabel: a.workspaceLabel });
  const text = m && ruleMatchText(m);
  if (!text) return null;
  const match = a.hash(text);
  return a.rules.has(match) ? { via: "remembered_rule", match } : null;
};
