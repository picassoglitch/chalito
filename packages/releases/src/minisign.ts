import { ready } from "@chalito/crypto";

/**
 * Verifies Tauri updater signatures (minisign, as `tauri signer` writes them) without the
 * updater: the release workflow checks every `.sig` against the public key before a draft is
 * made, and tests use a throwaway key. Tauri stores both the public key and each `.sig` as
 * base64 of the minisign text file.
 *
 *   public key:  "Ed" | key id (8) | Ed25519 public key (32)
 *   signature:   "ED" (BLAKE2b-512 prehashed, what Tauri writes) or "Ed" (legacy, raw message)
 *                | key id (8) | signature (64),
 *                then a global signature over signature || trusted comment.
 */

export type MinisignCheck =
  | { ok: true; keyId: string; trustedComment: string }
  | {
      ok: false;
      reason: "malformed_key" | "malformed_signature" | "key_mismatch" | "bad_signature" | "bad_comment_signature";
    };

const b64 = (s: string): Uint8Array | null => {
  try {
    return Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};
const text = (s: string) => {
  const raw = b64(s);
  // Accept either the base64 wrapper (Tauri) or the minisign text itself.
  return raw && new TextDecoder().decode(raw).startsWith("untrusted comment:") ? new TextDecoder().decode(raw) : s;
};
const lines = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export const parsePublicKey = (key: string): { keyId: Uint8Array; pk: Uint8Array } | null => {
  const ls = lines(text(key));
  const body = b64(ls.find((l) => !l.startsWith("untrusted comment:")) ?? "");
  if (!body || body.length !== 42 || body[0] !== 0x45 || body[1] !== 0x64) return null; // "Ed"
  return { keyId: body.slice(2, 10), pk: body.slice(10) };
};

export const verifyMinisign = async (
  publicKey: string,
  signature: string,
  file: Uint8Array,
): Promise<MinisignCheck> => {
  const key = parsePublicKey(publicKey);
  if (!key) return { ok: false, reason: "malformed_key" };
  const ls = lines(text(signature));
  const sigLine = ls.findIndex((l) => !l.startsWith("untrusted comment:"));
  const sig = b64(ls[sigLine] ?? "");
  const tc = ls[sigLine + 1];
  const global = b64(ls[sigLine + 2] ?? "");
  if (!sig || sig.length !== 74 || !tc?.startsWith("trusted comment: ") || !global || global.length !== 64)
    return { ok: false, reason: "malformed_signature" };
  const alg = String.fromCharCode(sig[0]!, sig[1]!);
  if (alg !== "Ed" && alg !== "ED") return { ok: false, reason: "malformed_signature" };
  if (!eq(sig.slice(2, 10), key.keyId)) return { ok: false, reason: "key_mismatch" };
  const sodium = await ready();
  // Copy into this realm's Uint8Array (libsodium rejects typed arrays from another realm, e.g. jsdom's).
  const bytes = Uint8Array.from(file);
  const message = alg === "ED" ? sodium.crypto_generichash(64, bytes, null) : bytes;
  if (!sodium.crypto_sign_verify_detached(sig.slice(10), message, key.pk))
    return { ok: false, reason: "bad_signature" };
  const comment = tc.slice("trusted comment: ".length);
  const signed = new Uint8Array([...sig.slice(10), ...new TextEncoder().encode(comment)]);
  if (!sodium.crypto_sign_verify_detached(global, signed, key.pk))
    return { ok: false, reason: "bad_comment_signature" };
  return { ok: true, keyId: hex(key.keyId), trustedComment: comment };
};
