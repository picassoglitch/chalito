import { fromB64url, toB64url, utf8 } from "./encoding.js";
import { canonicalize } from "./jcs.js";
import { ready } from "./sodium.js";

/**
 * WebAuthn step-up verification on the device (D-019). The agent checks a passkey assertion
 * itself, against the credential public key it recorded locally for the signing client, so a
 * HIGH/CRITICAL approval proves user verification to the device, not just to the cloud.
 *
 * Supported credential keys: ES256 (COSE alg -7, P-256) and EdDSA (COSE alg -8, Ed25519).
 * Runs anywhere WebCrypto and libsodium do (browsers, Node ≥ 22, Bun).
 */

/** What an agent records about a client's passkey at the local reverse check. */
export interface WebAuthnCredentialRef {
  /** base64url credential id. */
  credentialId: string;
  /** base64url COSE_Key bytes, as returned by registration (`credential.publicKey`). */
  publicKey: string;
  /** The relying party id the passkey is scoped to (e.g. "chalito.chalyb.com"). */
  rpId: string;
}

export interface WebAuthnAssertionInput {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

export type AssertionCheck =
  | { ok: true; signCount: number; userVerified: boolean }
  | {
      ok: false;
      reason:
        | "malformed"
        | "wrong_credential"
        | "wrong_type"
        | "wrong_challenge"
        | "wrong_origin"
        | "wrong_rp"
        | "user_not_present"
        | "user_not_verified"
        | "unsupported_key"
        | "bad_signature";
    };

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto (crypto.subtle) is required");
  return s;
};

export const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await subtle().digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));

/**
 * The step-up challenge for a decision: SHA-256(JCS(decision body without `stepUp`)). The
 * assertion is thereby bound to exactly this aid, requestId, target device, nonce and verdict.
 */
export const stepUpChallenge = async (decisionBody: Record<string, unknown>): Promise<Uint8Array> => {
  const { stepUp: _omit, ...rest } = decisionBody;
  return sha256(utf8(canonicalize(rest)));
};

const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---------------------------------------------------------------- COSE_Key (minimal CBOR)
type Cbor = number | Uint8Array | string | Map<number | string, Cbor> | Cbor[];

const readCbor = (buf: Uint8Array, pos: { i: number }): Cbor => {
  const ib = buf[pos.i++];
  if (ib === undefined) throw new Error("cbor: truncated");
  const major = ib >> 5;
  let info = ib & 31;
  let len: number;
  if (info < 24) len = info;
  else if (info === 24) len = buf[pos.i++]!;
  else if (info === 25) {
    len = (buf[pos.i]! << 8) | buf[pos.i + 1]!;
    pos.i += 2;
  } else if (info === 26) {
    len = ((buf[pos.i]! << 24) >>> 0) + (buf[pos.i + 1]! << 16) + (buf[pos.i + 2]! << 8) + buf[pos.i + 3]!;
    pos.i += 4;
  } else throw new Error("cbor: unsupported length");
  info = len;
  switch (major) {
    case 0:
      return info;
    case 1:
      return -1 - info;
    case 2: {
      if (pos.i + info > buf.length) throw new Error("cbor: truncated");
      const out = buf.slice(pos.i, pos.i + info);
      pos.i += info;
      return out;
    }
    case 3: {
      const out = new TextDecoder().decode(buf.slice(pos.i, pos.i + info));
      pos.i += info;
      return out;
    }
    case 4:
      return Array.from({ length: info }, () => readCbor(buf, pos));
    case 5: {
      const m = new Map<number | string, Cbor>();
      for (let n = 0; n < info; n++) {
        const k = readCbor(buf, pos);
        if (typeof k !== "number" && typeof k !== "string") throw new Error("cbor: bad map key");
        m.set(k, readCbor(buf, pos));
      }
      return m;
    }
    default:
      throw new Error("cbor: unsupported type");
  }
};

type CoseKey = { alg: -7; x: Uint8Array; y: Uint8Array } | { alg: -8; x: Uint8Array };

/** Parses an ES256 (EC2/P-256) or EdDSA (OKP/Ed25519) COSE_Key; null for anything else. */
export const parseCoseKey = (bytes: Uint8Array): CoseKey | null => {
  try {
    const m = readCbor(bytes, { i: 0 });
    if (!(m instanceof Map)) return null;
    const kty = m.get(1);
    const alg = m.get(3);
    const crv = m.get(-1);
    const x = m.get(-2);
    if (kty === 2 && alg === -7 && crv === 1) {
      const y = m.get(-3);
      if (x instanceof Uint8Array && y instanceof Uint8Array && x.length === 32 && y.length === 32)
        return { alg: -7, x, y };
    }
    if (kty === 1 && alg === -8 && crv === 6 && x instanceof Uint8Array && x.length === 32) return { alg: -8, x };
    return null;
  } catch {
    return null;
  }
};

