import { z } from "zod";
import {
  AdapterKind,
  DeviceId,
  EpochMs,
  Id,
  Origin,
  RemoteCodexSandbox,
  RemotePermissionMode,
  ReplayNonce,
  SessionId,
  Uid,
} from "./common.js";
import { StepUp } from "./approval.js";
import { SealedEnvelope, signed } from "./crypto.js";

/** Developer-mode toggles. They can be turned ON only locally on the device. */
export const DevModeToggle = z.enum(["allowSudo", "autoApproveHigh", "autoApproveCritical", "bypassStyle"]);
export type DevModeToggle = z.infer<typeof DevModeToggle>;

/** Policy presets proposed from the cloud; they take effect only after acceptance on the device. */
export const PolicyPreset = z.enum(["estricto", "estandar", "relajado"]);

/**
 * Commands a remote surface can send to a device agent. There is no command that
 * enables Developer mode, enables a toggle, loosens policy, adds a trusted client,
 * or sets a permission mode above `acceptEdits` — those shapes are unrepresentable.
 */
export const CommandPayload = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.start"),
    adapter: AdapterKind,
    /** Label of a workspace the user allowed locally; never a raw path. */
    workspaceLabel: z.string().min(1).max(80),
    promptCt: SealedEnvelope,
    permissionMode: RemotePermissionMode.default("default"),
    codexSandbox: RemoteCodexSandbox.optional(),
  }),
  z.object({ type: z.literal("session.prompt"), sid: SessionId, promptCt: SealedEnvelope }),
  z.object({ type: z.literal("session.interrupt"), sid: SessionId }),
  z.object({ type: z.literal("session.resume"), sid: SessionId, promptCt: SealedEnvelope.optional() }),
  z.object({
    type: z.literal("session.setPermissionMode"),
    sid: SessionId,
    permissionMode: RemotePermissionMode,
    codexSandbox: RemoteCodexSandbox.optional(),
  }),
  /** Answer to an agent question (AskUserQuestion / Codex user input). Not an approval. */
  z.object({ type: z.literal("session.answer"), sid: SessionId, questionId: Id, answerCt: SealedEnvelope }),
  /** Tightening only: the agent applies it if the resulting policy is a subset of the current one. */
  z.object({ type: z.literal("policy.tighten"), patchCt: SealedEnvelope }),
  /** Proposal only: shown on the device, applied after local acceptance. */
  z.object({ type: z.literal("policy.proposePreset"), preset: PolicyPreset }),
  z.object({ type: z.literal("devmode.off") }),
  z.object({ type: z.literal("devmode.toggleOff"), toggle: DevModeToggle }),
  z.object({ type: z.literal("device.revokeClient"), clientDeviceId: DeviceId }),
]);
export type CommandPayload = z.infer<typeof CommandPayload>;

/** Commands live at most 10 minutes, so the nonce window the agent must remember is bounded. */
export const COMMAND_TTL_MS = 10 * 60 * 1000;

export const CommandBody = z
  .object({
    v: z.literal(1),
    cid: Id,
    uid: Uid,
    targetDeviceId: DeviceId,
    origin: Origin,
    nonce: ReplayNonce,
    issuedAt: EpochMs,
    expiresAt: EpochMs,
    payload: CommandPayload,
    /**
     * A passkey assertion over SHA-256(JCS(this body without stepUp)), like a Decision's. Required
     * by agents to revoke ANOTHER client while any trusted client has a passkey (review R-L1).
     */
    stepUp: StepUp.optional(),
  })
  // Upper bound only: an already-expired command still parses, so the agent can reject it as "expired".
  .refine((b) => b.expiresAt - b.issuedAt <= COMMAND_TTL_MS, {
    message: "commands expire within 10 minutes of being issued",
  });
export type CommandBody = z.infer<typeof CommandBody>;

/** A command signed by a trusted client (origin `client:<id>`). */
export const SignedCommand = signed("chalito.command.v1", CommandBody);
export type SignedCommand = z.infer<typeof SignedCommand>;

/**
 * A command relayed by the cloud on behalf of an unsigned origin (`mcp:*`, `call:*`).
 * Restricted to prompting/answering; the agent applies its origin policy and never
 * Developer-mode auto-approve to the resulting turn.
 */
export const RelayedCommand = z
  .object({
    relayedBy: z.enum(["mcp-gateway", "notifier"]),
    body: CommandBody,
  })
  // Each relay carries only its own origin (review R-L2): the MCP gateway relays `mcp:*` prompts,
  // the notifier relays `call:*` prompts (a spoken answer becomes a prompt). Nothing relays a
  // session.answer, and an unsigned relay can't carry a step-up.
  .refine(
    ({ relayedBy, body }) =>
      (relayedBy === "mcp-gateway" ? body.origin.startsWith("mcp:") : body.origin.startsWith("call:")) &&
      body.payload.type === "session.prompt" &&
      body.stepUp === undefined,
    { message: "relays carry only session.prompt from their own origin (mcp-gateway: mcp:*, notifier: call:*)" },
  );
export type RelayedCommand = z.infer<typeof RelayedCommand>;

export const CommandEnvelope = z.union([SignedCommand, RelayedCommand]);
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;
