import { z } from "zod";
import { EpochMs, Uid } from "./common.js";
import { signed } from "./crypto.js";

/**
 * Coordinator mode (ADR 0025 §6, owner amendments of 2026-10-19).
 *
 * `AutoKind`: the kinds of helper prompts Chalito may answer for the owner on a computer where the
 * owner turned coordinator mode on locally (the ceiling lives in that computer's signed policy).
 * Everything else asks the owner.
 */
export const AutoKind = z.enum([
  /** Reads and searches. */
  "read",
  /** The repo's allowlisted test, lint and build commands. */
  "tests",
  /** File edits and new files inside the session's workspace. */
  "workspace_edit",
  /** Local git writes: add, commit, branch, checkout, merge, stash. */
  "git_local",
  /** Project package installs (npm/pnpm/yarn/bun add or install, uv add, cargo add, go get); never global. */
  "package_install",
  /** `git push <remote> coord/<plan>/<task>`: the plan's own branches, explicit refspec, no force. */
  "coord_branch_push",
]);
export type AutoKind = z.infer<typeof AutoKind>;

/** What coordinator mode answers on its own when the owner turns it on and picks nothing else. */
export const DEFAULT_AUTO_KINDS: readonly AutoKind[] = AutoKind.options;

/**
 * "Siempre así" (ADR 0025 §6): a remembered answer. It matches the same kind of request, in the
 * same workspace label, on any of the owner's computers:
 * - `command`: exactly the same simple shell command: every word, options included (security
 *   review: `supabase db push` never covers `supabase db push --force`);
 * - `web`: a fetch from the same domain.
 * Only MED prompts can be remembered; HIGH and CRITICAL always ask.
 */
export const RuleMatch = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("command"),
      workspaceLabel: z.string().min(1).max(80),
      /** The exact words of the command, in order. */
      argv: z.array(z.string().min(1).max(256)).min(1).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal("web"),
      workspaceLabel: z.string().min(1).max(80),
      domain: z.string().min(1).max(253),
    })
    .strict(),
]);
export type RuleMatch = z.infer<typeof RuleMatch>;

/** No newline or other control character may sit in a match value: the canonical string joins on "\n". */
const hasControl = (s: string) => [...s].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/**
 * The exact text both sides hash (SHA-256, lowercase hex) into `CoordRuleBody.match`. The rule row
 * carries only the hash; what it means is shown from the sealed label, so the server sees neither
 * the program nor the workspace label in plaintext (they are low-entropy, so this is only a light
 * cover, not secrecy).
 */
export const ruleMatchText = (m: RuleMatch): string | null => {
  // The word count goes first, so ["a b"] and ["a", "b"] never read the same.
  const parts =
    m.kind === "command"
      ? ["chalito.coordrule.match.v2", "command", m.workspaceLabel, String(m.argv.length), ...m.argv]
      : ["chalito.coordrule.match.v2", "web", m.workspaceLabel, m.domain.toLowerCase()];
  return parts.some(hasControl) ? null : parts.join("\n");
};

/** A remembered rule lives at most this long; the owner renews it by answering "Siempre así" again. */
export const COORD_RULE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const CoordRuleId = z.string().regex(/^cr_[A-Za-z0-9_-]{8,64}$/);

export const CoordRuleBody = z
  .object({
    v: z.literal(1),
    ruleId: CoordRuleId,
    uid: Uid,
    /** SHA-256 hex of `ruleMatchText(match)`. */
    match: z.string().regex(/^[0-9a-f]{64}$/),
    createdAt: EpochMs,
    expiresAt: EpochMs,
  })
  .strict()
  .refine((b) => b.expiresAt > b.createdAt && b.expiresAt - b.createdAt <= COORD_RULE_TTL_MS, {
    message: "a remembered rule expires within 90 days of being made",
  });
export type CoordRuleBody = z.infer<typeof CoordRuleBody>;

/**
 * Signed by one of the owner's trusted clients. Each device verifies it against its LOCAL trusted
 * list, so the cloud can drop a rule but can't make or widen one.
 */
export const CoordRule = signed("chalito.coordrule.v1", CoordRuleBody);
export type CoordRule = z.infer<typeof CoordRule>;

