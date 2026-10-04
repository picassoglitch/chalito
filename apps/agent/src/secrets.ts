import { Entry } from "@napi-rs/keyring";

/** OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service). */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

const SERVICE = "com.chalito.agent";

export class KeyringStore implements SecretStore {
  async get(name: string) {
    try {
      return new Entry(SERVICE, name).getPassword() ?? null;
    } catch {
      return null;
    }
  }
  async set(name: string, value: string) {
    try {
      new Entry(SERVICE, name).setPassword(value);
    } catch (err) {
      throw new Error(
        `Could not write to the OS keychain (${err instanceof Error ? err.message : "error"}). On Linux, make sure a Secret Service (gnome-keyring, KWallet or KeePassXC) is running in your session.`,
        { cause: err },
      );
    }
  }
  async delete(name: string) {
    try {
      new Entry(SERVICE, name).deletePassword();
    } catch {
      /* already gone */
    }
  }
}

export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  async get(name: string) {
    return this.values.get(name) ?? null;
  }
  async set(name: string, value: string) {
    this.values.set(name, value);
  }
  async delete(name: string) {
    this.values.delete(name);
  }
}

/** Names of the secrets the agent keeps. BYO keys never leave the device. */
export const SECRET_NAMES = {
  identity: "device-identity",
  anthropicApiKey: "byo-anthropic-api-key",
  openaiApiKey: "byo-openai-api-key",
  xaiApiKey: "byo-xai-api-key",
} as const;
