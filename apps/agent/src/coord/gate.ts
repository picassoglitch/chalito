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

/** `git <sub> …`; global options (`-C`, `-c`, `--git-dir`, …) are the owner's call. */
const gitSub = (w: Words): { sub: string; rest: Words } | null => {
  if (w[0] !== "git" || !w[1] || w[1].startsWith("-")) return null;
  return { sub: w[1], rest: w.slice(2) };
};

/**
 * Every check below is an allowlist of exact shapes (security review, 2026-10-19): an option word
 * not listed (unknown, abbreviated `--del`, bundled `-Df`, or one that changes the target folder)
 * means the owner answers.
 */

/** A plain name (branch, path, package) that can't be read as an option. */
const NOT_OPTION = (a: string) => a.length > 0 && !a.startsWith("-");
/** A branch or start point: plain name, no `..`, no `:` or `+` refspec syntax. */
const REF = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const isRef = (a: string | undefined): a is string => !!a && REF.test(a) && !a.includes("..");
/** A path inside the worktree: relative, no `..`. */
const isRelPath = (a: string) =>
  NOT_OPTION(a) && !a.startsWith("/") && !a.startsWith("~") && !a.split("/").includes("..");

/**
 * Local git writes the owner allowed ("commits and branches"), exact shapes only:
 * - `add` (`-A` / `--all` / `-u` / `--update`) with relative paths;
 * - `commit [-a] -m <message>` (no `--amend`, no bundled `-am`);
 * - `checkout -b <new> [<start>]` (never `-B`, never a path);
 * - `switch <branch>` or `switch -c <new> [<start>]`;
 * - `branch <new> [<start>]`;
 * - `merge [--no-ff|--ff-only|--no-edit] <branch>` and `merge ... -m <message>`;
 * - `stash`, `stash push [-m <message>]`, `stash pop|apply|list`.
 */
const isLocalGit = (w: Words): boolean => {
  const g = gitSub(w);
  if (!g) return false;
  const a = g.rest;
  switch (g.sub) {
    case "add":
      return a.length > 0 && a.every((x) => ["-A", "--all", "-u", "--update"].includes(x) || isRelPath(x));
    case "commit": {
      const rest = a[0] === "-a" ? a.slice(1) : a;
      return rest.length === 2 && rest[0] === "-m";
    }
    case "checkout":
      return a[0] === "-b" && (a.length === 2 || a.length === 3) && a.slice(1).every(isRef);
    case "switch":
      return (
        (a.length === 1 && isRef(a[0])) ||
        (a[0] === "-c" && (a.length === 2 || a.length === 3) && a.slice(1).every(isRef))
      );
    case "branch":
      return (a.length === 1 || a.length === 2) && a.every(isRef);
    case "merge": {
      let i = 0;
      while (["--no-ff", "--ff-only", "--no-edit"].includes(a[i] ?? "")) i++;
      if (a[i] === "-m") i += 2;
      return i === a.length - 1 && isRef(a[i]);
    }
    case "stash":
      return (
        a.length === 0 ||
        (a.length === 1 && ["push", "pop", "apply", "list"].includes(a[0]!)) ||
        (a.length === 3 && a[0] === "push" && a[1] === "-m")
      );
    default:
      return false;
  }
};

/**
 * A package as a registry name with an optional version: never a path, URL, `file:`/`git:` spec
 * or anything else that reaches outside the project.
 */
const PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9.^~<>=*_+-]+)?$/i;
const GO_MODULE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(\/[A-Za-z0-9._~-]+)*(@[A-Za-z0-9.+_-]+)?$/;

/**
 * Project installs, per tool: the verbs and the only option words allowed. Global installs and
 * anything that moves the target folder (`--prefix`, `--dir`, `-C`, `--cwd`, `--global-dir`,
 * `--location`, `-g`, …) aren't listed, so they ask.
 */
const PROJECT_INSTALLS: Record<string, { verbs: RegExp; flags: string[]; pkg: RegExp }> = {
  npm: {
    verbs: /^(i|install|add|ci)$/,
    flags: ["-D", "--save-dev", "-E", "--save-exact", "-O", "--save-optional"],
    pkg: PACKAGE,
  },
  pnpm: {
    verbs: /^(i|install|add)$/,
    flags: ["-D", "--save-dev", "-E", "--save-exact", "-O", "--save-optional", "--frozen-lockfile"],
    pkg: PACKAGE,
  },
  yarn: { verbs: /^(add|install)$/, flags: ["-D", "--dev", "-E", "--exact", "--frozen-lockfile"], pkg: PACKAGE },
  bun: { verbs: /^(add|install|i)$/, flags: ["-d", "--dev", "-E", "--exact"], pkg: PACKAGE },
  uv: { verbs: /^add$/, flags: ["--dev"], pkg: PACKAGE },
  cargo: { verbs: /^add$/, flags: ["--dev", "--build"], pkg: PACKAGE },
  go: { verbs: /^get$/, flags: ["-u", "-t"], pkg: GO_MODULE },
};
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

const isProjectInstall = (w: Words): boolean => {
  const spec = PROJECT_INSTALLS[w[0] ?? ""];
  if (!spec || !spec.verbs.test(w[1] ?? "")) return false;
  return w.slice(2).every((a) => (a.startsWith("-") ? spec.flags.includes(a) : spec.pkg.test(a)));
};

/** A remote name: starts with a letter or digit (never an option), no path or URL characters. */
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRANCH_REST = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Exactly `git push [-u|--set-upstream] <remote> <prefix>…`: no other word, no other option. */
const isPlanBranchPush = (w: Words, prefix: string): boolean => {
  const g = gitSub(w);
  if (!g || g.sub !== "push") return false;
  const a = g.rest[0] === "-u" || g.rest[0] === "--set-upstream" ? g.rest.slice(1) : g.rest;
  if (a.length !== 2) return false;
  const [remote, ref] = a as [string, string];
  if (!REMOTE_NAME.test(remote) || !NOT_OPTION(ref) || !ref.startsWith(prefix)) return false;
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
