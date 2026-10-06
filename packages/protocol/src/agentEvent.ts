import { z } from "zod";
import {
  AdapterKind,
  ApprovalId,
  DeviceId,
  EpochMs,
  Id,
  Origin,
  RemotePermissionMode,
  RiskTier,
  SessionId,
  Urgency,
} from "./common.js";
import { ResolutionReason } from "./approval.js";
import { DevModeToggle } from "./command.js";
import { SealedEnvelope } from "./crypto.js";
import { AppId } from "./recipe.js";
import { TerminalCloseReason, TerminalCols, TerminalId, TerminalRows } from "./terminal.js";
import { ScreenEndReason, ScreenMode, ScreenState } from "./screen.js";

export const SessionState = z.enum([
  "starting",
  "running",
  "waiting_approval",
  "waiting_input",
  "idle",
  "completed",
  "failed",
  "interrupted",
]);
export type SessionState = z.infer<typeof SessionState>;

/** Coarse tool category; plaintext-safe (never carries paths or command text). */
export const ToolCategory = z.enum([
  "read",
  "search",
  "edit",
  "create",
  "delete",
  "shell",
  "web",
  "mcp",
  "git",
  "other",
]);

export type ToolCategory = z.infer<typeof ToolCategory>;

const base = {
  v: z.literal(1),
  eid: Id,
  sid: SessionId,
  deviceId: DeviceId,
  /** Monotonic per session; consumers detect gaps and resync. */
  seq: z.number().int().nonnegative(),
  t: EpochMs,
  urgency: Urgency.default("low"),
};

/**
 * AgentEvent v1: the typed event stream the device agent emits for a session.
 * Plaintext fields are metadata; anything with content is in `ct` (sealed to clients).
 * Written to `users/{uid}/sessions/{sid}/events/{eid}` with a TTL `expireAt`.
 */
export const AgentEvent = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("session.started"),
    adapter: AdapterKind,
    origin: Origin,
    permissionMode: RemotePermissionMode.or(z.literal("local_only")),
  }),
  z.object({ ...base, type: z.literal("session.state"), state: SessionState }),
  z.object({ ...base, type: z.literal("message.assistant"), ct: SealedEnvelope }),
  z.object({ ...base, type: z.literal("message.user"), origin: Origin, ct: SealedEnvelope }),
  z.object({
    ...base,
    type: z.literal("tool.started"),
    toolUseId: Id,
    category: ToolCategory,
    risk: RiskTier,
    ct: SealedEnvelope,
  }),
  z.object({
    ...base,
    type: z.literal("tool.finished"),
    toolUseId: Id,
    ok: z.boolean(),
    ct: SealedEnvelope.optional(),
  }),
  z.object({
    ...base,
    type: z.literal("approval.requested"),
    aid: ApprovalId,
    risk: RiskTier,
    expiresAt: EpochMs,
  }),
  z.object({
    ...base,
    type: z.literal("approval.resolved"),
    aid: ApprovalId,
    allow: z.boolean(),
    reason: ResolutionReason,
    byDeviceId: DeviceId.optional(),
  }),
  z.object({
    ...base,
    type: z.literal("question.asked"),
    questionId: Id,
    ct: SealedEnvelope,
  }),
  z.object({
    ...base,
    type: z.literal("usage"),
    tokIn: z.number().int().nonnegative(),
    tokOut: z.number().int().nonnegative(),
    tokCached: z.number().int().nonnegative().default(0),
  }),
  z.object({ ...base, type: z.literal("card.updated"), cardVersion: z.number().int().nonnegative() }),
  // ---- SCREEN (screen.ts): a screen session's own stream ------------------------------------
  /** Where the screen session is; metadata only. `reason` once it ended. */
  z.object({
    ...base,
    type: z.literal("screen.state"),
    state: ScreenState,
    mode: ScreenMode,
    reason: ScreenEndReason.optional(),
  }),
  /**
   * The agent's WebRTC signaling: `ct` opens (for the requesting client only) to a
   * `SignedScreenSignal` the browser verifies against the agent's signing key.
   */
  z.object({ ...base, type: z.literal("screen.signal"), ct: SealedEnvelope }),
  // ---- end SCREEN ---------------------------------------------------------------------------
  z.object({
    ...base,
    type: z.literal("error"),
    code: z.enum(["adapter_crash", "auth_required", "rate_limited", "quota_exhausted", "policy_block", "internal"]),
  }),
  // ---- TERMINAL (remote terminal, terminal.ts): `sid` is the terminal id, `tid` repeats it ----
  /** The terminal was approved and its program started in the PTY. */
  z.object({
    ...base,
    type: z.literal("terminal.started"),
    tid: TerminalId,
    appId: AppId,
    origin: Origin,
    cols: TerminalCols,
    rows: TerminalRows,
  }),
  /**
   * Output, in order of `seq`. `dataCt` is sealed to the trusted clients over TerminalData with
   * AAD `terminal:<tid>:<seq>`. `dropped`: characters the device discarded before this chunk
   * because the reader fell behind (scrollback limit); the count only, never the content.
   */
  z.object({
    ...base,
    type: z.literal("terminal.output"),
    tid: TerminalId,
    dataCt: SealedEnvelope,
    dropped: z.number().int().positive().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("terminal.closed"),
    tid: TerminalId,
    reason: TerminalCloseReason,
    exitCode: z.number().int().optional(),
  }),
  // ---- end TERMINAL ----
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

