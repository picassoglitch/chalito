import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";
import { toB64url, verifyWebAuthnAssertion } from "@chalito/crypto";
import { assertWithServerChallenge, registerPasskey, stepUpWithPasskey, type ApiClient } from "../src/index.js";
import { SoftAuthenticator } from "../src/testing/soft-authenticator.js";

const RP = "chalito.chalyb.com";
const ORIGIN = `https://${RP}`;

/** The API's three WebAuthn routes, played by @simplewebauthn/server. */
const serverApi = () => {
  let challenge = "";
  const stored: { publicKey?: Uint8Array; id?: string; counter?: number } = {};
  const api: ApiClient = {
    async post(path, body) {
      if (path === "/v1/webauthn/register/options") {
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
      throw new Error(path);
    },
  };
  return { api, stored, challenge: () => challenge };
};

describe.each([[-7 as const], [-8 as const]])(
  "WebAuthn ceremonies with a software authenticator (COSE alg %s)",
  (alg) => {
    it("registers a passkey the server verifies, and its assertions verify on the server and on the agent", async () => {
      const auth = new SoftAuthenticator({ origin: ORIGIN, alg });
      const srv = serverApi();
      const credential = await registerPasskey(srv.api, auth);
      expect(credential).toEqual({ credentialId: auth.credentialId, publicKey: auth.publicKey, rpId: RP });

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
      const srv = serverApi();
      await expect(
        registerPasskey(srv.api, new SoftAuthenticator({ origin: ORIGIN, alg, flags: 0x01 })),
      ).rejects.toThrow();
    });
  },
);
