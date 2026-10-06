import { z } from "zod";
import { b64url, DeviceId, EpochMs, PubSign, Signature } from "./common.js";

/**
 * Envelope shapes. The algorithms are implemented in packages/crypto (libsodium);
 * this file only fixes the wire format.
 *
 * Multi-recipient seal (`sealed.v1`): content is encrypted once with a random
 * 32-byte content key using XChaCha20-Poly1305 (24-byte nonce); the content key is
 * wrapped to each recipient device's X25519 key with `crypto_box_seal`.
 */
export const SealedEnvelope = z.object({
  alg: z.literal("xchacha20poly1305+sealedbox"),
  nonce: b64url(24),
  ct: b64url(),
  /** deviceId → sealed content key (32-byte key + 48 bytes sealed-box overhead = 80 bytes). */
  keys: z.record(DeviceId, b64url(80)).refine((k) => Object.keys(k).length > 0, "at least one recipient"),
});
export type SealedEnvelope = z.infer<typeof SealedEnvelope>;

/** Room content sealed with the room's symmetric key for a given epoch. */
export const RoomSealed = z.object({
  alg: z.literal("xchacha20poly1305"),
  epoch: z.number().int().positive(),
  nonce: b64url(24),
  ct: b64url(),
});
export type RoomSealed = z.infer<typeof RoomSealed>;

/**
 * Domain-separation contexts. A signature is Ed25519 over
 *   utf8(context) || 0x00 || utf8(JCS(body))
 * where JCS is RFC 8785 JSON canonicalization. A signature made for one context
 * can never be replayed as another.
 */
export const SigningContext = z.enum([
  "chalito.decision.v1",
  /** ADR 0019: the agent's approval request (risk, step-up, detailsHash), inside the sealed details. */
  "chalito.approval.v1",
  "chalito.command.v1",
  "chalito.endorsement.v1",
  "chalito.glyph.v1",
  "chalito.devmode-off.v1",
  "chalito.policy-tighten.v1",
  "chalito.refresh-challenge.v1",
  "chalito.room-key-wrap.v1",
  "chalito.device-register.v1",
  "chalito.pairing-claim.v1",
  "chalito.trusted-list.v1",
  "chalito.devmode-state.v1",
  "chalito.devmode-liability.v1",
  "chalito.policy-lock.v1",
  "chalito.agent-config.v1",
  "chalito.webauthn-binding.v1",
  /** The curated recipe catalog (packages/protocol/src/recipe.ts), signed by Chalito's catalog key. */
  "chalito.recipe-catalog.v1",
  /** Remote screen (screen.ts): the agent's WebRTC offer / ICE, inside the sealed screen.signal event. */
  "chalito.screen-signal.v1",
]);
export type SigningContext = z.infer<typeof SigningContext>;

/** Generic detached-signature wrapper. */
export const signed = <T extends z.ZodTypeAny>(ctx: SigningContext, body: T) =>
  z.object({
    ctx: z.literal(ctx),
    body,
    signerDeviceId: DeviceId,
    sig: Signature,
  });

/** An agent the endorser trusts locally, introduced to the new client (ADR 0018). */
export const IntroducedAgent = z.object({
  deviceId: DeviceId,
  pubSign: PubSign,
  pubBox: b64url(32),
  fingerprint: z.string().min(1).max(64),
});
export type IntroducedAgent = z.infer<typeof IntroducedAgent>;

/**
 * The endorser's presence over the endorsement (ADR 0018): a WebAuthn assertion by the
 * ENDORSER's passkey whose challenge is SHA-256(JCS(endorsement body without stepUp)), the same
 * construction as a decision's step-up (D-019). WebAuthn only: a self-asserted method would
 * prove nothing to the agents.
 */
export const EndorsementStepUp = z.object({
  method: z.literal("webauthn"),
  at: EpochMs,
  assertion: z.object({
    credentialId: b64url(),
    authenticatorData: b64url(),
    clientDataJSON: b64url(),
    signature: b64url(),
  }),
});

/** Endorsement of a new client by an already-trusted client. */
export const EndorsementBody = z.object({
  v: z.literal(1),
  uid: z.string().min(1),
  newDeviceId: DeviceId,
  pubSign: PubSign,
  pubBox: b64url(32),
  issuedAt: EpochMs,
  /**
   * ADR 0018 (optional, signed with the rest): the endorser's trusted agents. The new client
   * may trust them (after checking each against the devices directory); an agent accepts the
   * endorsed client only if it is listed here. Absent in older endorsements.
   */
  agents: z.array(IntroducedAgent).max(32).optional(),
  /**
   * Required by agents (and the api) when the endorser has a passkey: without it a stolen,
   * unlocked client could endorse a device carrying the thief's own passkey.
   */
  stepUp: EndorsementStepUp.optional(),
});
export const Endorsement = signed("chalito.endorsement.v1", EndorsementBody);
export type Endorsement = z.infer<typeof Endorsement>;

/**
 * Ties a client's passkey to its device key: signed by the client's DEVICE key (never the
 * server), so an agent can record the passkey it will require for HIGH/CRITICAL step-ups
 * from the same trust root it confirmed at the reverse check (D-019).
 */
export const WebAuthnBindingBody = z.object({
  v: z.literal(1),
  deviceId: DeviceId,
  /** base64url credential id. */
  credentialId: b64url(),
  /** base64url COSE_Key, as registration returned it. */
  publicKey: b64url(),
  rpId: z.string().min(1).max(253),
  issuedAt: EpochMs,
});
export const WebAuthnBinding = signed("chalito.webauthn-binding.v1", WebAuthnBindingBody);
export type WebAuthnBinding = z.infer<typeof WebAuthnBinding>;
