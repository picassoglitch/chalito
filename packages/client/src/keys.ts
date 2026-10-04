import type { SealedEnvelope, SigningContext } from "@chalito/protocol";

/** What `keys.sign` returns: the `signed(...)` envelope shape from @chalito/protocol. */
export interface SignedEnvelope<T> {
  ctx: SigningContext;
  body: T;
  signerDeviceId: string;
  sig: string;
}

/**
 * This browser device's key material, provided by packages/client-keys (m5-keys). Private
 * keys never leave that package: the data layer only asks it to sign, open and seal.
 */
export interface ClientKeys {
  /** This client's device id (derived from its signing key). */
  readonly deviceId: string;
  /** This client's own X25519 public key (b64url), so it can read what it seals. */
  readonly pubBox: string;
  /** Ed25519 over the protocol's signing input for `ctx`, as `signEnvelope` does. */
  sign<T>(ctx: SigningContext, body: T): Promise<SignedEnvelope<T>>;
  /** Opens content sealed to this device; `aad` binds it to its context (e.g. `approval:<aid>`). */
  open<T = unknown>(env: SealedEnvelope, aad: string): Promise<T>;
  /** Seals JSON to the given recipients (deviceId → pubBox, b64url). */
  seal(value: unknown, recipients: Readonly<Record<string, string>>, aad: string): Promise<SealedEnvelope>;
  /**
   * The box key of an agent this client verified locally (pairing fingerprint check), or
   * null. Prompts are sealed only to keys from here, never to a key the cloud lists.
   */
  trustedAgentBoxKey(agentDeviceId: string): string | null;
}

/** Step-up for HIGH/CRITICAL decisions (WebAuthn / platform biometric), provided by the keys slice. */
export type StepUpProvider = (approval: {
  aid: string;
  risk: string;
  agentDeviceId: string;
}) => Promise<
  | { method: "webauthn"; at: number; assertion: Record<string, unknown> }
  | { method: "platform_biometric"; at: number }
  | null
>;
