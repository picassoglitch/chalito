import { ApiError, checkPairingGlyph, type ApiClient, type DeviceClientKeys } from "@chalito/client-keys";
import { PairingClaimBody } from "@chalito/protocol";
import type { PendingPairing } from "./ipc.js";

/**
 * Owner decision 2026-10-19 ("sign-in alone"): once the person signed in on this panel, it
 * connects this computer by itself. The panel IS a trusted client on the same computer, so it
 * claims the agent's code with the short code the agent just gave it over the local IPC (the api
 * counts it as typed), and answers the agent's reverse check only when the approver the agent
 * reports is this panel's own key. No browser, no second device.
 */

/** This panel's device keys: signs the claim, then trusts the computer's key from its glyph. */
export type PanelSigner = Pick<DeviceClientKeys, "deviceId" | "sign" | "trustAgentFromGlyph">;

export type ClaimOutcome = { ok: true } | { ok: false; reason: string };

/** Claims the code this computer is showing, as this panel. */
export const claimOwnComputer = async (
  api: ApiClient,
  keys: PanelSigner,
  p: PendingPairing,
  o: { owner: string; now: number },
): Promise<ClaimOutcome> => {
  if (p.state !== "waiting" || !p.computer) return { ok: false, reason: "not_waiting" };
  const check = await checkPairingGlyph(p.computer.glyph, o.now);
  if (check.state !== "ready") return { ok: false, reason: check.reason };
  // The glyph the agent handed over must be the computer it says it is.
  if (check.display.fingerprint !== p.computer.fingerprint) return { ok: false, reason: "fingerprint_mismatch" };
  try {
    const body = PairingClaimBody.parse({
      v: 1,
      owner: o.owner,
      codeId: check.glyph.body.codeId,
      agentDeviceId: check.display.agentDeviceId,
      agentFingerprint: check.display.fingerprint,
      claimerDeviceId: keys.deviceId,
      issuedAt: o.now,
    });
    const claim = await keys.sign("chalito.pairing-claim.v1", body);
    await api.post("/v1/pairing/claim", { claim, shortCode: p.computer.shortCode });
  } catch (err) {
    return { ok: false, reason: err instanceof ApiError ? err.code : "failed" };
  }
  try {
    await keys.trustAgentFromGlyph(check.glyph, check.display.fingerprint, o.now);
  } catch {
    // Paired anyway: the directory introduces it on the next connect.
  }
  return { ok: true };
};

/** The reverse check is ours to answer only when the approver is this panel's own key. */
export const approvedByThisPanel = (p: PendingPairing, ownFingerprint: string | null): boolean =>
  p.state === "claimed" && !!ownFingerprint && p.claimer?.fingerprint === ownFingerprint;
