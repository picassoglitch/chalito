import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { fromB64url } from "@chalito/crypto";
import type { Deps } from "../deps.js";
import type { WebAuthnConfig } from "../routes/webauthn.js";

export type StepUpResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; error: "step_up_required" | "step_up_failed" | "authenticator_cloned" };

/**
 * A passkey step-up for a device that has one: a server-challenged WebAuthn assertion (the
 * challenge from POST /v1/webauthn/assert/options), user verification required, and an atomic
 * sign-counter bump that refuses — and audits — a counter that didn't move forward (a cloned
 * authenticator). `during` names the action in that audit event.
 */
export const verifyStepUp = async (
  deps: Deps,
  wa: WebAuthnConfig,
  p: { owner: string; uid: string; deviceId: string; stepUp: unknown; during: string },
): Promise<StepUpResult> => {
  const cred = await deps.repo.getDeviceWebAuthn(p.owner, p.deviceId);
  if (!cred) return { ok: false, status: 403, error: "step_up_required" };
  if (!p.stepUp) return { ok: false, status: 401, error: "step_up_required" };
  const challenge = await deps.repo.takeWebAuthnChallenge(p.owner, p.deviceId, "assert", deps.now());
  if (!challenge) return { ok: false, status: 401, error: "step_up_failed" };
  const counter = await verifyAuthenticationResponse({
    response: p.stepUp as AuthenticationResponseJSON,
    expectedChallenge: challenge,
    expectedOrigin: wa.origins,
    expectedRPID: wa.rpId,
    credential: {
      id: cred.credentialId,
      publicKey: new Uint8Array(await fromB64url(cred.publicKey)),
      // The counter check is the repo's atomic compare below (it also catches concurrent
      // assertions and raises the clone alert), so the library doesn't pre-empt it.
      counter: 0,
      transports: cred.transports as never,
    },
    requireUserVerification: true,
  }).then(
    (r) =>
      r.verified && r.authenticationInfo.credentialID === cred.credentialId ? r.authenticationInfo.newCounter : null,
    () => null,
  );
  if (counter === null) return { ok: false, status: 401, error: "step_up_failed" };
  const bumped = await deps.repo.bumpWebAuthnCounter(p.owner, p.deviceId, cred.credentialId, counter);
  if (bumped === "cloned") {
    await deps.audit.record({
      action: "webauthn.clone_suspected",
      owner: p.owner,
      actor: p.uid,
      target: p.deviceId,
      meta: { credentialId: cred.credentialId, stored: cred.counter, reported: counter, during: p.during },
    });
    console.warn("[api] passkey sign counter did not advance; refusing (possible cloned authenticator)");
    return { ok: false, status: 403, error: "authenticator_cloned" };
  }
  if (bumped === "not_found") return { ok: false, status: 401, error: "step_up_failed" };
  return { ok: true };
};
