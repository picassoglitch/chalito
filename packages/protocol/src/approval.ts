import { z } from "zod";
import {
  ApprovalId,
  b64url,
  DeviceId,
  EpochMs,
  Id,
  Origin,
  ReplayNonce,
  RiskTier,
  SessionId,
  Uid,
} from "./common.js";
import { SealedEnvelope, signed } from "./crypto.js";

/** Approvals expire 10 minutes after creation; an unanswered approval is a deny. */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export const ApprovalKind = z.enum(["tool", "decision"]);
export const ApprovalStatus = z.enum(["pending", "approved", "denied", "expired", "rejected_invalid"]);

/**
 * The cleartext body of an approval, sealed to every trusted client key.
 * Never stored or relayed in plaintext.
 */
export const ApprovalDetails = z.object({
  v: z.literal(1),
  toolName: z.string().max(128).optional(),
  /** Human summary built by the agent (e.g. "Editar 3 archivos en api/"). */
  summary: z.string().max(500),
  /** Tool input as the agent saw it (paths, command text, diff preview). */
  input: z.unknown().optional(),
  reasons: z.array(z.string().max(200)).max(10).default([]),
  origin: Origin,
  /** For kind=decision (Mesa). */
  question: z.string().max(500).optional(),
  options: z.array(z.string().max(120)).max(6).optional(),
});
export type ApprovalDetails = z.infer<typeof ApprovalDetails>;

/** Firestore `users/{uid}/approvals/{aid}` as written by the device agent. */
export const ApprovalRequest = z
  .object({
    v: z.literal(1),
    aid: ApprovalId,
    uid: Uid,
    deviceId: DeviceId,
    sid: SessionId,
    requestId: Id,
    kind: ApprovalKind,
    risk: RiskTier,
    origin: Origin,
    /** Whether a HIGH/CRITICAL step-up (WebAuthn/biometric) is required. */
    stepUpRequired: z.boolean(),
    detailsCt: SealedEnvelope,
    status: ApprovalStatus,
    createdAt: EpochMs,
    expiresAt: EpochMs,
    /** MCP `recommend_decision` notes; advisory only, never binding. */
    recommendations: z
      .array(z.object({ from: z.string().max(64), allow: z.boolean(), note: z.string().max(500), at: EpochMs }))
      .max(20)
      .default([]),
  })
  .refine((a) => a.expiresAt - a.createdAt <= APPROVAL_TTL_MS && a.expiresAt > a.createdAt, {
    message: "approval TTL must be within 10 minutes",
  })
  .refine((a) => !(a.risk === "HIGH" || a.risk === "CRITICAL") || a.stepUpRequired, {
    message: "HIGH/CRITICAL approvals require step-up",
  });
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/**
 * How the signing client confirmed presence.
 * - `webauthn`: carries a WebAuthn assertion whose challenge is SHA-256 of the decision's
 *   canonical body (without `stepUp`). The agent verifies it against the credential public key
 *   it recorded during the local reverse check — so a HIGH approval proves user verification
 *   to the device itself, not just to the cloud.
 * - `platform_biometric`: native-app biometric gate (Phase 2 Expo); asserted, covered by the signature.
 * - `typed_confirm`: MED only.
 */
export const WebAuthnAssertion = z.object({
  credentialId: b64url(),
  authenticatorData: b64url(),
  clientDataJSON: b64url(),
  signature: b64url(),
});

export const StepUp = z
  .object({
    method: z.enum(["webauthn", "platform_biometric", "typed_confirm"]),
    at: EpochMs,
    assertion: WebAuthnAssertion.optional(),
  })
  .refine((s) => s.method !== "webauthn" || s.assertion !== undefined, {
    message: "webauthn step-up must include the assertion",
  });

export const DecisionBody = z
  .object({
    v: z.literal(1),
    aid: ApprovalId,
    requestId: Id,
    uid: Uid,
    /** The agent device the decision is for; a decision for another device is rejected. */
    targetDeviceId: DeviceId,
    allow: z.boolean(),
    nonce: ReplayNonce,
    issuedAt: EpochMs,
    expiresAt: EpochMs,
    stepUp: StepUp.optional(),
    /** Optional choice for kind=decision approvals. */
    choice: z.number().int().min(0).max(5).optional(),
  })
  .refine((d) => d.expiresAt > d.issuedAt && d.expiresAt - d.issuedAt <= APPROVAL_TTL_MS, {
    message: "decision expiry must be within 10 minutes of issue",
  });
export type DecisionBody = z.infer<typeof DecisionBody>;

/**
 * A Decision is binding only when the agent verifies it against its LOCAL trusted-client
 * list: valid signature, matching aid + requestId + targetDeviceId, unseen nonce, unexpired,
 * and (for HIGH/CRITICAL) a step-up of webauthn or platform_biometric.
 */
export const Decision = signed("chalito.decision.v1", DecisionBody);
export type Decision = z.infer<typeof Decision>;

/** Why the agent resolved an approval the way it did (logged + emitted as an AgentEvent). */
export const ResolutionReason = z.enum([
  "signed_allow",
  "signed_deny",
  "timeout_deny",
  "policy_auto_allow",
  "policy_block",
  "devmode_auto_allow",
  "invalid_signature",
  "untrusted_signer",
  "replayed_nonce",
  "expired_decision",
  "wrong_device",
  "missing_step_up",
]);
export type ResolutionReason = z.infer<typeof ResolutionReason>;
