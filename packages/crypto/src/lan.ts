import { crockford32 } from "./fingerprint.js";
import { utf8 } from "./encoding.js";
import type { BoxKeyPair } from "./keys.js";
import { ready } from "./sodium.js";

/**
 * LAN direct path primitives (ADR 0022 §5). A handshake between two agents of the same owner:
 *
 *   dialer → listener   tid, eD, nD                      (clear)
 *   listener → dialer   eL, nL, seal_L2D(identity_L)     (identity sealed)
 *   dialer → listener   seal_D2L(identity_D)
 *
 * th = BLAKE2b-256(label || tid || eD || nD || eL || nL). Session keys are BLAKE2b-512 keyed with
 * the cloud-issued LAN token secret over X25519(eD, eL) || th, split per direction. Each identity
 * carries an Ed25519 signature (`chalito.lan-handshake.v1`) over th by the device's own key, so a
 * side must hold BOTH the owner's current token and a device key of the owner's directory.
 * Ephemeral keys give forward secrecy for the link; the token alone can't impersonate a device.
 */

const TRANSCRIPT_LABEL = "chalito.lan.transcript.v1";
const KEYS_LABEL = "chalito.lan.keys.v1";
const FRAME_AD = utf8("chalito.lan.frame.v1");
const ADVERT_LABEL = "chalito.lan.advert.v1";

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const ZERO = new Uint8Array([0]);

/** A fresh X25519 key pair for one handshake (never the device's long-term box key). */
export const lanEphemeral = async (): Promise<BoxKeyPair> => {
  const s = await ready();
  const { publicKey, privateKey } = s.crypto_box_keypair();
  return { publicKey, secretKey: privateKey };
};

export interface LanTranscriptInput {
  tid: Uint8Array;
  dialerEph: Uint8Array;
  dialerNonce: Uint8Array;
  listenerEph: Uint8Array;
  listenerNonce: Uint8Array;
}

/** The handshake transcript hash both sides sign and mix into the keys. */
export const lanTranscript = async (t: LanTranscriptInput): Promise<Uint8Array> => {
  const s = await ready();
  if (t.tid.length !== 16 || t.dialerNonce.length !== 32 || t.listenerNonce.length !== 32)
    throw new Error("lan: bad transcript input");
  if (t.dialerEph.length !== 32 || t.listenerEph.length !== 32) throw new Error("lan: bad ephemeral key");
  return s.crypto_generichash(
    32,
    concat(utf8(TRANSCRIPT_LABEL), ZERO, t.tid, t.dialerEph, t.dialerNonce, t.listenerEph, t.listenerNonce),
    null,
  );
};

export interface LanSessionKeys {
  send: Uint8Array;
  recv: Uint8Array;
}

/**
 * Per-direction session keys. Throws on a low-order peer key (an all-zero shared secret), so a
 * peer can't force a known key.
 */
export const lanSessionKeys = async (
  role: "dialer" | "listener",
  eph: BoxKeyPair,
  peerEph: Uint8Array,
  tokenSecret: Uint8Array,
  th: Uint8Array,
): Promise<LanSessionKeys> => {
  const s = await ready();
  if (tokenSecret.length !== 32) throw new Error("lan: bad token secret");
  if (peerEph.length !== 32) throw new Error("lan: bad ephemeral key");
  let dh: Uint8Array;
  try {
    dh = s.crypto_scalarmult(eph.secretKey, peerEph); // libsodium refuses an all-zero result
  } catch {
    throw new Error("lan: low-order key");
  }
  if (dh.every((b) => b === 0)) throw new Error("lan: low-order key");
  const okm = s.crypto_generichash(64, concat(utf8(KEYS_LABEL), ZERO, dh, th), tokenSecret);
  s.memzero(dh);
  const d2l = okm.slice(0, 32);
  const l2d = okm.slice(32, 64);
  return role === "dialer" ? { send: d2l, recv: l2d } : { send: l2d, recv: d2l };
};

const seqNonce = (seq: bigint): Uint8Array => {
  const n = new Uint8Array(24);
  new DataView(n.buffer).setBigUint64(16, seq, false);
  return n;
};

/**
 * XChaCha20-Poly1305 per direction with a counter nonce. `open` accepts only the next sequence
 * number, so a replayed, dropped or reordered frame fails (and the caller ends the link).
 */
export class LanCipher {
  #sendSeq = 0n;
  #recvSeq = 0n;
  constructor(
    private readonly keys: LanSessionKeys,
    start: { send?: bigint; recv?: bigint } = {},
  ) {
    this.#sendSeq = start.send ?? 0n;
    this.#recvSeq = start.recv ?? 0n;
  }

  async seal(plain: Uint8Array): Promise<Uint8Array> {
    const s = await ready();
    const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plain,
      FRAME_AD,
      null,
      seqNonce(this.#sendSeq),
      this.keys.send,
    );
    this.#sendSeq += 1n;
    return ct;
  }

  /** Throws on any failure; the sequence moves only on success. */
  async open(ct: Uint8Array): Promise<Uint8Array> {
    const s = await ready();
    const plain = s.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ct,
      FRAME_AD,
      seqNonce(this.#recvSeq),
      this.keys.recv,
    );
    this.#recvSeq += 1n;
    return plain;
  }
}

/**
 * The mDNS instance name an agent advertises: 16 Crockford base32 characters (lowercase) of a
 * BLAKE2b MAC keyed with the owner's LAN token secret over the device id and a time window. It
 * changes with every window and every token; without the token it can't be linked to a device,
 * an owner, or an earlier name.
 */
export const lanAdvertId = async (tokenSecret: Uint8Array, deviceId: string, window: number): Promise<string> => {
  const s = await ready();
  const mac = s.crypto_generichash(
    10,
    concat(utf8(ADVERT_LABEL), ZERO, utf8(deviceId), ZERO, utf8(String(window))),
    tokenSecret,
  );
  return crockford32(mac).toLowerCase();
};
