import type { GlyphPurpose } from "@chalito/protocol";
import { GlyphPayload } from "@chalito/protocol";

/**
 * Compact binary form of a GlyphPayload (≈200 bytes), so the animated ring needs few frames.
 *
 *   u8  version (1)
 *   u8  purpose (low 7 bits) | 0x80 if issuerPubBox present
 *   u8  codeId length, then ASCII
 *   32  issuerPubSign
 *   32  issuerPubBox (optional)
 *   u8  label byte length, then UTF-8
 *   u64 issuedAt, u64 expiresAt (big-endian ms)
 *   16  nonce
 *   64  signature
 */
type Purpose = (typeof GlyphPurpose.options)[number];
// Fixed wire order; never reorder (append new purposes at the end).
const PURPOSES = ["pair_device", "endorse_client", "room_invite"] as const satisfies readonly Purpose[];

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const b64Decode = (s: string): Uint8Array => {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error("glyph: bad base64url");
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
};
const b64Encode = (bytes: Uint8Array): string => {
  let out = "";
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += B64[(buf >> bits) & 63];
    }
  }
  if (bits > 0) out += B64[(buf << (6 - bits)) & 63];
  return out;
};

export const encodePayload = (payload: GlyphPayload): Uint8Array => {
  const { body, sig } = payload;
  const codeId = new TextEncoder().encode(body.codeId);
  const label = new TextEncoder().encode(body.label);
  if (label.length > 255) throw new Error("glyph: label too long");
  const box = body.issuerPubBox ? b64Decode(body.issuerPubBox) : null;
  const parts: number[] = [
    1,
    PURPOSES.indexOf(body.purpose as (typeof PURPOSES)[number]) | (box ? 0x80 : 0),
    codeId.length,
    ...codeId,
  ];
  parts.push(...b64Decode(body.issuerPubSign));
  if (box) parts.push(...box);
  parts.push(label.length, ...label);
  const times = new DataView(new ArrayBuffer(16));
  times.setBigUint64(0, BigInt(body.issuedAt));
  times.setBigUint64(8, BigInt(body.expiresAt));
  parts.push(...new Uint8Array(times.buffer), ...b64Decode(body.nonce), ...b64Decode(sig));
  return Uint8Array.from(parts);
};

export const decodePayload = (bytes: Uint8Array): GlyphPayload => {
  let i = 0;
  const take = (n: number) => {
    if (i + n > bytes.length) throw new Error("glyph: truncated");
    const out = bytes.slice(i, i + n);
    i += n;
    return out;
  };
  const [version] = take(1);
  if (version !== 1) throw new Error("glyph: unknown version");
  const [flags] = take(1);
  const purpose = PURPOSES[flags! & 0x7f];
  if (!purpose) throw new Error("glyph: unknown purpose");
  const codeId = new TextDecoder().decode(take(take(1)[0]!));
  const issuerPubSign = b64Encode(take(32));
  const issuerPubBox = flags! & 0x80 ? b64Encode(take(32)) : undefined;
  const label = new TextDecoder("utf-8", { fatal: true }).decode(take(take(1)[0]!));
  const times = new DataView(take(16).buffer);
  const issuedAt = Number(times.getBigUint64(0));
  const expiresAt = Number(times.getBigUint64(8));
  const nonce = b64Encode(take(16));
  const sig = b64Encode(take(64));
  if (i !== bytes.length) throw new Error("glyph: trailing bytes");
  return GlyphPayload.parse({
    body: {
      v: 1,
      purpose,
      codeId,
      issuerPubSign,
      ...(issuerPubBox ? { issuerPubBox } : {}),
      label,
      issuedAt,
      expiresAt,
      nonce,
    },
    sig,
  });
};
