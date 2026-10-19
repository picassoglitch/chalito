import { z } from "zod";
import { DeviceId, DeviceKind, EpochMs, Fingerprint, Platform, PubBox, PubSign, ReplayNonce, Uid } from "./common.js";
import { Endorsement, WebAuthnBinding, signed } from "./crypto.js";
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

/**
 * Any client, enrolled by the person's sign-in alone (owner decision 2026-10-19: signing in on a
 * device approves it, no second device). Agents trust it from the devices directory.
 */
export const EnrollSignInClientRequest = z.object({
  registration: DeviceRegistration,
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
/**
 * Hand-off pairing (ADR 0028 §3–§4). The desktop opens `/computadoras/aprobar#c=<codeId>&p=<port>`.
 * The fragment carries the code id (and the agent's loopback port) only, never the short code,
 * so typing the short code stays a proof of being in front of that computer.
 */
export const PAIRING_APPROVE_PATH = "/computadoras/aprobar";
/** The unpaired agent's loopback endpoint listens on 127.0.0.1, on the first free port here. */
export const PAIRING_LOOPBACK_PORTS = [47810, 47811, 47812, 47813, 47814] as const;
export const pairingApproveUrl = (webBase: string, codeId: string, port?: number) =>
  `${webBase.replace(/\/+$/, "")}${PAIRING_APPROVE_PATH}#c=${encodeURIComponent(codeId)}${port ? `&p=${port}` : ""}`;
export const PairingCodeId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
/** A server nonce (256 bits) issued to one client's /handoff, single use, for the loopback proof. */
export const PairingNonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * The agent's proof that the approving browser runs on the same computer: it answered the page's
 * loopback request (Origin = the hub) and signed the nonce the api gave that browser, with the key
 * it published at /codes. A link can't carry one: the nonce is the approving browser's own.
 */
export const PairingLoopbackProofBody = z.object({
  v: z.literal(1),
  codeId: PairingCodeId,
  nonce: PairingNonce,
  /** The page's origin as the agent saw it (Origin header), e.g. https://www.chalyb.com. */
  origin: z.string().max(200),
  issuedAt: EpochMs,
});
export const PairingLoopbackProof = signed("chalito.pairing-loopback.v1", PairingLoopbackProofBody);
export type PairingLoopbackProof = z.infer<typeof PairingLoopbackProof>;

export const ClaimPairingRequest = z.object({
  claim: PairingClaim,
  /**
   * The short code the user typed from the computer's screen (ADR 0028 §4). Required by the server
   * unless the claim carries a loopback proof or this client already typed it at /resolve.
   */
  shortCode: z.string().min(8).max(20).optional(),
  loopbackProof: PairingLoopbackProof.optional(),
});

/** One tap is only for a browser proven to run on that computer (loopback); otherwise the code. */
export const PairingApproval = z.enum(["one_tap", "code_required", "blocked"]);
export type PairingApproval = z.infer<typeof PairingApproval>;
/** Same public network as the computer, another one, or can't tell. Warning text only, never a gate. */
export const PairingNetwork = z.enum(["same", "different", "unknown"]);
export type PairingNetwork = z.infer<typeof PairingNetwork>;

export const PairingHandoffRequest = z.object({ codeId: PairingCodeId });
export const PairingHandoffResponse = z.object({
  glyph: GlyphPayload,
  kind: z.enum(["desktop", "laptop"]),
  platform: z.enum(["linux", "windows", "macos"]),
  expiresAt: EpochMs,
  network: PairingNetwork,
  /** What approving needs without a loopback proof. */
  approval: PairingApproval,
  /** Coarse place of the computer's network when the platform reports one; never an address. */
  city: z.string().max(80).nullable(),
  /** For the loopback proof (/handoff only); null after a typed code (/resolve). */
  loopbackNonce: PairingNonce.nullable().default(null),
  /** This client typed the short code already (/resolve): /claim needs nothing more. */
  codeTyped: z.boolean().default(false),
});
export type PairingHandoffResponse = z.infer<typeof PairingHandoffResponse>;

/** The agent withdraws its own code: "Cancelar" while waiting, "No fui yo" at the reverse check. */
export const PairingWithdrawBody = z.object({ v: z.literal(1), codeId: PairingCodeId, issuedAt: EpochMs });
export const PairingWithdraw = signed("chalito.pairing-withdraw.v1", PairingWithdrawBody);
export const WithdrawPairingRequest = z.object({ withdraw: PairingWithdraw });

/** "No estoy frente a esa computadora": cancels the code; the computer shows it was declined. */
export const DeclinePairingRequest = z.object({ codeId: PairingCodeId });

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
  /** The claimer's passkey binding (signed by its device key), for the agent's reverse check. */
  claimerWebauthnBinding: WebAuthnBinding.nullable().default(null),
  /** Declined from the approval screen; the code can't be claimed any more. */
  cancelled: z.boolean().default(false),
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
  enrolledVia: z.enum(["first_client", "endorsement", "pairing", "recovery", "sign_in"]),
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

/** POST /v1/webauthn/register/bind: the device's signed binding for the passkey it just registered. */
export const WebAuthnBindRequest = z.object({ binding: WebAuthnBinding });
