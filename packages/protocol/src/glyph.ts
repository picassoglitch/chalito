import { z } from "zod";
import { b64url, EpochMs, PubBox, PubSign, Signature } from "./common.js";

/** Pairing codes live 5 minutes and can be claimed once. */
export const PAIRING_TTL_MS = 5 * 60 * 1000;

/**
 * Short code: 8 Crockford base32 chars shown as "XXXX-XXXX" (40 bits). Rate-limited,
 * single-claim and TTL-bound server-side; equivalent to the glyph for accessibility.
 */
export const ShortCode = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);

export const GlyphPurpose = z.enum(["pair_device", "endorse_client", "room_invite"]);

/**
 * What a Chalito Glyph carries: the same information a QR code would. The glyph is a
 * transport, not a security boundary — security comes from key binding, TTL, single
 * claim and human fingerprint confirmation. Error correction and the frame checksum are
 * part of the glyph encoding (packages/glyph), not this schema.
 */
export const GlyphPayloadBody = z.object({
  v: z.literal(1),
  purpose: GlyphPurpose,
  /** Server-issued code id (pairing code / invite id). */
  codeId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  /** Issuer's signing key; the fingerprint shown to humans is derived from it. */
  issuerPubSign: PubSign,
  issuerPubBox: PubBox.optional(),
  /** Display label of the issuer (device name or room name), ≤ 40 chars. */
  label: z.string().max(40),
  issuedAt: EpochMs,
  expiresAt: EpochMs,
  nonce: b64url(16),
});

export const GlyphPayload = z
  .object({
    body: GlyphPayloadBody,
    /** Ed25519 by issuerPubSign over context "chalito.glyph.v1" (see crypto.ts). */
    sig: Signature,
  })
  .refine((g) => g.body.expiresAt > g.body.issuedAt && g.body.expiresAt - g.body.issuedAt <= PAIRING_TTL_MS * 288, {
    message: "glyph expiry out of range",
  })
  .refine((g) => g.body.purpose !== "pair_device" || g.body.expiresAt - g.body.issuedAt <= PAIRING_TTL_MS, {
    message: "pairing glyphs expire within 5 minutes",
  });
export type GlyphPayload = z.infer<typeof GlyphPayload>;

/** `pairingCodes/{code}` */
export const PairingCode = z.object({
  v: z.literal(1),
  codeId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  shortCodeHash: z.string().regex(/^[0-9a-f]{64}$/),
  deviceName: z.string().max(40),
  devicePubSign: PubSign,
  devicePubBox: PubBox,
  claimedBy: z.string().nullable(),
  expiresAt: EpochMs,
});
export type PairingCode = z.infer<typeof PairingCode>;
