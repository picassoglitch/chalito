import { z } from "zod";
import { EpochMs, Uid } from "./common.js";
import { SealedEnvelope, signed } from "./crypto.js";
import { AppId } from "./recipe.js";

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
 * - `command`: one simple shell command with the same program and subcommand (up to two words
 *   after the program, before any option: `supabase db push` is "db push"; "" when there is none);
 * - `web`: a fetch from the same domain.
 * Only MED prompts can be remembered; HIGH and CRITICAL always ask.
 */
export const RuleMatch = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("command"),
      workspaceLabel: z.string().min(1).max(80),
      program: z.string().min(1).max(64),
      sub: z.string().max(129),
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
  const parts =
    m.kind === "command"
      ? ["chalito.coordrule.match.v1", "command", m.workspaceLabel, m.program, m.sub]
      : ["chalito.coordrule.match.v1", "web", m.workspaceLabel, m.domain.toLowerCase()];
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
    const [program, ...args] = words;
    if (!program || !words.every((w) => PLAIN_WORD.test(w)) || program.includes("=")) return null;
    // Up to two leading words that aren't options ("db push", "pr create"), so `supabase db push`
    // and `supabase db reset` are different rules.
    const firstOption = args.findIndex((w) => w.startsWith("-"));
    const sub = (firstOption === -1 ? args : args.slice(0, firstOption)).slice(0, 2).join(" ");
    m = { kind: "command", workspaceLabel: a.workspaceLabel, program, sub };
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

// ---- G2: the coordinator itself (ADR 0025 §1, §6) --------------------------------------------

export const PlanId = z.string().regex(/^p[a-z0-9]{6,12}$/);
export const CoordTaskId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);
/** A git branch name the coordinator accepts as the base (no options, no ranges, no `..`). */
export const BranchName = z
  .string()
  .max(120)
  // Starts with a letter or digit (never an option), plain path segments, no `..` (a range).
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/)
  .refine((b) => !b.includes("..") && !b.split("/").some((p) => p.endsWith(".lock") || p.endsWith(".")), {
    message: "not a plain branch name",
  });

/** One task of a plan, as the planner proposes it (and the owner sees it before the one tap). */
export const CoordTaskSpec = z
  .object({
    id: CoordTaskId,
    title: z.string().min(1).max(120),
    /** What the helper is asked to do. */
    brief: z.string().min(1).max(4000),
    acceptance: z.array(z.string().min(1).max(300)).min(1).max(10),
    /** Files the task expects to touch; a deletion outside these blocks review (ADR 0025 §3). */
    files: z.array(z.string().min(1).max(300)).max(50).default([]),
    dependsOn: z.array(CoordTaskId).max(6).default([]),
  })
  .strict();
export type CoordTaskSpec = z.infer<typeof CoordTaskSpec>;

export const CoordTaskStatus = z.enum([
  "pending",
  "running",
  "reviewing",
  "changes_requested",
  "approved",
  "failed",
  "stopped",
]);
export const CoordPlanStatus = z.enum([
  "planning",
  "awaiting_approval",
  "running",
  "integrating",
  "ready_to_merge",
  "merged",
  "stopped",
  "failed",
]);

/**
 * What the phone shows for a plan: sealed to the owner's clients in the coordinator session's doc
 * (`doc.coord.ct`, aad `coord:<sid>`). Text fields come from agents: shown as data, never acted on.
 */
export const CoordPlanState = z
  .object({
    v: z.literal(1),
    planId: PlanId,
    goal: z.string().max(4000),
    workspaceLabel: z.string().max(80),
    base: z.string().max(120),
    status: CoordPlanStatus,
    maxAgents: z.number().int().min(1).max(6),
    maxMinutes: z.number().int().min(5).max(720),
    startedAt: z.number().int().nullable(),
    tasks: z
      .array(
        z.object({
          id: CoordTaskId,
          title: z.string().max(120),
          acceptance: z.array(z.string().max(300)).max(10),
          dependsOn: z.array(CoordTaskId).max(6),
          status: CoordTaskStatus,
          branch: z.string().max(200),
          sid: z.string().max(128).nullable(),
          /** The helper's or reviewer's last word on it (truncated). */
          note: z.string().max(500).nullable(),
          reviewRounds: z.number().int().min(0).max(10),
        }),
      )
      .max(12),
    integration: z.object({
      branch: z.string().max(200),
      sid: z.string().max(128).nullable(),
      note: z.string().max(500).nullable(),
      /** The integration branch's commit once ready to merge: what the merge tap moves the base to. */
      head: z
        .string()
        .regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/)
        .nullable(),
    }),
    /** Why the plan stopped or failed, or what the merge did. */
    note: z.string().max(500).nullable(),
    updatedAt: z.number().int(),
  })
  .strict();
export type CoordPlanState = z.infer<typeof CoordPlanState>;

/**
 * The plan as the agent publishes it: signed with its device key (security review, 2026-10-19),
 * then sealed to the owner's clients. A client shows a plan, and taps on it, only once the
 * signature verifies against the agent key it trusts.
 */
export const SignedCoordPlan = signed("chalito.coordplan.v1", CoordPlanState);
export type SignedCoordPlan = z.infer<typeof SignedCoordPlan>;

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * What a tap is about (security review): `coord.approve` covers the goal, limits and tasks the
 * owner saw; `coord.merge` also the integration commit. Both sides hash
 * SHA-256(JCS(planDigestInput(plan, kind))) (hex); the agent refuses a tap whose digest isn't the
 * one of its current plan.
 */
export const planDigestInput = (p: CoordPlanState, kind: "approve" | "merge") => ({
  v: 1,
  kind,
  planId: p.planId,
  goal: p.goal,
  workspaceLabel: p.workspaceLabel,
  base: p.base,
  maxAgents: p.maxAgents,
  maxMinutes: p.maxMinutes,
  tasks: p.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    acceptance: t.acceptance,
    dependsOn: t.dependsOn,
    branch: t.branch,
  })),
  ...(kind === "merge" ? { integration: { branch: p.integration.branch, head: p.integration.head } } : {}),
});

/** Coordinator commands: signed by a trusted client only (no relay carries them). */
export const CoordCommands = [
  /** A goal for one of this computer's workspaces; the planner proposes tasks and waits for the tap. */
  z
    .object({
      type: z.literal("coord.start"),
      workspaceLabel: z.string().min(1).max(80),
      goalCt: SealedEnvelope,
      /** The coding agent for the planner, helpers and reviewer (default Claude Code). */
      appId: AppId.optional(),
      // Optional, never `.default()`: the agent verifies the signature over the parsed body, so a
      // default filled in here would break it. The agent applies 3 agents and 120 minutes.
      maxAgents: z.number().int().min(1).max(6).optional(),
      maxMinutes: z.number().int().min(5).max(720).optional(),
      /** The branch the plan starts from and merges into (default: the checked-out branch). */
      base: BranchName.optional(),
    })
    .strict(),
  /** The owner's one tap: run the proposed tasks. */
  z.object({ type: z.literal("coord.approve"), planId: PlanId, digest: Hex64 }).strict(),
  /** The kill switch: interrupts every helper, reviewer and the planner; keeps worktrees and branches. */
  z.object({ type: z.literal("coord.stop"), planId: PlanId }).strict(),
  /** The owner's merge tap (passkey step-up over the command): integration into the base, then push. */
  z.object({ type: z.literal("coord.merge"), planId: PlanId, digest: Hex64 }).strict(),
] as const;
