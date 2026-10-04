import { randomUUID } from "node:crypto";
import type { NonceStore, TrustedClientList } from "@chalito/crypto";
import { ApprovalRequest, Decision, type Origin, type ResolutionReason, type RiskTier } from "@chalito/protocol";
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
  now: () => number;
  ttlMs: () => number;
  /** Audit sink for rejected decisions (invalid, untrusted, replayed, …). */
  audit: (event: { type: string; [k: string]: unknown }) => void;
  setTimer?: (fn: () => void, ms: number) => { clear(): void };
}

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
    details: { toolName: string; summary: string; input: unknown; reasons: string[] };
    onRequested?: (aid: string, expiresAt: number) => void;
  }): Promise<ApprovalOutcome> {
    const { store, trust, nonces, sealer, owner, deviceId, now, ttlMs, audit } = this.deps;
    if (Object.keys(trust().recipients()).length === 0) return { allow: false, reason: "untrusted_signer" };

    const aid = randomUUID();
    const requestId = randomUUID();
    const createdAt = now();
    const expiresAt = createdAt + ttlMs();
    const req = ApprovalRequest.parse({
      v: 1,
      aid,
      uid: owner,
      deviceId,
      sid: input.sid,
      requestId,
      kind: "tool",
      risk: input.risk,
      origin: input.origin,
      stepUpRequired: input.stepUp,
      detailsCt: await sealer.seal({ v: 1, ...input.details, origin: input.origin }, `approval:${aid}`),
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
          if (
            input.stepUp &&
            d.allow &&
            !(d.stepUp && (d.stepUp.method === "webauthn" || d.stepUp.method === "platform_biometric"))
          ) {
            // WebAuthn assertions are cryptographically verified once passkeys are enrolled (M5, D-034).
            audit({ type: "approval.decision_rejected", aid, reason: "missing_step_up" });
            return;
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