/**
 * Withdrawing a remembered rule (security review, 2026-10-19): signed by any of the owner's trusted
 * clients and stored next to the rules. A device that sees it (or sees a rule it had verified
 * disappear) keeps the rule id locally until the rule would have expired, so the same signed rule
 * re-inserted later is refused.
 */
export const CoordRuleRevokeBody = z
  .object({ v: z.literal(1), uid: Uid, ruleId: CoordRuleId, revokedAt: EpochMs })
  .strict();
export const CoordRuleRevoke = signed("chalito.coordrule-revoke.v1", CoordRuleRevokeBody);
export type CoordRuleRevoke = z.infer<typeof CoordRuleRevoke>;

/** A plain shell word: no quotes, expansions, globs, redirections or separators. */
const PLAIN_WORD = /^[A-Za-z0-9._/@%+=:,-]+$/;

/**
 * Programs that run another program or code given in their arguments: a rule for them would cover
 * whatever they run, so they are never remembered (security review).
 */
const WRAPPERS = new Set([
  "npx",
  "pnpx",
  "bunx",
  "uvx",
  "pipx",
  "env",
  "xargs",
  "sudo",
  "doas",
  "su",
  "pkexec",
  "time",
  "nice",
  "nohup",
  "timeout",
  "watch",
  "stdbuf",
  "unbuffer",
  "setsid",
  "script",
  "expect",
  "exec",
  "eval",
  "command",
  "builtin",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "pwsh",
  "powershell",
  "cmd",
  "node",
  "nodejs",
  "deno",
  "bun",
  "tsx",
  "ts-node",
  "python",
  "python3",
  "python2",
  "ruby",
  "perl",
  "php",
  "lua",
  "osascript",
  "ssh",
  "chalito",
  "chalito-agent",
]);
/** `<tool> <sub>` pairs that run another program. */
const WRAPPER_SUBS: Record<string, ReadonlySet<string>> = {
  npm: new Set(["exec", "x", "run", "run-script", "explore"]),
  pnpm: new Set(["exec", "dlx", "run", "x"]),
  yarn: new Set(["dlx", "exec", "run", "node"]),
  uv: new Set(["run", "tool"]),
  cargo: new Set(["run", "x"]),
  go: new Set(["run"]),
  docker: new Set(["run", "exec"]),
  kubectl: new Set(["exec", "run"]),
  git: new Set(["-c", "submodule"]),
};

/**
 * The remembered-rule match for a prompt, or null when it can't be remembered. Shared by the hub
 * (to sign "Siempre así") and the agent (to check a rule), so both read a request the same way:
 * - `Bash`: one simple command of plain words (anything with quotes, `$`, globs, pipes, `;`, `&&`,
 *   redirections or a leading `VAR=` is never remembered);
 * - `WebFetch`: the URL's host.
 * The agent applies a rule only to a MED prompt; this function doesn't know the risk.
 */
export const rememberMatchFor = (a: { toolName: string; input: unknown; workspaceLabel: string }): RuleMatch | null => {
  const input = (a.input && typeof a.input === "object" ? a.input : {}) as Record<string, unknown>;
  let m: RuleMatch | null = null;
  if (a.toolName === "Bash" && typeof input.command === "string") {
    const words = input.command.trim().split(/[ \t]+/);
    const [program, first] = words;
    if (!program || !words.every((w) => PLAIN_WORD.test(w)) || program.includes("=")) return null;
    // A path (`./deploy.sh`, `/usr/bin/x`) runs whatever that file holds then; a wrapper runs
    // whatever its arguments say: neither is ever remembered.
    if (program.includes("/") || WRAPPERS.has(program) || (first && WRAPPER_SUBS[program]?.has(first))) return null;
    m = { kind: "command", workspaceLabel: a.workspaceLabel, argv: words };
  } else if (a.toolName === "WebFetch" && typeof input.url === "string") {
    let host: string;
    try {
      host = new URL(input.url).hostname.toLowerCase();
    } catch {
      return null;
    }
    if (!host) return null;
    m = { kind: "web", workspaceLabel: a.workspaceLabel, domain: host };
  }
  if (!m) return null;
  const parsed = RuleMatch.safeParse(m);
  return parsed.success && ruleMatchText(parsed.data) !== null ? parsed.data : null;
};
