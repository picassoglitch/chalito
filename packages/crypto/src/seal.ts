import type { SealedEnvelope } from "@chalito/protocol";
import { fromB64url, fromUtf8, toB64url, utf8 } from "./encoding.js";
import type { BoxKeyPair } from "./keys.js";
import { ready } from "./sodium.js";

/**
 * Multi-recipient seal (`xchacha20poly1305+sealedbox`): encrypt once with a random
 * content key, then wrap that key to each recipient's X25519 key with crypto_box_seal.
 * `aad` binds the ciphertext to its context (e.g. "approval:<aid>") so it can't be
 * moved to another document.
 */
export const seal = async (
  plaintext: Uint8Array,
  recipients: Readonly<Record<string, Uint8Array>>,
  aad = "",
): Promise<SealedEnvelope> => {
  const s = await ready();
  const ids = Object.keys(recipients);
  if (ids.length === 0) throw new Error("seal: at least one recipient");
  const key = s.crypto_aead_xchacha20poly1305_ietf_keygen();
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, utf8(aad), null, nonce, key);
  const keys: Record<string, string> = {};
  for (const id of ids) keys[id] = await toB64url(s.crypto_box_seal(key, recipients[id]!));
  s.memzero(key);
  return { alg: "xchacha20poly1305+sealedbox", nonce: await toB64url(nonce), ct: await toB64url(ct), keys };
};

export const open = async (
  env: SealedEnvelope,
  deviceId: string,
  keyPair: BoxKeyPair,
  aad = "",
): Promise<Uint8Array> => {
  const s = await ready();
  const wrapped = env.keys[deviceId];
  if (!wrapped) throw new Error("open: not a recipient");
  const key = s.crypto_box_seal_open(await fromB64url(wrapped), keyPair.publicKey, keyPair.secretKey);
  try {
    return s.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      await fromB64url(env.ct),
      utf8(aad),
      await fromB64url(env.nonce),
      key,
    );
  } finally {
    s.memzero(key);
  }
};

export const sealJson = async (value: unknown, recipients: Readonly<Record<string, Uint8Array>>, aad = "") =>
  seal(utf8(JSON.stringify(value)), recipients, aad);

export const openJson = async <T = unknown>(env: SealedEnvelope, deviceId: string, keyPair: BoxKeyPair, aad = "") =>
  JSON.parse(fromUtf8(await open(env, deviceId, keyPair, aad))) as T;
