import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { toB64url, type WebAuthnCredentialRef } from "@chalito/crypto";
import type { ApiClient } from "./api.js";
import type { StepUpAssertion } from "./signing.js";

/** The browser ceremonies; tests inject a software authenticator. */
export interface Ceremonies {
  create(options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON>;
  get(options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON>;
}

export const browserCeremonies: Ceremonies = {
  create: (optionsJSON) => startRegistration({ optionsJSON }),
  get: (optionsJSON) => startAuthentication({ optionsJSON }),
};

/**
 * Enrols a passkey for this device (D-034): server challenge → authenticator → server verifies
 * and stores the credential public key on the device record. Returns what an agent records at
 * the local reverse check.
 */
export const registerPasskey = async (api: ApiClient, ceremonies: Ceremonies = browserCeremonies) => {
  const { options } = await api.post<{ options: PublicKeyCredentialCreationOptionsJSON }>(
    "/v1/webauthn/register/options",
    {},
  );
  const response = await ceremonies.create(options);
  const { credential } = await api.post<{ credential: WebAuthnCredentialRef }>("/v1/webauthn/register/verify", {
    response,
  });
  return credential;
};

/**
 * The step-up for a HIGH/CRITICAL decision: an assertion by this device's passkey over the
 * decision's challenge (computed by `signDecision`). No server round-trip: the agent verifies it.
 */
export const stepUpWithPasskey =
  (
    credential: Pick<WebAuthnCredentialRef, "credentialId" | "rpId">,
    ceremonies: Ceremonies = browserCeremonies,
  ): StepUpAssertion =>
  async (challenge) => {
    const r = await ceremonies.get({
      challenge: await toB64url(challenge),
      rpId: credential.rpId,
      allowCredentials: [{ id: credential.credentialId, type: "public-key" }],
      userVerification: "required",
      timeout: 60_000,
    });
    return {
      credentialId: r.id,
      authenticatorData: r.response.authenticatorData,
      clientDataJSON: r.response.clientDataJSON,
      signature: r.response.signature,
    };
  };

/** A server-challenged assertion (security actions: pairing, endorsement, recovery). */
export const assertWithServerChallenge = async (
  api: ApiClient,
  ceremonies: Ceremonies = browserCeremonies,
): Promise<AuthenticationResponseJSON> => {
  const { options } = await api.post<{ options: PublicKeyCredentialRequestOptionsJSON }>(
    "/v1/webauthn/assert/options",
    {},
  );
  return ceremonies.get(options);
};
