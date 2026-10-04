import { fromB64url, sealJson, type TrustedClientList } from "@chalito/crypto";
import type { SealedEnvelope } from "@chalito/protocol";

/**
 * Seals content to the clients THIS device trusts right now, plus the agent itself.
 * A key the cloud lists but the device never trusted never becomes a recipient.
 */
export class Sealer {
  constructor(
    private readonly trust: () => TrustedClientList,
    private readonly self: { deviceId: string; pubBox: string },
  ) {}

  async recipients(): Promise<Record<string, Uint8Array>> {
    const out: Record<string, Uint8Array> = { [this.self.deviceId]: await fromB64url(this.self.pubBox) };
    for (const [id, key] of Object.entries(this.trust().recipients())) out[id] = await fromB64url(key);
    return out;
  }

  async seal(value: unknown, aad: string): Promise<SealedEnvelope> {
    return sealJson(value, await this.recipients(), aad);
  }
}
