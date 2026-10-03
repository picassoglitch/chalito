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

export const CommandBody = z.object({
  v: z.literal(1),
  cid: Id,
  uid: Uid,
  targetDeviceId: DeviceId,
  origin: Origin,
  nonce: ReplayNonce,
  issuedAt: EpochMs,
  expiresAt: EpochMs,
  payload: CommandPayload,
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
export const RelayedCommand = z.object({
  relayedBy: z.enum(["mcp-gateway", "notifier"]),
  body: CommandBody.refine(
    (b) =>
      (b.origin.startsWith("mcp:") || b.origin.startsWith("call:")) &&
      (b.payload.type === "session.prompt" || b.payload.type === "session.answer"),
    { message: "relayed commands may only prompt or answer, from mcp:* or call:* origins" },
  ),
});
export type RelayedCommand = z.infer<typeof RelayedCommand>;

export const CommandEnvelope = z.union([SignedCommand, RelayedCommand]);
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;
