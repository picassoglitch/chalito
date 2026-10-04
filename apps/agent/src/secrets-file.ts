import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fromB64url, toB64url } from "@chalito/crypto";
import sodium from "libsodium-wrappers-sumo";
import { KeyringUnavailableError, loadKeyring, type SecretStore } from "./secrets.js";

/**
 * Headless-Linux fallback for the OS keychain (ADR 0004): one file, ~/.chalito/secrets.enc
 * (0600), holding every secret as a JSON map sealed with XChaCha20-Poly1305 under a key
 * derived from the user's passphrase with argon2id. Uses the sumo libsodium build because
 * the standard one has no crypto_pwhash.
 */
export const SECRETS_FILE_AAD = "chalito.secrets.v1";
export const defaultSecretsFilePath = () => join(homedir(), ".chalito", "secrets.enc");

interface SecretsFile {
  v: 1;
  kdf: { alg: "argon2id13"; opslimit: number; memlimit: number; salt: string };
  nonce: string;
  ct: string;
}

export interface EncryptedFileSecretStoreOptions {
  /** The passphrase, or a prompt that returns it (asked at most once per store). */
  passphrase: string | (() => Promise<string>);
  path?: string;
  /** argon2id limits for new files; existing files keep the limits in their header. Defaults to MODERATE. */
  kdf?: { opslimit: number; memlimit: number };
}

let sodiumReady: Promise<typeof sodium> | undefined;
const ready = () => (sodiumReady ??= sodium.ready.then(() => sodium));

export class SecretsFileError extends Error {}

export class EncryptedFileSecretStore implements SecretStore {
  readonly path: string;
  #passphrase: EncryptedFileSecretStoreOptions["passphrase"];
  #kdf?: EncryptedFileSecretStoreOptions["kdf"];
  /** Key cached per salt so a session derives it once. */
  #key?: { salt: string; key: Uint8Array };

  constructor(opts: EncryptedFileSecretStoreOptions) {
    this.path = opts.path ?? defaultSecretsFilePath();
    this.#passphrase = opts.passphrase;
    this.#kdf = opts.kdf;
  }

  async get(name: string) {
    return (await this.#load())?.values[name] ?? null;
  }

  async set(name: string, value: string) {
    const cur = await this.#load();
    const values = { ...cur?.values, [name]: value };
    await this.#save(values, cur?.header.kdf);
  }

  async delete(name: string) {
    const cur = await this.#load();
    if (!cur || !(name in cur.values)) return;
    const { [name]: _gone, ...rest } = cur.values;
    await this.#save(rest, cur.header.kdf);
  }

  async #deriveKey(kdf: SecretsFile["kdf"]): Promise<Uint8Array> {
    if (this.#key?.salt === kdf.salt) return this.#key.key;
    const s = await ready();
    const pass = typeof this.#passphrase === "string" ? this.#passphrase : await this.#passphrase();
    this.#passphrase = pass;
    const key = s.crypto_pwhash(
      s.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
      pass,
      await fromB64url(kdf.salt),
      kdf.opslimit,
      kdf.memlimit,
      s.crypto_pwhash_ALG_ARGON2ID13,
    );
    this.#key = { salt: kdf.salt, key };
    return key;
  }

  async #load(): Promise<{ header: SecretsFile; values: Record<string, string> } | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let header: SecretsFile;
    try {
      header = JSON.parse(raw) as SecretsFile;
      if (header.v !== 1 || header.kdf?.alg !== "argon2id13") throw new Error("unsupported format");
    } catch (err) {
      throw new SecretsFileError(`${this.path} is not a Chalito secrets file`, { cause: err });
    }
    const s = await ready();
    const key = await this.#deriveKey(header.kdf);
    let plain: Uint8Array;
    try {
      plain = s.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        await fromB64url(header.ct),
        SECRETS_FILE_AAD,
        await fromB64url(header.nonce),
        key,
      );
    } catch (err) {
      // Wrong passphrase and tampering look the same to AEAD; drop the cached key either way.
      this.#key = undefined;
      throw new SecretsFileError("Wrong passphrase, or the secrets file was modified", { cause: err });
    }
    return { header, values: JSON.parse(s.to_string(plain)) as Record<string, string> };
  }

  async #save(values: Record<string, string>, existing?: SecretsFile["kdf"]) {
    const s = await ready();
    const kdf: SecretsFile["kdf"] = existing ?? {
      alg: "argon2id13",
      opslimit: this.#kdf?.opslimit ?? s.crypto_pwhash_OPSLIMIT_MODERATE,
      memlimit: this.#kdf?.memlimit ?? s.crypto_pwhash_MEMLIMIT_MODERATE,
      salt: await toB64url(s.randombytes_buf(s.crypto_pwhash_SALTBYTES)),
    };
    const key = await this.#deriveKey(kdf);
    const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(JSON.stringify(values), SECRETS_FILE_AAD, null, nonce, key);
    const file: SecretsFile = { v: 1, kdf, nonce: await toB64url(nonce), ct: await toB64url(ct) };

    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
    await chmod(tmp, 0o600); // in case the umask or an existing tmp widened it
    await rename(tmp, this.path);
  }
}

/**
 * Whether a persistent OS keychain is reachable. On Linux this means a Secret Service, never
 * keyutils (in-memory, lost on reboot). "addon_missing" when the keychain addon itself won't
 * load: a broken build, which must fail closed rather than fall back.
 */
export const keyringProbe = async (load?: Parameters<typeof loadKeyring>[0]): Promise<boolean | "addon_missing"> => {
  let mod;
  try {
    mod = await loadKeyring(load);
  } catch {
    return "addon_missing";
  }
  try {
    const e = new mod.Entry("com.chalito.agent.probe", `probe-${process.pid}`, { linux: { store: "secret-service" } });
    e.setPassword("1");
    const ok = e.getPassword() === "1";
    e.deletePassword();
    return ok;
  } catch {
    return false;
  }
};

export const FILE_STORE_WARNING =
  "No OS keychain (Secret Service) is available, so Chalito keeps its keys in ~/.chalito/secrets.enc, encrypted with your passphrase. Anyone with that file and your passphrase can read them; start gnome-keyring, KWallet or KeePassXC to use the keychain instead.";

export type ChosenSecretStore =
  { kind: "keyring"; store: SecretStore } | { kind: "file"; store: SecretStore; warning: string };

/**
 * The keyring when the probe passes; the encrypted file (with a warning the caller must show)
 * when there's no keychain service; KeyringUnavailableError when the addon is missing.
 */
export const chooseSecretStore = async (deps: {
  keyring: SecretStore;
  fileStore: () => SecretStore;
  probe?: () => Promise<boolean | "addon_missing">;
}): Promise<ChosenSecretStore> => {
  const p = await (deps.probe ?? keyringProbe)();
  // The encrypted file is for machines WITHOUT a keychain service (headless Linux), not for a
  // build that lost its keychain addon: that one refuses to run.
  if (p === "addon_missing") throw new KeyringUnavailableError();
  if (p) return { kind: "keyring", store: deps.keyring };
  return { kind: "file", store: deps.fileStore(), warning: FILE_STORE_WARNING };
};
