import type { Endorsement } from "@chalito/protocol";
import { fromB64url } from "./encoding.js";
import type { NonceStore } from "./nonce.js";
import { verifyEnvelope, type SignedEnvelope } from "./sign.js";
import type { WebAuthnCredentialRef } from "./webauthn.js";

export interface TrustedClient {
  deviceId: string;
  pubSign: string;
  pubBox: string;
  /** How the device learned to trust this key. Never "server". */
  via: "local_confirmation" | "endorsement";
  addedAt: number;
  /**
   * The client's passkey, recorded on this device at the local reverse check (D-019). HIGH and
   * CRITICAL approvals from this client need an assertion verified against it.
   */
  webauthn?: WebAuthnCredentialRef;
}

export type DecisionCheck =
  | { ok: true; signerDeviceId: string }
  | {
      ok: false;
      reason:
        | "wrong_context"
        | "untrusted_signer"
        | "invalid_signature"
        | "wrong_device"
        | "wrong_request"
        | "expired_decision"
        | "replayed_nonce";
    };

interface DecisionLike {
  aid: string;
  requestId: string;
  targetDeviceId: string;
  nonce: string;
  expiresAt: number;
}

/**
 * The device agent's LOCAL list of trusted client keys (ADR 0006). It is the only
 * authority for approvals: keys appear here through local confirmation on the desktop
 * (reverse check) or an endorsement signed by a key already here. Nothing the cloud
 * says can add a key. The agent persists `toJSON()` under ~/.chalito, signed (M3).
 */
export class TrustedClientList {
  readonly #clients = new Map<string, TrustedClient>();
  readonly #keys = new Map<string, Uint8Array>();

  constructor(readonly selfDeviceId: string) {}

  static async fromJSON(selfDeviceId: string, clients: TrustedClient[]): Promise<TrustedClientList> {
    const list = new TrustedClientList(selfDeviceId);
    for (const c of clients) await list.#put(c);
    return list;
  }

  toJSON(): TrustedClient[] {
    return [...this.#clients.values()];
  }

  has(deviceId: string): boolean {
    return this.#clients.has(deviceId);
  }

  /** Recipients for sealing new content: only keys this device trusts right now. */
  recipients(): Record<string, string> {
    return Object.fromEntries([...this.#clients.values()].map((c) => [c.deviceId, c.pubBox]));
  }

  /** After the user confirmed the client's fingerprint (and, if shown, its passkey) on this device. */
  async addConfirmed(c: Omit<TrustedClient, "via" | "addedAt">, now: number): Promise<void> {
    await this.#put({ ...c, via: "local_confirmation", addedAt: now });
  }

  /** The passkey recorded for a trusted client, if any. */
  webauthnFor(deviceId: string): WebAuthnCredentialRef | undefined {
    return this.#clients.get(deviceId)?.webauthn;
  }

  /**
   * Records (or replaces) a trusted client's passkey. Call it only after a local confirmation on
   * this device, never because the cloud said so. False if the client isn't trusted here.
   */
  setWebAuthn(deviceId: string, credential: WebAuthnCredentialRef): boolean {
    const c = this.#clients.get(deviceId);
    if (!c) return false;
    this.#clients.set(deviceId, { ...c, webauthn: credential });
    return true;
  }

  /** A new client vouched for by a client already in this list. */
  async addEndorsed(e: Endorsement, now: number, maxAgeMs = 24 * 60 * 60 * 1000): Promise<boolean> {
    const res = await verifyEnvelope(e, "chalito.endorsement.v1", this.#keys);
    if (!res.ok || now - e.body.issuedAt > maxAgeMs || e.body.issuedAt > now + 60_000) return false;
    await this.#put({
      deviceId: e.body.newDeviceId,
      pubSign: e.body.pubSign,
      pubBox: e.body.pubBox,
      via: "endorsement",
      addedAt: now,
    });
    return true;
  }

  /** Revocation takes effect immediately, whatever the server still delivers. */
  remove(deviceId: string): boolean {
    this.#keys.delete(deviceId);
    return this.#clients.delete(deviceId);
  }

  /** Signature check of any signed envelope against this list only. */
  async verifySigned<T>(env: SignedEnvelope<T>, ctx: Parameters<typeof verifyEnvelope>[1]) {
    return verifyEnvelope(env, ctx, this.#keys);
  }

  /** Full Decision check: signature by a locally trusted key, binding, expiry, single use. */
  async verifyDecision(
    env: SignedEnvelope<DecisionLike>,
    expected: { aid: string; requestId: string },
    now: number,
    nonces: NonceStore,
  ): Promise<DecisionCheck> {
    const sig = await verifyEnvelope(env, "chalito.decision.v1", this.#keys);
    if (!sig.ok) return sig;
    const b = env.body;
    if (b.targetDeviceId !== this.selfDeviceId) return { ok: false, reason: "wrong_device" };
    if (b.aid !== expected.aid || b.requestId !== expected.requestId) return { ok: false, reason: "wrong_request" };
    if (b.expiresAt <= now) return { ok: false, reason: "expired_decision" };
    if (!(await nonces.claim(b.nonce, b.expiresAt, now))) return { ok: false, reason: "replayed_nonce" };
    return sig;
  }

  async #put(c: TrustedClient): Promise<void> {
    this.#clients.set(c.deviceId, c);
    this.#keys.set(c.deviceId, await fromB64url(c.pubSign));
  }
}
