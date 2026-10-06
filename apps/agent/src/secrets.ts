import type * as KeyringNs from "@napi-rs/keyring";

type KeyringModule = typeof KeyringNs;

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
const entry = async (name: string, load?: () => Promise<KeyringModule>) =>
  new (await loadKeyring(load)).Entry(SERVICE, name, { linux: { store: "secret-service" } });

/**
 * The keychain addon (@napi-rs/keyring, a per-platform native module embedded in the agent
 * binary) is missing or won't load: the build is broken for this platform (e.g. a darwin-x64
 * agent cross-compiled without that platform's addon). Chalito then FAILS CLOSED: it keeps no
 * keys anywhere else (no plaintext, no silent fallback) and tells the person to reinstall.
 */
export class KeyringUnavailableError extends Error {
  override name = "KeyringUnavailableError";
  constructor(cause?: unknown) {
    super(
      `This Chalito build can't use your system's keychain: its keychain component for ${process.platform}-${process.arch} is missing. ` +
        "Chalito won't store its keys anywhere else. Reinstall Chalito from https://chalito.chalyb.com/descargar.",
      { cause },
    );
  }
}

let keyringModule: Promise<KeyringModule> | null = null;

/** Loads the addon once (lazily, so a missing addon is a clear error, not a crash at import). */
export const loadKeyring = (load?: () => Promise<KeyringModule>): Promise<KeyringModule> => {
  const fail = (err: unknown): never => {
    throw new KeyringUnavailableError(err);
  };
  // An injected loader (tests) is never cached.
  if (load) return load().catch(fail);
  return (keyringModule ??= import("@napi-rs/keyring").catch((err: unknown) => {
    keyringModule = null;
    return fail(err);
  }));
};

export class KeyringStore implements SecretStore {
  /** `load` is for tests (a missing addon); production loads the embedded addon. */
  constructor(private readonly load?: () => Promise<KeyringModule>) {}

  async get(name: string) {
    const e = await entry(name, this.load); // a missing addon throws (fail closed), never "no value"
    try {
      return e.getPassword() ?? null;
    } catch {
      return null;
    }
  }
  async set(name: string, value: string) {
    const e = await entry(name, this.load);
    try {
      e.setPassword(value);
    } catch (err) {
      throw new Error(
        `Could not write to the OS keychain (${err instanceof Error ? err.message : "error"}). On Linux, make sure a Secret Service (gnome-keyring, KWallet or KeePassXC) is running in your session.`,
        { cause: err },
      );
    }
  }
  async delete(name: string) {
    const e = await entry(name, this.load);
    try {
      e.deletePassword();
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
  /** Gemini API key (Google AI Studio) for Gemini CLI. */
  googleApiKey: "byo-google-api-key",
} as const;