/** ASN.1 DER ECDSA signature → the 64-byte r‖s form WebCrypto verifies. */
const derToRaw = (der: Uint8Array): Uint8Array | null => {
  if (der[0] !== 0x30) return null;
  let i = 2;
  if (der[1]! & 0x80) i = 2 + (der[1]! & 0x7f);
  const part = (): Uint8Array | null => {
    if (der[i] !== 0x02) return null;
    const len = der[i + 1]!;
    let v = der.slice(i + 2, i + 2 + len);
    i += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) return null;
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = part();
  const s = part();
  if (!r || !s) return null;
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
};

const verifyWithCose = async (key: CoseKey, data: Uint8Array, sig: Uint8Array): Promise<boolean> => {
  if (key.alg === -8) {
    const s = await ready();
    return sig.length === 64 && s.crypto_sign_verify_detached(sig, data, key.x);
  }
  const raw = derToRaw(sig);
  if (!raw) return false;
  const point = new Uint8Array(65);
  point[0] = 4;
  point.set(key.x, 1);
  point.set(key.y, 33);
  const k = await subtle().importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return subtle().verify(
    { name: "ECDSA", hash: "SHA-256" },
    k,
    raw as Uint8Array<ArrayBuffer>,
    data as Uint8Array<ArrayBuffer>,
  );
};

/**
 * Verifies a WebAuthn assertion (navigator.credentials.get) against a recorded credential:
 * type `webauthn.get`, exact challenge, allowed origin, rpId hash, user presence and (by
 * default) user verification, then the signature over authenticatorData ‖ SHA-256(clientDataJSON).
 */
export const verifyWebAuthnAssertion = async (args: {
  assertion: WebAuthnAssertionInput;
  credential: Pick<WebAuthnCredentialRef, "credentialId" | "publicKey">;
  expectedChallenge: Uint8Array;
  rpId: string;
  origin: string | string[];
  requireUserVerification?: boolean;
}): Promise<AssertionCheck> => {
  const { assertion, credential, expectedChallenge, rpId } = args;
  const origins = Array.isArray(args.origin) ? args.origin : [args.origin];
  if (assertion.credentialId !== credential.credentialId) return { ok: false, reason: "wrong_credential" };
  let authData: Uint8Array;
  let clientDataRaw: Uint8Array;
  let sig: Uint8Array;
  let cose: Uint8Array;
  let clientData: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    authData = await fromB64url(assertion.authenticatorData);
    clientDataRaw = await fromB64url(assertion.clientDataJSON);
    sig = await fromB64url(assertion.signature);
    cose = await fromB64url(credential.publicKey);
    clientData = JSON.parse(new TextDecoder().decode(clientDataRaw)) as typeof clientData;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (authData.length < 37) return { ok: false, reason: "malformed" };
  if (clientData.type !== "webauthn.get") return { ok: false, reason: "wrong_type" };
  if (typeof clientData.challenge !== "string" || clientData.challenge !== (await toB64url(expectedChallenge)))
    return { ok: false, reason: "wrong_challenge" };
  if (typeof clientData.origin !== "string" || !origins.includes(clientData.origin))
    return { ok: false, reason: "wrong_origin" };
  if (!equalBytes(authData.slice(0, 32), await sha256(utf8(rpId)))) return { ok: false, reason: "wrong_rp" };
  const flags = authData[32]!;
  if (!(flags & 0x01)) return { ok: false, reason: "user_not_present" };
  const userVerified = (flags & 0x04) !== 0;
  if ((args.requireUserVerification ?? true) && !userVerified) return { ok: false, reason: "user_not_verified" };
  const key = parseCoseKey(cose);
  if (!key) return { ok: false, reason: "unsupported_key" };
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData, 0);
  signed.set(await sha256(clientDataRaw), authData.length);
  if (!(await verifyWithCose(key, signed, sig))) return { ok: false, reason: "bad_signature" };
  const signCount = ((authData[33]! << 24) >>> 0) + (authData[34]! << 16) + (authData[35]! << 8) + authData[36]!;
  return { ok: true, signCount, userVerified };
};