/**
 * Why an agent refused a command, as the person's clients see it (`command.rejected`). A closed
 * set: the agent maps its internal reasons onto it (apps/agent/src/command-result.ts), so no
 * path, label or free text reaches the row.
 */
export const CommandRejectReason = z.enum([
  /** Not a command envelope this agent understands. */
  "invalid",
  /** Tried to turn on Developer mode or a permissive mode remotely (also `remote_enable.rejected`). */
  "remote_enable_rejected",
  /** Signed by a client this computer doesn't trust (pair or endorse it first). */
  "untrusted_signer",
  "bad_signature",
  "origin_mismatch",
  "wrong_device",
  "wrong_owner",
  "expired",
  "replayed_nonce",
  /** The policy doesn't accept commands from this origin (e.g. MCP prompts off). */
  "origin_disabled",
  /** No workspace with that label in this computer's policy. */
  "unknown_workspace",
  "permission_mode_above_ceiling",
  "codex_sandbox_above_ceiling",
  /** The adapter is off in the policy, or not set up here (Claude Code or Codex not pinned, no key). */
  "adapter_disabled",
  "unknown_session",
  "unknown_question",
  "policy_would_loosen",
  "policy_invalid",
  "step_up_required",
  "step_up_failed",
  /** Accepted, but the coding agent failed to start (version, login, binary). */
  "start_failed",
  /** provider.connect signin: providers.yaml `subscriptionLocal` doesn't allow it for this person. */
  "blocked_by_policy",
  /** provider.*: an install or sign-in for that provider is already running on the device. */
  "provider_busy",
  /** provider.*: the key couldn't be stored, the CLI is missing, or its sign-in/install failed. */
  "provider_failed",
  // ENGINE (app.*; provider_busy / provider_failed / blocked_by_policy above apply to app.* too)
  /** app.* / session.start: no recipe with that id on this computer. */
  "unknown_app",
  /** A custom recipe that isn't enabled on this computer (or was edited since it was enabled). */
  "recipe_disabled",
  /** app.launch / app.install: nothing to do for that app on this computer's OS. */
  "app_unavailable",
  // ---- TERMINAL ----
  /** Remote terminal is off on this computer (turned on only there). */
  "terminal_disabled",
  /** appId "shell" while the raw-shell toggle is off on this computer. */
  "raw_shell_disabled",
  // ("unknown_app" above also covers: no recipe with a terminal driver for that appId.)
  /** The recipe's program isn't installed (not on PATH). */
  "app_not_installed",
  /** No desktop app showing the indicator, or no PTY support in this build. */
  "terminal_unavailable",
  /** Too many terminals open on this computer (policy `remoteTerminal.maxSessions`). */
  "terminal_limit",
  /** The terminal is waiting for approval or already ended. */
  "terminal_not_running",
  /** Too many terminal opens or too much input in the last minute. */
  "rate_limited",
  // ---- end TERMINAL ----
  // ---- SCREEN (screen.ts) ----
  /** Remote view (or control, for a control session) isn't turned on on that computer. */
  "screen_disabled",
  /** screen.open must come from a person's trusted browser (`client:`). */
  "screen_needs_client",
  /** The Chalito desktop app isn't open there (it shows the indicator and holds the kill switch). */
  "no_desktop",
  /** That computer can't capture its screen (Linux Wayland, missing native layer). */
  "screen_unsupported",
  "screen_unavailable",
  /** Too many screen sessions at once on that computer. */
  "screen_busy",
  "bad_display",
  "bad_signal",
  "not_ready",
  "duplicate_answer",
  // ---- end SCREEN ----
  "internal",
]);
export type CommandRejectReason = z.infer<typeof CommandRejectReason>;

