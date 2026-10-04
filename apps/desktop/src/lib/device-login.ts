import type { ApiClient, DeviceSigner } from "@chalito/client-keys";
import { DeviceTokenResponse, RefreshChallengeBody } from "@chalito/protocol";

const nonce = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/**
 * After enrolment the panel signs in as ITSELF (its own Supabase Auth user, like the agent):
 * a signed refresh challenge at /v1/devices/token returns a magic-link hash. For
 * `connect({ signIn: { kind: "device", deviceId, login } })`.
 */
export const deviceLogin =
  (api: ApiClient, signer: DeviceSigner, owner: string, now: () => number = Date.now) =>
  async (): Promise<string> => {
    const body = RefreshChallengeBody.parse({
      v: 1,
      owner,
      deviceId: signer.deviceId,
      nonce: nonce(),
      issuedAt: now(),
    });
    const challenge = await signer.sign("chalito.refresh-challenge.v1", body);
    const res = DeviceTokenResponse.parse(await api.post("/v1/devices/token", challenge));
    if (res.deviceId !== signer.deviceId) throw new Error("token for another device");
    return res.customToken;
  };
