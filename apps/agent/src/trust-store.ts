import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  TrustedClientList,
  signDetached,
  verifyDetached,
  type SigningKeyPair,
  type TrustedClient,
} from "@chalito/crypto";

/**
 * ~/.chalito/trusted-clients.json, signed by the agent's own key. A file that doesn't
 * verify is refused: the agent then trusts nobody until a local re-pair, rather than
 * whatever was written there.
 */
export class TrustStore {
  constructor(
    readonly dir: string,
    private readonly agentKeys: SigningKeyPair,
    private readonly deviceId: string,
  ) {}

  get file(): string {
    return join(this.dir, "trusted-clients.json");
  }

  async load(): Promise<{ list: TrustedClientList; tampered: boolean }> {
    if (!existsSync(this.file)) return { list: new TrustedClientList(this.deviceId), tampered: false };
    try {
      const { clients, sig } = JSON.parse(readFileSync(this.file, "utf8")) as { clients: TrustedClient[]; sig: string };
      const ok = await verifyDetached(
        "chalito.trusted-list.v1",
        { deviceId: this.deviceId, clients },
        sig,
        this.agentKeys.publicKey,
      );
      if (!ok) return { list: new TrustedClientList(this.deviceId), tampered: true };
      return { list: await TrustedClientList.fromJSON(this.deviceId, clients), tampered: false };
    } catch {
      return { list: new TrustedClientList(this.deviceId), tampered: true };
    }
  }

  async save(list: TrustedClientList): Promise<void> {
    const clients = list.toJSON();
    const sig = await signDetached(
      "chalito.trusted-list.v1",
      { deviceId: this.deviceId, clients },
      this.agentKeys.secretKey,
    );
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ clients, sig }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
