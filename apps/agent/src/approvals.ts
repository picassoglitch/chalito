import { createHash, randomUUID } from "node:crypto";
import {
  canonicalize,
  signEnvelope,
  stepUpChallenge,
  verifyWebAuthnAssertion,
  type NonceStore,
  type SigningKeyPair,
  type TrustedClientList,
} from "@chalito/crypto";
import {
  ApprovalDetails,
  ApprovalRequest,
  ApprovalRequestBody,
  Decision,
  approvalSummary,
  type Origin,
  type ApprovalKind,
  type ResolutionReason,
  type RiskTier,
} from "@chalito/protocol";
import type { Sealer } from "./sealing.js";
import type { AgentStore } from "./store.js";

export interface ApprovalOutcome {
  allow: boolean;
  reason: ResolutionReason;
  byDeviceId?: string;
}

export interface ApprovalDeps {
  store: AgentStore;
  trust: () => TrustedClientList;
  nonces: NonceStore;
  sealer: Sealer;
  owner: string;
  deviceId: string;
  /** This agent's signing key: every approval request is signed (ADR 0019, R-H1). */
  signer: SigningKeyPair;
  now: () => number;
  ttlMs: () => number;
  /** Audit sink for rejected decisions (invalid, untrusted, replayed, …). */
  audit: (event: { type: string; [k: string]: unknown }) => void;
  setTimer?: (fn: () => void, ms: number) => { clear(): void };
  /** Origins a passkey assertion may come from, per rpId (default: https://<rpId>). */
  webauthnOrigins?: (rpId: string) => string[];
}

/**
 * Step-up for HIGH/CRITICAL allows (D-019): a WebAuthn assertion by the passkey this device
 * recorded for the signer at the local reverse check, over SHA-256(JCS(decision body without
 * stepUp)). Returns why it fails, or null when it verifies. Self-asserted methods (a bare
 * `platform_biometric`) no longer count.
 */
const stepUpFailure = async (
  trust: TrustedClientList,
  decision: Decision,
  origins: (rpId: string) => string[],
): Promise<string | null> => {
  const credential = trust.webauthnFor(decision.signerDeviceId);
  if (!credential) return "no_passkey_recorded";
  const step = decision.body.stepUp;
  if (!step || step.method !== "webauthn" || !step.assertion) return "no_webauthn_assertion";
  const res = await verifyWebAuthnAssertion({
    assertion: step.assertion,
    credential,
    expectedChallenge: await stepUpChallenge(decision.body),
    rpId: credential.rpId,
    origin: origins(credential.rpId),
  });
  return res.ok ? null : `assertion_${res.reason}`;
};

const defaultTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  return { clear: () => clearTimeout(t) };
};

/**
 * Creates `approvals/{aid}` (details sealed to trusted clients) and waits for a signed
 * Decision. Only a decision that verifies against the LOCAL trusted list, matches this
 * request, is unexpired and unreplayed (and carries step-up for HIGH/CRITICAL) counts.
 * Anything else is rejected and logged, and the wait continues. No answer = deny.
 */
export class ApprovalManager {
  constructor(private readonly deps: ApprovalDeps) {}

