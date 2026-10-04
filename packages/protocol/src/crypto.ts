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

/** Endorsement of a new client by an already-trusted client. */
export const EndorsementBody = z.object({
  v: z.literal(1),
  uid: z.string().min(1),
  newDeviceId: DeviceId,
  pubSign: PubSign,
  pubBox: b64url(32),
  issuedAt: EpochMs,
});
export const Endorsement = signed("chalito.endorsement.v1", EndorsementBody);
export type Endorsement = z.infer<typeof Endorsement>;
