import { z } from "zod";
import { ApprovalId, b64url, DeviceId, EpochMs, Id, Origin, ReplayNonce, RiskTier, SessionId, Uid } from "./common.js";
import { SealedEnvelope, signed } from "./crypto.js";

/** Approvals expire 10 minutes after creation; an unanswered approval is a deny. */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

/**
 * `computer_control`: a session asks to see the screen and drive the mouse and keyboard of the
 * device (apps/agent/src/computer). Only offered once the person enabled computer control
 * locally on that device; always HIGH with a passkey step-up, once per session.
 */
/**
 * Engine contract (2026-10-06): every remote session kind gets its own per-session approval,
 * always HIGH with a passkey step-up, only once the person enabled it locally:
 * - `terminal`: a remote terminal session (remote-terminal).
 * - `remote_view`: a trusted browser sees this device's screen (screen.ts, view mode).
 * - `remote_control`: a trusted browser sees it and sends mouse/keyboard input (control mode).
 * - `app_control`: an AI session launches and drives one app or AI website (computer MCP
 *   `launch_app` / `open_web_app`); it also grants that session computer control.
 */
export const ApprovalKind = z.enum([
  "tool",
  "decision",
  "computer_control",
  "terminal",
  "remote_view",
  "remote_control",
  "app_control",
]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;
export const ApprovalStatus = z.enum(["pending", "approved", "denied", "expired", "rejected_invalid"]);

/** Bidi/format (Cf) and control (Cc) characters: they can hide or reorder text on screen (R-M10). */
const INVISIBLE = /[\p{Cf}\p{Cc}]/gu;
export const SUMMARY_MAX = 300;

/**
 * The one way to build an approval summary (R-M10, ADR 0019): format and control characters
 * become spaces (bidi overrides can't reorder a command), and anything past `max` is cut with
 * an explicit `… (+N chars)` marker and `truncated: true`, so the screen never silently shows a
 * harmless prefix of a longer command.
 */
export const approvalSummary = (
  toolName: string,
  input: unknown,
  max = SUMMARY_MAX,
): { summary: string; truncated: boolean } => {
  const raw = `${toolName}: ${typeof input === "string" ? input : (JSON.stringify(input) ?? "")}`;
  const clean = raw.replace(INVISIBLE, " ");
  const chars = [...clean];
  if (chars.length <= max) return { summary: clean, truncated: false };
  return { summary: `${chars.slice(0, max).join("")}… (+${chars.length - max} chars)`, truncated: true };
};

/**
 * The cleartext body of an approval, sealed to every trusted client key.
 * Never stored or relayed in plaintext.
 */
export const ApprovalDetails = z.object({
  v: z.literal(1),
  toolName: z.string().max(128).optional(),
  /**
   * Human summary built by the agent with `approvalSummary` (e.g. "Bash: git push …"). No
   * bidi/format/control characters, enforced here (R-M10).
   */
  summary: z
    .string()
    .max(500)
    .refine((s) => !/[\p{Cf}\p{Cc}]/u.test(s), { message: "summary contains format or control characters" }),
  /** The summary was cut: clients require the full input to be expanded before an allow. */
  summaryTruncated: z.boolean().optional(),
  /** Tool input as the agent saw it (paths, command text, diff preview). */
  input: z.unknown().optional(),
  reasons: z.array(z.string().max(200)).max(10).default([]),
  origin: Origin,
  /** For kind=decision (Mesa). */
  question: z.string().max(500).optional(),
  options: z.array(z.string().max(120)).max(6).optional(),
});
export type ApprovalDetails = z.infer<typeof ApprovalDetails>;

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * ADR 0019 (R-H1): what the agent signs for every approval. `detailsHash` =
 * hex(SHA-256(JCS(details))) over the exact plaintext it seals; clients show the SIGNED risk
 * and step-up, and decisions carry the hash back.
 */
export const ApprovalRequestBody = z.object({
  v: z.literal(1),
  aid: ApprovalId,
  requestId: Id,
  sid: SessionId,
  /** The agent that asks (the signer). */
  deviceId: DeviceId,
  kind: ApprovalKind,
  risk: RiskTier,
  stepUpRequired: z.boolean(),
  origin: Origin,
  createdAt: EpochMs,
  expiresAt: EpochMs,
  detailsHash: Hex64,
});
export const SignedApprovalRequest = signed("chalito.approval.v1", ApprovalRequestBody);
export type SignedApprovalRequest = z.infer<typeof SignedApprovalRequest>;

/** What `detailsCt` opens to (ADR 0019): the details plus the agent's signed request. */
export const SealedApprovalPayload = z.object({
  details: ApprovalDetails,
  request: SignedApprovalRequest,
});
export type SealedApprovalPayload = z.infer<typeof SealedApprovalPayload>;

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
    /**
     * ADR 0020 (revoke-all): one assertion over SHA-256(JCS({ctx: "chalito.revoke-bundle.v1", L}))
     * where L lists every command's body hash plus the server's entry. Only on device.revokeClient.
     */
    bundle: z.array(Hex64).min(1).max(501).optional(),
  })
  .refine((s) => s.method !== "webauthn" || s.assertion !== undefined, {
    message: "webauthn step-up must include the assertion",
  })
  .refine((s) => s.bundle === undefined || s.method === "webauthn", {
    message: "a bundle step-up is a webauthn assertion",
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
    /**
     * ADR 0019 (R-H1): the `detailsHash` of the agent-signed request the client verified and
     * showed. Covered by the signature and the passkey step-up; agents reject a decision
     * without it or with another hash.
     */
    detailsHash: Hex64.optional(),
    /** Optional choice for kind=decision approvals. */
    choice: z.number().int().min(0).max(5).optional(),
  })
  .refine((d) => d.expiresAt > d.issuedAt && d.expiresAt - d.issuedAt <= APPROVAL_TTL_MS, {
    message: "decision expiry must be within 10 minutes of issue",
  })
  .refine((d) => d.stepUp?.bundle === undefined, { message: "decisions take a step-up over their own body only" });
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
