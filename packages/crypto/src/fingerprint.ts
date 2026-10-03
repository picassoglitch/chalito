import { ready } from "./sodium.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Crockford base32 without padding (5 bits per character). */
export const crockford32 = (bytes: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
};

/**
 * Human-comparable fingerprint of an Ed25519 public key: the first 10 bytes of
 * BLAKE2b-256(pubSign) as 16 Crockford base32 characters in 4 groups
 * ("7K2Q-M9XD-4TPA-W3HC"). Matches `Fingerprint` in @chalito/protocol.
 */
export const fingerprint = async (pubSign: Uint8Array): Promise<string> => {
  const s = await ready();
  const digest = s.crypto_generichash(32, pubSign, null);
  const chars = crockford32(digest.slice(0, 10));
  return chars.match(/.{4}/g)!.join("-");
};