  async request(input: {
    sid: string;
    risk: RiskTier;
    stepUp: boolean;
    origin: Origin;
    /** `tool` (default) for one tool call; `computer_control` for a session's computer-control grant. */
    kind?: Extract<ApprovalKind, "tool" | "computer_control">;
    /** The summary is built here (R-M10: no format/control characters, explicit truncation). */
    details: { toolName: string; input: unknown; reasons: string[] };
    onRequested?: (aid: string, expiresAt: number) => void;
  }): Promise<ApprovalOutcome> {
    const { store, trust, nonces, sealer, owner, deviceId, signer, now, ttlMs, audit } = this.deps;
    if (Object.keys(trust().recipients()).length === 0) return { allow: false, reason: "untrusted_signer" };

    const aid = randomUUID();
    const requestId = randomUUID();
    const createdAt = now();
    const expiresAt = createdAt + ttlMs();
    // ADR 0019: the exact plaintext the clients will show, its hash, and our signature over the
    // request (risk, step-up, hash). Both travel sealed; clients verify against our key.
    const { summary, truncated } = approvalSummary(input.details.toolName, input.details.input);
    const details = ApprovalDetails.parse({
      v: 1,
      toolName: input.details.toolName,
      summary,
      ...(truncated ? { summaryTruncated: true } : {}),
      input: input.details.input,
      reasons: input.details.reasons,
      origin: input.origin,
    });
    const detailsHash = createHash("sha256").update(canonicalize(details)).digest("hex");
    const request = await signEnvelope(
      "chalito.approval.v1",
      ApprovalRequestBody.parse({
        v: 1,
        aid,
        requestId,
        sid: input.sid,
        deviceId,
        kind: input.kind ?? "tool",
        risk: input.risk,
        stepUpRequired: input.stepUp,
        origin: input.origin,
        createdAt,
        expiresAt,
        detailsHash,
      }),
      deviceId,
      signer.secretKey,
    );
    const req = ApprovalRequest.parse({
      v: 1,
      aid,
      uid: owner,
      deviceId,
      sid: input.sid,
      requestId,
      kind: input.kind ?? "tool",
      risk: input.risk,
      origin: input.origin,
      stepUpRequired: input.stepUp,
      detailsCt: await sealer.seal({ details, request }, `approval:${aid}`),
      status: "pending",
      createdAt,
      expiresAt,
      recommendations: [],
    });
    await store.createApproval(req);
    input.onRequested?.(aid, expiresAt);

    const outcome = await new Promise<ApprovalOutcome>((resolve) => {
      let settled = false;
      const finish = (o: ApprovalOutcome) => {
        if (settled) return;
        settled = true;
        unwatch();
        timer.clear();
        resolve(o);
      };
      const timer = (this.deps.setTimer ?? defaultTimer)(
        () => finish({ allow: false, reason: "timeout_deny" }),
        expiresAt - now(),
      );
      const unwatch = store.watchApproval(aid, (raw) => {
        void (async () => {
          const parsed = Decision.safeParse(raw);
          if (!parsed.success) {
            audit({ type: "approval.decision_rejected", aid, reason: "invalid_signature" });
            return;
          }
          const check = await trust().verifyDecision(parsed.data, { aid, requestId }, now(), nonces);
          if (!check.ok) {
            const reason: ResolutionReason =
              check.reason === "wrong_context" || check.reason === "wrong_request" ? "invalid_signature" : check.reason;
            audit({ type: "approval.decision_rejected", aid, reason, signer: parsed.data.signerDeviceId });
            return;
          }
          const d = parsed.data.body;
          // ADR 0019: an allow must be for exactly what we signed (a swapped details_ct shows the
          // person something else and can never yield a usable allow). A deny is always fine.
          if (d.allow && d.detailsHash !== detailsHash) {
            audit({
              type: "approval.decision_rejected",
              aid,
              reason: "details_mismatch",
              signer: parsed.data.signerDeviceId,
            });
            return;
          }
          if (input.stepUp && d.allow) {
            const failure = await stepUpFailure(
              trust(),
              parsed.data,
              this.deps.webauthnOrigins ?? ((rpId) => [`https://${rpId}`]),
            );
            if (failure) {
              audit({
                type: "approval.decision_rejected",
                aid,
                reason: "missing_step_up",
                detail: failure,
                signer: parsed.data.signerDeviceId,
              });
              return;
            }
          }
          finish({
            allow: d.allow,
            reason: d.allow ? "signed_allow" : "signed_deny",
            byDeviceId: check.signerDeviceId,
          });
        })();
      });
    });

    const status = outcome.reason === "timeout_deny" ? "expired" : outcome.allow ? "approved" : "denied";
    await store.resolveApproval(aid, status, outcome.reason, now());
    return outcome;
  }
}
