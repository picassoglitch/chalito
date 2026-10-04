import {
  fingerprint,
  fromB64url,
  openJson,
  signEnvelope,
  stepUpChallenge,
  type WebAuthnCredentialRef,
} from "@chalito/crypto";
import type { GlyphPayload, IntroducedAgent, SealedEnvelope, SigningContext } from "@chalito/protocol";
import type { DeviceKeys, KeyVault, TrustedAgent } from "./keys.js";
import { publicKeys } from "./keys.js";
import { checkPairingGlyph } from "./pairing.js";
import { sealFor } from "./sealing.js";
import { browserCeremonies, stepUpWithPasskey, type Ceremonies } from "./webauthn.js";

/**
 * The `ClientKeys` and `StepUpProvider` that packages/client (the data layer) expects
 * (packages/client/src/keys.ts). Implemented structurally, so this package doesn't depend on the
 * data layer. Private keys stay inside these closures: callers can only sign, open and seal.
 */
export class DeviceClientKeys {
  readonly deviceId: string;
  readonly #agents = new Map<string, TrustedAgent>();
  readonly #keys: DeviceKeys;

  private constructor(
    keys: DeviceKeys,
    readonly pubBox: string,
    private readonly vault: KeyVault | null,
    agents: TrustedAgent[],
  ) {
    this.#keys = keys;
    this.deviceId = keys.deviceId;
    for (const a of agents) this.#agents.set(a.deviceId, a);
  }

  /** From the vault (persisted trusted agents) or from in-memory keys (tests, first run). */
  static async create(keys: DeviceKeys, vault: KeyVault | null = null): Promise<DeviceClientKeys> {
    const pub = await publicKeys(keys);
    return new DeviceClientKeys(keys, pub.pubBox, vault, vault ? await vault.loadTrustedAgents() : []);
  }

  sign<T>(ctx: SigningContext, body: T) {
    return signEnvelope(ctx, body, this.deviceId, this.#keys.sign.secretKey);
  }

  open<T = unknown>(env: SealedEnvelope, aad: string): Promise<T> {
    return openJson<T>(env, this.deviceId, this.#keys.box, aad);
  }

  seal(value: unknown, recipients: Readonly<Record<string, string>>, aad: string): Promise<SealedEnvelope> {
    return sealFor(value, recipients, aad);
  }

  /**
   * Only agents this client trusts: verified itself (a signed pairing glyph whose fingerprint
   * the user confirmed), or introduced by the endorsement of a client the person trusts AND
   * matching the devices directory (ADR 0018). Never a key from a cloud listing alone.
   */
  trustedAgentBoxKey(agentDeviceId: string): string | null {
    return this.#agents.get(agentDeviceId)?.pubBox ?? null;
  }

  /** ADR 0019: verifies the agent's signed approval requests. Same trust rule as the box key. */
  trustedAgentSignKey(agentDeviceId: string): string | null {
    return this.#agents.get(agentDeviceId)?.pubSign ?? null;
  }

  trustedAgents(): TrustedAgent[] {
    return [...this.#agents.values()];
  }

  /**
   * Records an agent after pairing: the glyph must verify (signature, purpose, time) and the
   * fingerprint the user confirmed on screen must be the one derived from its key.
   */
  async trustAgentFromGlyph(glyph: GlyphPayload, confirmedFingerprint: string, now: number): Promise<TrustedAgent> {
    const check = await checkPairingGlyph(glyph, now);
    if (check.state !== "ready") throw new Error(`untrusted glyph: ${check.reason}`);
    if (check.display.fingerprint !== confirmedFingerprint) throw new Error("fingerprint not confirmed");
    if (!glyph.body.issuerPubBox) throw new Error("glyph has no box key");
    if ((await fingerprint(await fromB64url(glyph.body.issuerPubSign))) !== confirmedFingerprint)
      throw new Error("fingerprint not confirmed");
    const agent: TrustedAgent = {
      deviceId: check.display.agentDeviceId,
      pubSign: glyph.body.issuerPubSign,
      pubBox: glyph.body.issuerPubBox,
      fingerprint: confirmedFingerprint,
      label: glyph.body.label,
      confirmedAt: now,
    };
    this.#agents.set(agent.deviceId, agent);
    await this.vault?.saveTrustedAgents(this.trustedAgents());
    return agent;
  }

  /**
   * ADR 0018: agents introduced by this client's endorsement, already vetted by
   * `introducedAgents` (endorsement signature + devices directory). Never downgrades an agent
   * this client confirmed itself.
   */
  async trustIntroducedAgents(agents: readonly IntroducedAgent[], endorsedBy: string, now: number): Promise<string[]> {
    const added: string[] = [];
    for (const a of agents) {
      const cur = this.#agents.get(a.deviceId);
      if (cur && cur.via !== "endorsement") continue;
      this.#agents.set(a.deviceId, {
        deviceId: a.deviceId,
        pubSign: a.pubSign,
        pubBox: a.pubBox,
        fingerprint: a.fingerprint,
        label: "",
        confirmedAt: now,
        via: "endorsement",
        endorsedBy,
      });
      added.push(a.deviceId);
    }
    if (added.length) await this.vault?.saveTrustedAgents(this.trustedAgents());
    return added;
  }

  /** After revoking or unpairing an agent: nothing is sealed to it any more. */
  async forgetAgent(agentDeviceId: string): Promise<boolean> {
    const had = this.#agents.delete(agentDeviceId);
    if (had) await this.vault?.saveTrustedAgents(this.trustedAgents());
    return had;
  }
}

export type StepUpResult = { method: "webauthn"; at: number; assertion: Record<string, unknown> } | null;

/**
 * A `StepUpProvider` backed by this device's passkey. The assertion must be bound to the decision
 * (D-019: challenge = SHA-256(JCS(decision body without stepUp))), so the caller passes the
 * unsigned decision body it is about to sign; without it no step-up is produced. Returns null
 * when this device has no passkey (the agent then rejects the allow as missing_step_up).
 */
export const passkeyStepUp =
  (
    credential: Pick<WebAuthnCredentialRef, "credentialId" | "rpId"> | null,
    o: { ceremonies?: Ceremonies; now?: () => number } = {},
  ) =>
  async (
    _approval: { aid: string; risk: string; agentDeviceId: string },
    unsignedDecisionBody?: Record<string, unknown>,
  ): Promise<StepUpResult> => {
    if (!credential) return null;
    if (!unsignedDecisionBody)
      throw new Error("step-up needs the unsigned decision body (the assertion is bound to it, D-019)");
    const assertion = await stepUpWithPasskey(
      credential,
      o.ceremonies ?? browserCeremonies,
    )(await stepUpChallenge(unsignedDecisionBody));
    return { method: "webauthn", at: (o.now ?? Date.now)(), assertion };
  };
