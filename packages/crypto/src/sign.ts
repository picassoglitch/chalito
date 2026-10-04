import type { SigningContext } from "@chalito/protocol";
import { fromB64url, toB64url, utf8 } from "./encoding.js";
import { canonicalize } from "./jcs.js";
import { ready } from "./sodium.js";

/** Bytes covered by a signature: utf8(ctx) || 0x00 || utf8(JCS(body)). */
export const signingInput = (ctx: SigningContext, body: unknown): Uint8Array => {
  const head = utf8(ctx);
  const payload = utf8(canonicalize(body));
  const out = new Uint8Array(head.length + 1 + payload.length);
  out.set(head, 0);
  out[head.length] = 0;
  out.set(payload, head.length + 1);
  return out;
};

export const signDetached = async (ctx: SigningContext, body: unknown, secretKey: Uint8Array): Promise<string> => {
  const s = await ready();
  return toB64url(s.crypto_sign_detached(signingInput(ctx, body), secretKey));
};

export const verifyDetached = async (
  ctx: SigningContext,
  body: unknown,
  sig: string,
  publicKey: Uint8Array,
): Promise<boolean> => {
  const s = await ready();
  try {
    const sigBytes = await fromB64url(sig);
    if (sigBytes.length !== s.crypto_sign_BYTES || publicKey.length !== s.crypto_sign_PUBLICKEYBYTES) return false;
    return s.crypto_sign_verify_detached(sigBytes, signingInput(ctx, body), publicKey);
  } catch {
    return false;
  }
};

export interface SignedEnvelope<T> {
  ctx: SigningContext;
  body: T;
  signerDeviceId: string;
  sig: string;
}

/** Produces the shape of `signed()` in @chalito/protocol. */
export const signEnvelope = async <T>(
  ctx: SigningContext,
  body: T,
  signerDeviceId: string,
  secretKey: Uint8Array,
): Promise<SignedEnvelope<T>> => ({ ctx, body, signerDeviceId, sig: await signDetached(ctx, body, secretKey) });

export type VerifyResult =
  | { ok: true; signerDeviceId: string }
  | { ok: false; reason: "wrong_context" | "untrusted_signer" | "invalid_signature" };

/**
 * Verifies against a caller-supplied set of trusted keys. On the device agent this is
 * the LOCAL trusted-client list, never a key list fetched from the cloud.
 */
export const verifyEnvelope = async <T>(
  env: SignedEnvelope<T>,
  expectedCtx: SigningContext,
  trusted: ReadonlyMap<string, Uint8Array>,
): Promise<VerifyResult> => {
  if (env.ctx !== expectedCtx) return { ok: false, reason: "wrong_context" };
  const key = trusted.get(env.signerDeviceId);
  if (!key) return { ok: false, reason: "untrusted_signer" };
  const valid = await verifyDetached(env.ctx, env.body, env.sig, key);
  return valid ? { ok: true, signerDeviceId: env.signerDeviceId } : { ok: false, reason: "invalid_signature" };
};
