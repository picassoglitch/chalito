import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";
import { toB64url, verifyWebAuthnAssertion, verifyWebAuthnBinding } from "@chalito/crypto";
import type { WebAuthnBinding } from "@chalito/protocol";
import {
  DeviceClientKeys,
  assertWithServerChallenge,
  generateDeviceKeys,
  publicKeys,
  registerPasskey,
  stepUpWithPasskey,
  type ApiClient,
} from "../src/index.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";

const RP = "chalito.chalyb.com";
const ORIGIN = `https://${RP}`;

/** The API's three WebAuthn routes, played by @simplewebauthn/server. */
const serverApi = (device: { deviceId: string; pubSign: string }) => {
  const bindings: WebAuthnBinding[] = [];
  let challenge = "";
  const stored: { publicKey?: Uint8Array; id?: string; counter?: number } = {};
  const api: ApiClient = {
    async post(path, body) {
      if (path === "/v1/webauthn/register/options") {
        // As the api does (R-M11): with a passkey on record, only an assertion by it may replace it.
        if (stored.id) {
          const current = (body as { currentAssertion?: never }).currentAssertion;
          if (!current) throw new Error("current_passkey_required");
          const v = await verifyAuthenticationResponse({
            response: current,
            expectedChallenge: challenge,
            expectedOrigin: ORIGIN,
            expectedRPID: RP,
            credential: { id: stored.id, publicKey: stored.publicKey as Uint8Array<ArrayBuffer>, counter: 0 },
            requireUserVerification: true,
          });
          if (!v.verified) throw new Error("current_passkey_failed");
        }
        const options = await generateRegistrationOptions({
          rpName: "Chalito",
          rpID: RP,
          userName: "dev_phone",
          attestationType: "none",
          authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
          supportedAlgorithmIDs: [-8, -7],
        });
        challenge = options.challenge;
        return { options } as never;
      }
      if (path === "/v1/webauthn/register/verify") {
        const v = await verifyRegistrationResponse({
          response: (body as { response: never }).response,
          expectedChallenge: challenge,
          expectedOrigin: ORIGIN,
          expectedRPID: RP,
          requireUserVerification: true,
          supportedAlgorithmIDs: [-8, -7],
        });
        if (!v.verified) throw new Error("not verified");
        Object.assign(stored, {
          publicKey: v.registrationInfo.credential.publicKey,
          id: v.registrationInfo.credential.id,
          counter: 0,
        });
        return {
          credential: { credentialId: stored.id, publicKey: await toB64url(stored.publicKey!), rpId: RP },
        } as never;
      }
      if (path === "/v1/webauthn/assert/options") {
        const options = await generateAuthenticationOptions({
          rpID: RP,
          allowCredentials: [{ id: stored.id! }],
          userVerification: "required",
        });
        challenge = options.challenge;
        return { options } as never;
      }
      if (path === "/v1/webauthn/register/bind") {
        // As the api does: the binding must be signed by the caller's DEVICE key and match the credential.
        const binding = (body as { binding: WebAuthnBinding }).binding;
        const check = await verifyWebAuthnBinding(binding, {
          deviceId: device.deviceId,
          pubSign: device.pubSign,
          rpId: RP,
        });
        if (!check.ok) throw new Error(`bad binding: ${check.reason}`);
        if (binding.body.credentialId !== stored.id || binding.body.publicKey !== (await toB64url(stored.publicKey!)))
          throw new Error("binding credential mismatch");
        bindings.push(binding);
        return { ok: true } as never;
      }
      throw new Error(path);
    },
  };
  return { api, stored, bindings, challenge: () => challenge };
};

describe.each([[-7 as const], [-8 as const]])(
  "WebAuthn ceremonies with a software authenticator (COSE alg %s)",
  (alg) => {
    it("registers a passkey the server verifies, and its assertions verify on the server and on the agent", async () => {
      const auth = new SoftAuthenticator({ origin: ORIGIN, alg });
      const dk = await generateDeviceKeys();
      const keys = await DeviceClientKeys.create(dk);
      const srv = serverApi({ deviceId: dk.deviceId, pubSign: (await publicKeys(dk)).pubSign });
      const credential = await registerPasskey(srv.api, keys, auth);
      expect(credential).toEqual({ credentialId: auth.credentialId, publicKey: auth.publicKey, rpId: RP });
      // The device bound the passkey to its own key; an agent trusting that key accepts it.
      expect(srv.bindings).toHaveLength(1);
      expect(srv.bindings[0]!.body).toMatchObject({ v: 1, deviceId: dk.deviceId, ...credential });

      // Server-challenged assertion (security actions), verified by @simplewebauthn/server.
      const resp = await assertWithServerChallenge(srv.api, auth);
      const v = await verifyAuthenticationResponse({
        response: resp,
        expectedChallenge: srv.challenge(),
        expectedOrigin: ORIGIN,
        expectedRPID: RP,
        credential: { id: srv.stored.id!, publicKey: srv.stored.publicKey! as Uint8Array<ArrayBuffer>, counter: 0 },
        requireUserVerification: true,
      });
      expect(v.verified).toBe(true);

      // Step-up assertion over a decision challenge, verified by the agent's own verifier.
      const challenge = new Uint8Array(32).fill(7);
      const a = await stepUpWithPasskey(credential, auth)(challenge);
      expect(
        (
          await verifyWebAuthnAssertion({
            assertion: a,
            credential,
            expectedChallenge: challenge,
            rpId: RP,
            origin: ORIGIN,
          })
        ).ok,
      ).toBe(true);
    });

    it("an authenticator without user verification is refused at registration", async () => {
      const dk = await generateDeviceKeys();
      const srv = serverApi({ deviceId: dk.deviceId, pubSign: (await publicKeys(dk)).pubSign });
      await expect(
        registerPasskey(
          srv.api,
          await DeviceClientKeys.create(dk),
          new SoftAuthenticator({ origin: ORIGIN, alg, flags: 0x01 }),
        ),
      ).rejects.toThrow();
      expect(srv.bindings).toHaveLength(0);
    });
  },
);

describe("R-M11: replacing this device's passkey", () => {
  it("needs the current passkey: without it the server refuses; with it the new one replaces it", async () => {
    const dk = await generateDeviceKeys();
    const keys = await DeviceClientKeys.create(dk);
    const srv = serverApi({ deviceId: dk.deviceId, pubSign: (await publicKeys(dk)).pubSign });
    const first = new SoftAuthenticator({ origin: ORIGIN });
    const c1 = await registerPasskey(srv.api, keys, first);
    const next = new SoftAuthenticator({ origin: ORIGIN });
    // A plain re-registration (a thief with the session and device key, no passkey): refused.
    await expect(registerPasskey(srv.api, keys, next)).rejects.toThrow(/current_passkey_required/);
    // The person's replacement: the current passkey asserts first, then the new one is created.
    const ceremonies = { create: (o: never) => next.create(o), get: (o: never) => first.get(o) };
    const c2 = await registerPasskey(srv.api, keys, ceremonies, Date.now, { replace: true });
    expect(c2.credentialId).toBe(next.credentialId);
    expect(c2.credentialId).not.toBe(c1.credentialId);
  });
});
