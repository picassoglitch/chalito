import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { signingInput, type SigningKeyPair } from "@chalito/crypto";
import type { SigningContext } from "@chalito/protocol";

/**
 * Synchronous Ed25519 over the same signing input as @chalito/crypto (ctx || 0x00 ||
 * JCS(body)), for the agent's own local files: Developer-mode state, the liability log
 * and the policy lock. Synchronous because policy and Developer-mode checks run inside
 * the tool gate's synchronous reads. Signatures interoperate with signDetached/verifyDetached.
 */
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

export const signLocal = (ctx: SigningContext, body: unknown, keys: SigningKeyPair): string => {
  const key = createPrivateKey({
    // libsodium secret keys are seed (32) || public key (32).
    key: { kty: "OKP", crv: "Ed25519", d: b64u(keys.secretKey.subarray(0, 32)), x: b64u(keys.publicKey) },
    format: "jwk",
  });
  return sign(null, signingInput(ctx, body), key).toString("base64url");
};

export const verifyLocal = (ctx: SigningContext, body: unknown, sig: unknown, publicKey: Uint8Array): boolean => {
  if (typeof sig !== "string" || publicKey.length !== 32) return false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64u(publicKey) }, format: "jwk" });
    const bytes = Buffer.from(sig, "base64url");
    return bytes.length === 64 && verify(null, signingInput(ctx, body), key, bytes);
  } catch {
    return false;
  }
};
