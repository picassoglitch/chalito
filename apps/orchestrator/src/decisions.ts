import { fromB64url, verifyEnvelope } from "@chalito/crypto";
import { Decision } from "@chalito/protocol";

/**
 * Mesa decisions bind only after their Ed25519 signature is verified (the same rule as an agent's
 * approvals). For each pending orchestrator decision with signed answers, in arrival order:
 *  - parse the envelope (ctx chalito.decision.v1), check it names this signer, approval, request,
 *    owner and target "orchestrator", that it hasn't expired, and that its nonce isn't reused;
 *  - verify the signature against the signer's stored pub_sign (active client of the same owner);
 *  - only then ask the database to resolve it (chalito_private.resolve_orchestrator_decision,
 *    which re-checks the rows and can only touch pending orchestrator decisions).
 * The first VALID answer wins. Invalid ones are audited once and never resolve anything. A device
 * may try again (each attempt is its own insert-only row, migration 003510): a rejected attempt
 * never blocks that device's next one, and the database resolves with exactly the row verified.
 */
export interface PendingDecision {
  owner: string;
  aid: string;
  requestId: string;
  /** Signed answers, oldest first (each attempt its own row). */
  answers: { id: string; signer: string; decision: unknown }[];
}

export interface DecisionStore {
  pendingDecisions(filter: { owner?: string; aid?: string }): Promise<PendingDecision[]>;
  /** pub_sign (b64url) of an active client device of the owner, else null. */
  signerKey(owner: string, deviceId: string): Promise<string | null>;
  /** Whether this nonce already appears in a decision for another approval of the owner. */
  nonceUsedElsewhere(owner: string, aid: string, nonce: string): Promise<boolean>;
  /** Resolves with exactly the row the caller verified (`id`). */
  resolveDecision(owner: string, aid: string, signer: string, id: string): Promise<"approved" | "denied" | null>;
}

export type AuditFn = (e: { action: string; owner: string; target: string; meta: Record<string, unknown> }) => void;

export type Verdict = { ok: true } | { ok: false; reason: string };

export const SKEW_MS = 60_000;

export const verifyDecision = async (
  store: Pick<DecisionStore, "signerKey" | "nonceUsedElsewhere">,
  p: PendingDecision,
  answer: { signer: string; decision: unknown },
  now: number,
): Promise<Verdict> => {
  const env = Decision.safeParse(answer.decision);
  if (!env.success) return { ok: false, reason: "malformed" };
  const b = env.data.body;
  if (env.data.signerDeviceId !== answer.signer) return { ok: false, reason: "signer_mismatch" };
  if (b.aid !== p.aid || b.requestId !== p.requestId) return { ok: false, reason: "wrong_approval" };
  if (b.uid !== p.owner || b.targetDeviceId !== "orchestrator") return { ok: false, reason: "wrong_target" };
  if (b.expiresAt <= now || b.issuedAt > now + SKEW_MS) return { ok: false, reason: "expired" };
  const key = await store.signerKey(p.owner, answer.signer);
  if (!key) return { ok: false, reason: "untrusted_signer" };
  const v = await verifyEnvelope(env.data, "chalito.decision.v1", new Map([[answer.signer, await fromB64url(key)]]));
  if (!v.ok) return { ok: false, reason: v.reason };
  if (await store.nonceUsedElsewhere(p.owner, p.aid, b.nonce)) return { ok: false, reason: "replayed_nonce" };
  return { ok: true };
};

export interface ProcessResult {
  resolved: { owner: string; aid: string; status: "approved" | "denied"; signer: string }[];
  invalid: number;
}

export const processDecisions = async (
  d: { store: DecisionStore; now: () => number; audit: AuditFn; rejected: Set<string> },
  filter: { owner?: string; aid?: string } = {},
): Promise<ProcessResult> => {
  const out: ProcessResult = { resolved: [], invalid: 0 };
  const pending = await d.store.pendingDecisions(filter);
  // A full scan: forget rejections for approvals that are no longer pending (they can't come back),
  // so the set doesn't grow for the life of the instance.
  if (!filter.owner && !filter.aid) {
    const live = new Set(pending.map((p) => `${p.owner}/${p.aid}`));
    for (const key of d.rejected) if (!live.has(key.split("/", 2).join("/"))) d.rejected.delete(key);
  }
  for (const p of pending) {
    for (const answer of p.answers) {
      // Per attempt: a rejected row is audited once and never blocks the signer's next attempt.
      const key = `${p.owner}/${p.aid}/${answer.signer}/${answer.id}`;
      if (d.rejected.has(key)) continue;
      const v = await verifyDecision(d.store, p, answer, d.now());
      if (!v.ok) {
        d.rejected.add(key);
        out.invalid++;
        d.audit({
          action: "decision.invalid_signature",
          owner: p.owner,
          target: p.aid,
          meta: { signer: answer.signer, reason: v.reason },
        });
        continue;
      }
      const status = await d.store.resolveDecision(p.owner, p.aid, answer.signer, answer.id);
      if (status) {
        out.resolved.push({ owner: p.owner, aid: p.aid, status, signer: answer.signer });
        d.audit({
          action: "decision.resolved",
          owner: p.owner,
          target: p.aid,
          meta: { signer: answer.signer, status },
        });
        break; // the first valid answer wins
      }
    }
  }
  return out;
};
