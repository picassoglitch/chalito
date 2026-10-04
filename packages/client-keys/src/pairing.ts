import { deriveDeviceId, fingerprint, fromB64url, signEnvelope } from "@chalito/crypto";
import { GlyphDecoder, verifyGlyph, type GlyphCheck, type RgbaImage } from "@chalito/glyph";
import {
  ClaimPairingRequest,
  EnrollEndorsedClientRequest,
  GlyphPayload,
  PairingClaimBody,
  RevokeDeviceRequest,
  type DeviceRegistration,
} from "@chalito/protocol";
import type { ApiClient } from "./api.js";
import type { DeviceKeys } from "./keys.js";
import { signEndorsement, signRevokeClient } from "./signing.js";

/**
 * Framework-free pairing logic for the PWA screens (brief §5 M2 steps 3–5, M5). The UI feeds
 * camera frames and shows `PairingDisplay`; nothing here touches the DOM.
 */

export type ClaimRequest = ReturnType<typeof ClaimPairingRequest.parse>;

/** What the phone shows before the user confirms: name, fingerprint, time left. */
export interface PairingDisplay {
  label: string;
  /** Derived locally from the glyph's signing key. The human compares it with the desktop's. */
  fingerprint: string;
  agentDeviceId: string;
  expiresInMs: number;
}

export type ScanResult =
  | { state: "scanning" }
  | { state: "ready"; glyph: GlyphPayload; display: PairingDisplay }
  | { state: "rejected"; reason: Exclude<GlyphCheck, { ok: true }>["reason"] | "wrong_purpose" | "malformed" };

export const pairingDisplay = async (glyph: GlyphPayload, now: number): Promise<PairingDisplay> => {
  const pub = await fromB64url(glyph.body.issuerPubSign);
  return {
    label: glyph.body.label,
    fingerprint: await fingerprint(pub),
    agentDeviceId: await deriveDeviceId(pub),
    expiresInMs: Math.max(0, glyph.body.expiresAt - now),
  };
};

/** Checks a decoded payload: schema, purpose, issuer signature and time window. */
export const checkPairingGlyph = async (
  raw: unknown,
  now: number,
): Promise<Exclude<ScanResult, { state: "scanning" }>> => {
  const parsed = GlyphPayload.safeParse(raw);
  if (!parsed.success) return { state: "rejected", reason: "malformed" };
  const glyph = parsed.data;
  if (glyph.body.purpose !== "pair_device") return { state: "rejected", reason: "wrong_purpose" };
  const check = await verifyGlyph(glyph, now);
  if (!check.ok) return { state: "rejected", reason: check.reason };
  return { state: "ready", glyph, display: await pairingDisplay(glyph, now) };
};

/** Camera side: push frames (RGBA from a canvas) until the glyph decodes and verifies. */
export class PairingScanner {
  #decoder = new GlyphDecoder();
  #result: ScanResult = { state: "scanning" };

  constructor(private readonly now: () => number = Date.now) {}

  async pushFrame(img: RgbaImage): Promise<ScanResult> {
    if (this.#result.state === "ready") return this.#result;
    const payload = this.#decoder.pushImage(img);
    if (!payload) return this.#result;
    this.#result = await checkPairingGlyph(payload, this.now());
    // A bad payload restarts the scan rather than sticking.
    if (this.#result.state === "rejected") this.#decoder = new GlyphDecoder();
    return this.#result;
  }

  reset(): void {
    this.#decoder = new GlyphDecoder();
    this.#result = { state: "scanning" };
  }
}

/** Accessibility fallback: the typed `XXXX-XXXX` code resolves server-side to the same signed payload. */
export const resolveShortCode = async (api: ApiClient, shortCode: string, now: number) => {
  const { glyph } = await api.post<{ glyph: unknown }>("/v1/pairing/resolve", { shortCode });
  return checkPairingGlyph(glyph, now);
};

/** After the user compared fingerprints and confirmed (biometric/passkey in the UI), sign the claim. */
export const buildPairingClaim = async (
  keys: DeviceKeys,
  c: { owner: string; glyph: GlyphPayload; now: number },
): Promise<ClaimRequest> => {
  const display = await pairingDisplay(c.glyph, c.now);
  const body = PairingClaimBody.parse({
    v: 1,
    owner: c.owner,
    codeId: c.glyph.body.codeId,
    agentDeviceId: display.agentDeviceId,
    agentFingerprint: display.fingerprint,
    claimerDeviceId: keys.deviceId,
    issuedAt: c.now,
  });
  return ClaimPairingRequest.parse({
    claim: await signEnvelope("chalito.pairing-claim.v1", body, keys.deviceId, keys.sign.secretKey),
  });
};

export const claimPairing = (api: ApiClient, req: ClaimRequest) =>
  api.post<{ ok: true; agentDeviceId: string }>("/v1/pairing/claim", req);

/**
 * Endorse a new browser/phone of the same account. The new device signs its own registration
 * (`signDeviceRegistration` on that device) and shows it here; this trusted client checks it is
 * self-consistent, then vouches for exactly those keys. Agents verify the endorsement locally.
 */
export const buildEndorsedEnrolment = async (
  keys: DeviceKeys,
  e: { uid: string; registration: DeviceRegistration; now: number },
) => {
  const reg = e.registration;
  if (reg.body.owner !== e.uid) throw new Error("registration is for another account");
  if (
    reg.signerDeviceId !== reg.body.deviceId ||
    (await deriveDeviceId(await fromB64url(reg.body.pubSign))) !== reg.body.deviceId
  )
    throw new Error("registration device id doesn't match its key");
  const endorsement = await signEndorsement(keys, {
    uid: e.uid,
    newDeviceId: reg.body.deviceId,
    pubSign: reg.body.pubSign,
    pubBox: reg.body.pubBox,
    now: e.now,
  });
  return EnrollEndorsedClientRequest.parse({ registration: reg, endorsement });
};

export const enrollEndorsed = (api: ApiClient, req: ReturnType<typeof EnrollEndorsedClientRequest.parse>) =>
  api.post<{ customToken: string; deviceId: string }>("/v1/devices/endorsed", req);

/**
 * Revoke a device: the server directory flips `revoked` (cuts its credential and listeners), and
 * each agent gets a signed `device.revokeClient` so it drops the key from its LOCAL trust list,
 * which is what actually stops the device's approvals (ADR 0006).
 */
export const revokeDevice = async (
  api: ApiClient,
  keys: DeviceKeys,
  r: { uid: string; deviceId: string; agentDeviceIds: string[]; now: number },
) => {
  await api.post("/v1/devices/revoke", RevokeDeviceRequest.parse({ deviceId: r.deviceId }));
  return Promise.all(
    r.agentDeviceIds.map((agentDeviceId) =>
      signRevokeClient(keys, { uid: r.uid, agentDeviceId, clientDeviceId: r.deviceId, now: r.now }),
    ),
  );
};
