import { Entry } from "@napi-rs/keyring";

/** OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service). */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

const SERVICE = "com.chalito.agent";

// Pin Linux to the Secret Service: without it the library silently falls back to the
// kernel keyring, which is in-memory and lost on reboot (device identity and BYO keys
// would vanish). Headless boxes use EncryptedFileSecretStore instead (secrets-file.ts).
const entry = (name: string) => new Entry(SERVICE, name, { linux: { store: "secret-service" } });

export class KeyringStore implements SecretStore {
  async get(name: string) {
    try {
      return entry(name).getPassword() ?? null;
    } catch {
      return null;
    }
  }
  async set(name: string, value: string) {
    try {
      entry(name).setPassword(value);
    } catch (err) {
      throw new Error(
        `Could not write to the OS keychain (${err instanceof Error ? err.message : "error"}). On Linux, make sure a Secret Service (gnome-keyring, KWallet or KeePassXC) is running in your session.`,
        { cause: err },
      );
    }
  }
  async delete(name: string) {
    try {
      entry(name).deletePassword();
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
