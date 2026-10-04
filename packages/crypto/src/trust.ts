import type { Endorsement, WebAuthnBinding } from "@chalito/protocol";
import { fromB64url } from "./encoding.js";
import type { NonceStore } from "./nonce.js";
import { verifyDetached, verifyEnvelope, type SignedEnvelope } from "./sign.js";
import type { WebAuthnCredentialRef } from "./webauthn.js";

export interface TrustedClient {
  deviceId: string;
  pubSign: string;
  pubBox: string;
  /** How the device learned to trust this key. Never "server". */
  via: "local_confirmation" | "endorsement";
  addedAt: number;
  /** For `via: "endorsement"`: the trusted client that signed it. */
  endorsedBy?: string;
  /**
   * The client's passkey, recorded on this device at the local reverse check (D-019). HIGH and
   * CRITICAL approvals from this client need an assertion verified against it.
   */
  webauthn?: WebAuthnCredentialRef;
}

export type BindingCheck =
  | { ok: true; credential: WebAuthnCredentialRef }
  | { ok: false; reason: "wrong_context" | "wrong_device" | "invalid_signature" | "expected_rp_mismatch" };

/**
 * Verifies a passkey binding against a device key the caller already trusts (the phone key
 * just confirmed at the reverse check, or an endorsed client's key): the binding must be
 * signed by that key, name that device and, if given, the expected relying party.
 */
export const verifyWebAuthnBinding = async (
  binding: WebAuthnBinding,
  expected: { deviceId: string; pubSign: string; rpId?: string },
): Promise<BindingCheck> => {
  if (binding.ctx !== "chalito.webauthn-binding.v1") return { ok: false, reason: "wrong_context" };
  if (binding.body.deviceId !== expected.deviceId || binding.signerDeviceId !== expected.deviceId)
    return { ok: false, reason: "wrong_device" };
  if (expected.rpId && binding.body.rpId !== expected.rpId) return { ok: false, reason: "expected_rp_mismatch" };
  const ok = await verifyDetached(binding.ctx, binding.body, binding.sig, await fromB64url(expected.pubSign));
  if (!ok) return { ok: false, reason: "invalid_signature" };
  const { credentialId, publicKey, rpId } = binding.body;
  return { ok: true, credential: { credentialId, publicKey, rpId } };
};

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
/** How old an endorsement an agent still accepts (a laptop off over a weekend, ADR 0018). */
export const ENDORSEMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class TrustedClientList {
  readonly #clients = new Map<string, TrustedClient>();
  readonly #keys = new Map<string, Uint8Array>();
  /** Clients removed on this device (ADR 0018): an endorsement never brings them back. */
  readonly #removed = new Set<string>();

  constructor(readonly selfDeviceId: string) {}

  static async fromJSON(
    selfDeviceId: string,
    clients: TrustedClient[],
    removed: readonly string[] = [],
  ): Promise<TrustedClientList> {
    const list = new TrustedClientList(selfDeviceId);
    for (const c of clients) await list.#put(c);
    for (const id of removed) list.#removed.add(id);
    return list;
  }

  toJSON(): TrustedClient[] {
    return [...this.#clients.values()];
  }

  /** Tombstones, persisted next to the list (same signature). */
  removedIds(): string[] {
    return [...this.#removed].sort();
  }

  isRemoved(deviceId: string): boolean {
    return this.#removed.has(deviceId);
  }

  has(deviceId: string): boolean {
    return this.#clients.has(deviceId);
  }

  /** Recipients for sealing new content: only keys this device trusts right now. */
  recipients(): Record<string, string> {
    return Object.fromEntries([...this.#clients.values()].map((c) => [c.deviceId, c.pubBox]));
  }

  /**
   * After the user confirmed the client's fingerprint (and, if shown, its passkey) on this
   * device. A local confirmation also lifts a tombstone: the person re-paired on purpose.
   */
  async addConfirmed(c: Omit<TrustedClient, "via" | "addedAt">, now: number): Promise<void> {
    this.#removed.delete(c.deviceId);
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

  /**
   * Records a client's passkey from its binding, verified against the key THIS list holds for
   * that client (never a key the cloud supplies). False if the client isn't trusted here or
   * the binding doesn't verify.
   */
  async attachWebAuthnBinding(
    binding: WebAuthnBinding,
    rpId?: string,
  ): Promise<BindingCheck | { ok: false; reason: "untrusted_client" }> {
    const c = this.#clients.get(binding.body.deviceId);
    if (!c) return { ok: false, reason: "untrusted_client" };
    const check = await verifyWebAuthnBinding(binding, {
      deviceId: c.deviceId,
      pubSign: c.pubSign,
      ...(rpId ? { rpId } : {}),
    });
    if (check.ok) this.#clients.set(c.deviceId, { ...c, webauthn: check.credential });
    return check;
  }

  /**
   * A new client vouched for by a client already in this list. Its passkey binding (signed by
   * the NEW client's key) may come along; a binding that doesn't verify against that key
   * rejects the whole endorsement.
   */
  async addEndorsed(
    e: Endorsement,
    now: number,
    maxAgeMs = ENDORSEMENT_MAX_AGE_MS,
    webauthnBinding?: WebAuthnBinding | null,
  ): Promise<boolean> {
    // Removed here: only a local re-pair brings it back. Already trusted: nothing to add.
    if (this.#removed.has(e.body.newDeviceId) || this.#clients.has(e.body.newDeviceId)) return false;
    // ADR 0018: when the endorser named its agents, only those accept the new client.
    if (e.body.agents && !e.body.agents.some((a) => a.deviceId === this.selfDeviceId)) return false;
    const res = await verifyEnvelope(e, "chalito.endorsement.v1", this.#keys);
    if (!res.ok || now - e.body.issuedAt > maxAgeMs || e.body.issuedAt > now + 60_000) return false;
    let webauthn: WebAuthnCredentialRef | undefined;
    if (webauthnBinding) {
      const check = await verifyWebAuthnBinding(webauthnBinding, {
        deviceId: e.body.newDeviceId,
        pubSign: e.body.pubSign,
      });
      if (!check.ok) return false;
      webauthn = check.credential;
    }
    await this.#put({
      deviceId: e.body.newDeviceId,
      pubSign: e.body.pubSign,
      pubBox: e.body.pubBox,
      via: "endorsement",
      addedAt: now,
      endorsedBy: e.signerDeviceId,
      ...(webauthn ? { webauthn } : {}),
    });
    return true;
  }

  /** Revocation takes effect immediately, whatever the server still delivers, and sticks. */
  remove(deviceId: string): boolean {
    this.#removed.add(deviceId);
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
