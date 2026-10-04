import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { toB64url, type WebAuthnCredentialRef } from "@chalito/crypto";
import { WebAuthnBindRequest, WebAuthnBindingBody, type SigningContext } from "@chalito/protocol";
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

/** Signs as this device (DeviceClientKeys does; private keys stay inside it). */
export interface DeviceSigner {
  readonly deviceId: string;
  sign<T>(ctx: SigningContext, body: T): Promise<{ ctx: SigningContext; body: T; signerDeviceId: string; sig: string }>;
}

/**
 * Enrols a passkey for this device (D-034): server challenge → authenticator → server verifies
 * and stores the credential public key on the device record. Then the device signs a
 * `chalito.webauthn-binding.v1` over {deviceId, credentialId, publicKey, rpId} with its DEVICE
 * key and posts it, so each agent can record the passkey from the trust root it confirmed at the
 * reverse check (D-019). Returns the credential agents record.
 */
export const registerPasskey = async (
  api: ApiClient,
  device: DeviceSigner,
  ceremonies: Ceremonies = browserCeremonies,
  now: () => number = Date.now,
  opts: {
    /**
     * R-M11: this device already has a passkey. Replacing it needs an assertion by the CURRENT
     * one over a fresh server challenge (the api refuses otherwise with
     * `current_passkey_required`). Lost the old passkey? Re-enrol the device instead.
     */
    replace?: boolean;
  } = {},
) => {
  const currentAssertion = opts.replace ? await assertWithServerChallenge(api, ceremonies) : undefined;
  const { options } = await api.post<{ options: PublicKeyCredentialCreationOptionsJSON }>(
    "/v1/webauthn/register/options",
    currentAssertion ? { currentAssertion } : {},
  );
  const response = await ceremonies.create(options);
  const { credential } = await api.post<{ credential: WebAuthnCredentialRef }>("/v1/webauthn/register/verify", {
    response,
  });
  const body = WebAuthnBindingBody.parse({
    v: 1,
    deviceId: device.deviceId,
    credentialId: credential.credentialId,
    publicKey: credential.publicKey,
    rpId: credential.rpId,
    issuedAt: now(),
  });
  const binding = await device.sign("chalito.webauthn-binding.v1", body);
  await api.post("/v1/webauthn/register/bind", WebAuthnBindRequest.parse({ binding }));
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
