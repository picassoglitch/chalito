import { ENDORSEMENT_MAX_AGE_MS, type TrustedClientList } from "@chalito/crypto";
import { Endorsement, WebAuthnBinding } from "@chalito/protocol";
import type { AgentStore } from "./store.js";

export interface EndorsementSyncDeps {
  store: Pick<AgentStore, "listEndorsements">;
  trust: () => TrustedClientList;
  saveTrust: () => Promise<void>;
  now: () => number;
  /** Local audit of every client added this way. */
  onAdded: (deviceId: string, endorsedBy: string) => void;
  /**
   * A refusal the person should know about (never silent): missing/bad step-up, bad binding,
   * bad signature, too old. Called once per client and reason per `reported` set.
   */
  onRefused: (deviceId: string, endorsedBy: string, reason: ReportedRefusal) => void;
  /** Refusals already reported (kept by the caller across runs; the sync re-reads every 15 min). */
  reported: Set<string>;
  /** WebAuthn origins per relying party (the agent's config). */
  origins?: (rpId: string) => string[];
}

export type ReportedRefusal = "missing_step_up" | "bad_step_up" | "bad_binding" | "bad_signature" | "stale";
const REPORTED = new Set<string>(["missing_step_up", "bad_step_up", "bad_binding", "bad_signature", "stale"]);

/**
 * ADR 0018, the agent half: learn the account's endorsed clients. Each one is accepted only
 * through `TrustedClientList.addEndorsed`: signed by a client THIS agent already trusts, naming
 * this agent when the endorsement lists agents, at most 7 days old, carrying the endorser's
 * passkey step-up when this agent recorded one for it (R-L13), never a client removed here
 * (tombstone) and never one the directory reports revoked. Refusals that need the person are
 * reported (`onRefused`); the rest is ignored.
 * Returns the device ids added.
 */
export const syncEndorsements = async (d: EndorsementSyncDeps): Promise<string[]> => {
  const rows = await d.store.listEndorsements();
  const list = d.trust();
  const added: string[] = [];
  for (const row of rows) {
    if (row.revoked || list.has(row.deviceId) || list.isRemoved(row.deviceId)) continue;
    const e = Endorsement.safeParse(row.endorsement);
    if (!e.success || e.data.body.newDeviceId !== row.deviceId) continue;
    const binding = row.webauthnBinding ? WebAuthnBinding.safeParse(row.webauthnBinding) : null;
    if (binding && !binding.success) continue;
    const r = await list.addEndorsed(e.data, d.now(), {
      maxAgeMs: ENDORSEMENT_MAX_AGE_MS,
      webauthnBinding: binding?.data ?? null,
      ...(d.origins ? { origins: d.origins } : {}),
    });
    if (r.ok) {
      added.push(row.deviceId);
      d.onAdded(row.deviceId, e.data.signerDeviceId);
    } else if (REPORTED.has(r.reason)) {
      // "not_listed" is the endorser's choice (not this computer), not a problem to report.
      const key = `${row.deviceId}:${r.reason}`;
      if (!d.reported.has(key)) {
        d.reported.add(key);
        d.onRefused(row.deviceId, e.data.signerDeviceId, r.reason as ReportedRefusal);
      }
    }
  }
  if (added.length) await d.saveTrust();
  return added;
};