/**
 * What became of one command, written by the agent as an audit row (`chalito.audit`: `type` is
 * "command.accepted" or "command.rejected", `meta` is this, `device_id` the agent). Clients find
 * it by `meta->>cid`. It goes to the audit trail and not to `devices.last_event`, so it never
 * overwrites a security notice there (trust.endorsement_refused).
 */
export const CommandAcceptedMeta = z.object({
  cid: Id,
  /** The new session (session.start) or the session the command targeted. */
  sid: SessionId.optional(),
});
export type CommandAcceptedMeta = z.infer<typeof CommandAcceptedMeta>;
export const CommandRejectedMeta = z.object({ cid: Id, reason: CommandRejectReason });
export type CommandRejectedMeta = z.infer<typeof CommandRejectedMeta>;

/** Device-level events (not tied to a session). */
export const DeviceEvent = z.discriminatedUnion("type", [
  z.object({
    v: z.literal(1),
    type: z.literal("policy.changed"),
    deviceId: DeviceId,
    policyHash: z.string().regex(/^[0-9a-f]{64}$/),
    t: EpochMs,
  }),
  z.object({
    v: z.literal(1),
    type: z.literal("devmode.changed"),
    deviceId: DeviceId,
    on: z.boolean(),
    toggles: z.array(DevModeToggle),
    t: EpochMs,
  }),
  z.object({
    v: z.literal(1),
    type: z.literal("remote_enable.rejected"),
    deviceId: DeviceId,
    attempted: z.string().max(64),
    origin: Origin,
    t: EpochMs,
  }),
  /** Local Developer-mode files failed verification; the device forced Developer mode off. */
  z.object({
    v: z.literal(1),
    type: z.literal("devmode.tampered"),
    deviceId: DeviceId,
    reason: z.enum(["state_signature", "audit_chain", "stale_state", "toggle_unbacked", "rollback"]),
    t: EpochMs,
  }),
  /** policy.yaml was edited without the signed lock; the edit was refused and the signed policy stays. */
  z.object({
    v: z.literal(1),
    type: z.literal("policy.tampered"),
    deviceId: DeviceId,
    /** Hash of the refused file, or null when it didn't parse. */
    fileHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    inForceHash: z.string().regex(/^[0-9a-f]{64}$/),
    t: EpochMs,
  }),
  /**
   * ADR 0018 / R-L13: this agent refused an endorsed client. Shown to the person on their
   * clients, so a refusal is never silent ("missing step-up": approve the new device again
   * with the endorsing device's passkey).
   */
  z.object({
    v: z.literal(1),
    type: z.literal("trust.endorsement_refused"),
    deviceId: DeviceId,
    clientDeviceId: DeviceId,
    endorsedBy: DeviceId,
    reason: z.enum(["missing_step_up", "bad_step_up", "bad_binding", "bad_signature", "stale"]),
    t: EpochMs,
  }),
  /**
   * Review R-H5: this agent dropped a client it trusted because the account revoked it (for
   * instance while this computer was offline and the revoke command expired).
   */
  z.object({
    v: z.literal(1),
    type: z.literal("trust.client_revoked"),
    deviceId: DeviceId,
    clientDeviceId: DeviceId,
    t: EpochMs,
  }),
  /**
   * Computer control's state on this device, for display only (remote surfaces can read it,
   * never turn it on): whether it is enabled locally and how many sessions hold control now.
   * `by` names what ended control when it was stopped (`hotkey`, `tray`, `panel`, `cli`, `policy`).
   */
  z.object({
    v: z.literal(1),
    type: z.literal("computer.changed"),
    deviceId: DeviceId,
    enabled: z.boolean(),
    activeSessions: z.number().int().min(0).max(1000),
    by: z.string().max(32).optional(),
    t: EpochMs,
  }),
  /**
   * Remote terminal's state on this device, for display only (remote surfaces can read it, never
   * turn it on): whether it and the raw shell are enabled locally and how many terminals are open.
   */
  z.object({
    v: z.literal(1),
    type: z.literal("terminal.changed"),
    deviceId: DeviceId,
    enabled: z.boolean(),
    rawShell: z.boolean(),
    activeSessions: z.number().int().min(0).max(1000),
    by: z.string().max(32).optional(),
    t: EpochMs,
  }),
  /**
   * Remote screen's state on this device, for display only: what the person enabled locally
   * (view, control) and how many screen sessions are live. `by` names what ended them.
   */
  z.object({
    v: z.literal(1),
    type: z.literal("screen.changed"),
    deviceId: DeviceId,
    view: z.boolean(),
    control: z.boolean(),
    activeSessions: z.number().int().min(0).max(1000),
    by: z.string().max(32).optional(),
    t: EpochMs,
  }),
]);
export type DeviceEvent = z.infer<typeof DeviceEvent>;
