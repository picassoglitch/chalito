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
}

/**
 * ADR 0018, the agent half: learn the account's endorsed clients. Each one is accepted only
 * through `TrustedClientList.addEndorsed`: signed by a client THIS agent already trusts, naming
 * this agent when the endorsement lists agents, at most 7 days old, never a client removed here
 * (tombstone) and never one the directory reports revoked. Anything else is ignored.
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
    if (await list.addEndorsed(e.data, d.now(), ENDORSEMENT_MAX_AGE_MS, binding?.data ?? null)) {
      added.push(row.deviceId);
      d.onAdded(row.deviceId, e.data.signerDeviceId);
    }
  }
  if (added.length) await d.saveTrust();
  return added;
};
