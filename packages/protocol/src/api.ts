import { z } from "zod";
import { DeviceId, DeviceKind, EpochMs, Fingerprint, Platform, PubBox, PubSign, ReplayNonce, Uid } from "./common.js";
import { Endorsement, signed } from "./crypto.js";
import { GlyphPayload, ShortCode } from "./glyph.js";

/**
 * Request/response shapes for `api` (control plane). Every device id is derived from
 * the device's signing key (see `deriveDeviceId` in @chalito/crypto), so the server
 * and the device agree on it without coordination and a key can't claim another id.
 */

export const DeviceIdPattern = /^dev_[A-Za-z0-9_-]{22}$/;
export const DerivedDeviceId = z.string().regex(DeviceIdPattern);

/** Proof of possession: the new device signs its own registration with the key it registers. */
export const DeviceRegistrationBody = z.object({
  v: z.literal(1),
  owner: Uid,
  deviceId: DerivedDeviceId,
  kind: DeviceKind,
  platform: Platform,
  name: z.string().min(1).max(40),
  pubSign: PubSign,
  pubBox: PubBox,
  issuedAt: EpochMs,
});
export const DeviceRegistration = signed("chalito.device-register.v1", DeviceRegistrationBody);
export type DeviceRegistration = z.infer<typeof DeviceRegistration>;

/** Recovery codes: 26 Crockford base32 chars (130 bits) shown as 5-5-5-5-6. */
export const RecoveryCode = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}-[0-9A-HJKMNP-TV-Z]{6}$/);

/** First trusted client (the phone). Allowed only while the account has no active client. */
export const EnrollFirstClientRequest = z.object({
  registration: DeviceRegistration,
  recoveryCode: RecoveryCode,
});

/** Additional client, endorsed by an already-trusted client. Agents re-verify locally. */
export const EnrollEndorsedClientRequest = z.object({
  registration: DeviceRegistration,
  endorsement: Endorsement,
});

/** Device token refresh: a fresh signature over a short-lived challenge. */
export const RefreshChallengeBody = z.object({
  v: z.literal(1),
  owner: Uid,
  deviceId: DerivedDeviceId,
  nonce: ReplayNonce,
  issuedAt: EpochMs,
});
export const RefreshChallenge = signed("chalito.refresh-challenge.v1", RefreshChallengeBody);

export const DeviceTokenResponse = z.object({ customToken: z.string().min(1), deviceId: DerivedDeviceId });

/** Agent publishes its self-signed glyph payload; server stores it and returns a short code. */
export const CreatePairingCodeRequest = z.object({
  glyph: GlyphPayload,
  kind: z.enum(["desktop", "laptop"]),
  platform: z.enum(["linux", "windows", "macos"]),
});
export const CreatePairingCodeResponse = z.object({
  shortCode: ShortCode,
  /** Firebase custom token that can only read pairingCodes/{codeId} (event-driven wait, no polling). */
  watchToken: z.string().min(1),
  expiresAt: EpochMs,
});

/** Raw user input; the server normalises it (case, O/0, I/L/1, spaces). */
export const ResolveShortCodeRequest = z.object({ shortCode: z.string().min(8).max(20) });

/** The phone confirms the device it saw (fingerprint) and signs the claim. */
export const PairingClaimBody = z.object({
  v: z.literal(1),
  owner: Uid,
  codeId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  agentDeviceId: DerivedDeviceId,
  agentFingerprint: Fingerprint,
  claimerDeviceId: DeviceId,
  issuedAt: EpochMs,
});
export const PairingClaim = signed("chalito.pairing-claim.v1", PairingClaimBody);
export const ClaimPairingRequest = z.object({ claim: PairingClaim });

export const RevokeDeviceRequest = z.object({ deviceId: DeviceId });

export const StartRecoveryRequest = z.object({ recoveryCode: RecoveryCode });
export const CompleteRecoveryRequest = z.object({
  recoveryCode: RecoveryCode,
  registration: DeviceRegistration,
  /** New recovery code chosen by the new phone; the old one stops working. */
  newRecoveryCode: RecoveryCode,
});

/** Hub SSO exchange (web → api). */
export const SsoExchangeRequest = z.object({ token: z.string().min(10).max(4096) });
export const SsoExchangeResponse = z.object({ customToken: z.string().min(1), owner: Uid });

/** `pairingCodes/{codeId}` as the agent watches it. */
export const PairingCodeDoc = z.object({
  v: z.literal(1),
  codeId: z.string(),
  shortCodeHash: z.string().regex(/^[0-9a-f]{64}$/),
  glyph: GlyphPayload,
  agentDeviceId: DerivedDeviceId,
  kind: z.enum(["desktop", "laptop"]),
  platform: z.enum(["linux", "windows", "macos"]),
  claimed: z.boolean(),
  owner: Uid.nullable(),
  claimedByDeviceId: DeviceId.nullable(),
  /** Phone's keys, so the desktop can show the phone fingerprint for the reverse check. */
  claimerPubSign: PubSign.nullable(),
  claimerPubBox: PubBox.nullable(),
  expiresAt: EpochMs,
});
export type PairingCodeDoc = z.infer<typeof PairingCodeDoc>;

/** `users/{uid}/devices/{deviceId}` */
export const DeviceDoc = z.object({
  v: z.literal(1),
  deviceId: DeviceId,
  owner: Uid,
  kind: DeviceKind,
  platform: Platform,
  name: z.string().max(40),
  role: z.enum(["agent", "client"]),
  pubSign: PubSign,
  pubBox: PubBox,
  fingerprint: Fingerprint,
  enrolledVia: z.enum(["first_client", "endorsement", "pairing", "recovery"]),
  endorsedBy: DeviceId.nullable(),
  revoked: z.boolean(),
  revokedAt: EpochMs.nullable(),
  createdAt: EpochMs,
  lastSeenAt: EpochMs.nullable(),
  policyHash: z.string().nullable(),
  devMode: z.object({ on: z.boolean(), toggles: z.array(z.string()), since: EpochMs.nullable() }),
});
export type DeviceDoc = z.infer<typeof DeviceDoc>;

export const ApiError = z.object({ error: z.string(), message: z.string().optional() });
