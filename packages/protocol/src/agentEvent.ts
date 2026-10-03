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
export const ToolCategory = z.enum(["read", "search", "edit", "create", "delete", "shell", "web", "mcp", "git", "other"]);

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
  z.object({
    ...base,
    type: z.literal("error"),
    code: z.enum(["adapter_crash", "auth_required", "rate_limited", "quota_exhausted", "policy_block", "internal"]),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

/** Device-level events (not tied to a session). */
export const DeviceEvent = z.discriminatedUnion("type", [
  z.object({ v: z.literal(1), type: z.literal("policy.changed"), deviceId: DeviceId, policyHash: z.string().regex(/^[0-9a-f]{64}$/), t: EpochMs }),
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
]);
export type DeviceEvent = z.infer<typeof DeviceEvent>;
