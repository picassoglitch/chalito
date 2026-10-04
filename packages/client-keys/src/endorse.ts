import { deriveDeviceId, fingerprint, fromB64url, randomNonce, toB64url, verifyEnvelope } from "@chalito/crypto";
import { signGlyph, verifyGlyph } from "@chalito/glyph";
import { EndorsementBody, GlyphPayload, ResolveEndorseCodeResponse, type DeviceRegistration } from "@chalito/protocol";
import { ApiError, type ApiClient } from "./api.js";
import type { DeviceKeys } from "./keys.js";
import type { DeviceSigner } from "./webauthn.js";

/**
 * The endorsement handoff's key flows (/v1/endorse, ADR 0006). The new device's waiting side
 * (publish, watch, take) is @chalito/client's `endorsementChannel`.
 *
 *  - New device: `endorseGlyph` signs the `endorse_client` glyph over the server's code with
 *    the key it registers, so a scan binds the code to that key.
 *  - Trusted client: `resolveForEndorsement` (scanned glyph or typed short code) checks the
 *    registration and returns what the person must compare; `approveEndorsement` signs the
 *    endorsement for exactly those keys and posts it, with a passkey step-up if this device
 *    has one.
 */

export class EndorseError extends Error {
  override name = "EndorseError";
  constructor(readonly code: string) {
    super(`endorse: ${code}`);
  }
}

/** New device: the glyph shown next to the short code. */
export const endorseGlyph = async (
  keys: DeviceKeys,
  code: { codeId: string; expiresAt: number },
  o: { label: string; now: number },
): Promise<GlyphPayload> =>
  signGlyph(
    {
      v: 1,
      purpose: "endorse_client",
      codeId: code.codeId,
      issuerPubSign: await toB64url(keys.sign.publicKey),
      issuerPubBox: await toB64url(keys.box.publicKey),
      label: o.label.slice(0, 40),
      issuedAt: o.now,
      expiresAt: code.expiresAt,
      nonce: await randomNonce(),
    },
    keys.sign.secretKey,
  );

export interface EndorseTarget {
  codeId: string;
  registration: DeviceRegistration;
  expiresAt: number;
  /** What the person checks on both screens before approving. */
  display: { name: string; kind: string; deviceId: string; fingerprint: string; expiresInMs: number };
}

/**
 * Trusted client: from a scanned glyph (verified: signature, purpose, time) or a typed short
 * code, fetch the new device's registration and check it is self-consistent and, for a glyph,
 * registered with the very key that signed the glyph.
 */
export const resolveForEndorsement = async (
  api: ApiClient,
  input: { glyph: unknown } | { shortCode: string },
  now: number,
): Promise<EndorseTarget> => {
  let codeId: string | null = null;
  let glyphKey: string | null = null;
  if ("glyph" in input) {
    const g = GlyphPayload.safeParse(input.glyph);
    if (!g.success) throw new EndorseError("malformed");
    if (g.data.body.purpose !== "endorse_client") throw new EndorseError("wrong_purpose");
    const check = await verifyGlyph(g.data, now);
    if (!check.ok) throw new EndorseError(check.reason);
    codeId = g.data.body.codeId;
    glyphKey = g.data.body.issuerPubSign;
  }
  let res;
  try {
    res = ResolveEndorseCodeResponse.parse(
      await api.post(
        "/v1/endorse/resolve",
        codeId ? { codeId } : { shortCode: (input as { shortCode: string }).shortCode },
      ),
    );
  } catch (err) {
    throw new EndorseError(err instanceof ApiError ? err.code : "bad_response");
  }
  if (codeId && res.codeId !== codeId) throw new EndorseError("code_mismatch");
  const reg = res.registration;
  if (glyphKey && reg.body.pubSign !== glyphKey) throw new EndorseError("key_mismatch");
  const pub = await fromB64url(reg.body.pubSign);
  if (reg.signerDeviceId !== reg.body.deviceId || (await deriveDeviceId(pub)) !== reg.body.deviceId)
    throw new EndorseError("device_id_mismatch");
  const sig = await verifyEnvelope(reg, "chalito.device-register.v1", new Map([[reg.body.deviceId, pub]]));
  if (!sig.ok) throw new EndorseError("bad_registration");
  return {
    codeId: res.codeId,
    registration: reg,
    expiresAt: res.expiresAt,
    display: {
      name: reg.body.name,
      kind: reg.body.kind,
      deviceId: reg.body.deviceId,
      fingerprint: await fingerprint(pub),
      expiresInMs: Math.max(0, res.expiresAt - now),
    },
  };
};

/**
 * Trusted client, after the person compared the fingerprint: sign the endorsement for exactly
 * the resolved keys and post it. `stepUp` (a server-challenged passkey assertion, e.g.
 * `() => assertWithServerChallenge(api)`) is required by the api when this device has a passkey.
 */
export const approveEndorsement = async (
  api: ApiClient,
  signer: DeviceSigner,
  target: Pick<EndorseTarget, "codeId" | "registration">,
  o: { uid: string; now: number; stepUp?: () => Promise<unknown> },
): Promise<void> => {
  const reg = target.registration.body;
  if (reg.owner !== o.uid) throw new EndorseError("owner_mismatch");
  if (reg.deviceId === signer.deviceId) throw new EndorseError("self_endorsement");
  const endorsement = await signer.sign(
    "chalito.endorsement.v1",
    EndorsementBody.parse({
      v: 1,
      uid: o.uid,
      newDeviceId: reg.deviceId,
      pubSign: reg.pubSign,
      pubBox: reg.pubBox,
      issuedAt: o.now,
    }),
  );
  const stepUp = o.stepUp ? await o.stepUp() : undefined;
  try {
    await api.post("/v1/endorse/approve", { codeId: target.codeId, endorsement, ...(stepUp ? { stepUp } : {}) });
  } catch (err) {
    throw new EndorseError(err instanceof ApiError ? err.code : "failed");
  }
};
