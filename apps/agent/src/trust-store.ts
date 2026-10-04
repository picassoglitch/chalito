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
 * whatever was written there. Tombstones (clients removed here, ADR 0018) are signed with the
 * list; a file without them is signed over `{deviceId, clients}` exactly as before.
 */
const signedPart = (deviceId: string, clients: TrustedClient[], removed?: string[]) =>
  removed?.length ? { deviceId, clients, removed } : { deviceId, clients };

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
      const { clients, removed, sig } = JSON.parse(readFileSync(this.file, "utf8")) as {
        clients: TrustedClient[];
        removed?: string[];
        sig: string;
      };
      const ok = await verifyDetached(
        "chalito.trusted-list.v1",
        signedPart(this.deviceId, clients, removed),
        sig,
        this.agentKeys.publicKey,
      );
      if (!ok) return { list: new TrustedClientList(this.deviceId), tampered: true };
      return { list: await TrustedClientList.fromJSON(this.deviceId, clients, removed ?? []), tampered: false };
    } catch {
      return { list: new TrustedClientList(this.deviceId), tampered: true };
    }
  }

  async save(list: TrustedClientList): Promise<void> {
    const clients = list.toJSON();
    const removed = list.removedIds();
    const sig = await signDetached(
      "chalito.trusted-list.v1",
      signedPart(this.deviceId, clients, removed),
      this.agentKeys.secretKey,
    );
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ clients, ...(removed.length ? { removed } : {}), sig }, null, 2), {
      mode: 0o600,
    });
    renameSync(tmp, this.file);
  }
}
