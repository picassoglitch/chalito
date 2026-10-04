import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { chooseSecretStore, EncryptedFileSecretStore } from "./secrets-file.js";
import { KeyringStore, type SecretStore } from "./secrets.js";

/**
 * Where the agent keeps its keys.
 *
 * - Default: the OS keychain; when no keychain is reachable (headless Linux), the
 *   passphrase-encrypted ~/.chalito/secrets.enc, with a warning.
 * - Dev/test override: `CHALITO_SECRETS=file:<path>` forces an encrypted file at <path>
 *   (passphrase from `CHALITO_SECRETS_PASSPHRASE`), so E2E runs can use a scratch HOME and
 *   never touch the real keychain. Not meant for production installs.
 *
 * The passphrase, in order (review R-L12: a headless install shouldn't need it in an environment):
 * 1. the systemd credential `chalito-secrets-passphrase` ($CREDENTIALS_DIRECTORY, set up by
 *    `chalito service install --passphrase-file`);
 * 2. `CHALITO_SECRETS_PASSPHRASE_FILE`: a file only its owner can read (0600);
 * 3. `CHALITO_SECRETS_PASSPHRASE` (dev/test);
 * 4. the interactive `prompt` (the CLI).
 */
export const openSecretStore = async (opts: {
  env: Record<string, string | undefined>;
  prompt?: () => Promise<string>;
  warn: (message: string) => void;
  keyring?: SecretStore;
  probe?: () => Promise<boolean | "addon_missing">;
}): Promise<SecretStore> => {
  const passphrase = async (): Promise<string> => {
    const credDir = opts.env.CREDENTIALS_DIRECTORY;
    if (credDir) {
      const fromCred = readPassphrase(join(credDir, "chalito-secrets-passphrase"), false);
      if (fromCred) return fromCred;
    }
    const file = opts.env.CHALITO_SECRETS_PASSPHRASE_FILE;
    if (file) {
      const problem = passphraseFileProblem(file);
      if (problem) throw new Error(`CHALITO_SECRETS_PASSPHRASE_FILE ${file}: ${problem}.`);
      const fromFile = readPassphrase(file, true);
      if (fromFile) return fromFile;
    }
    const fromEnv = opts.env.CHALITO_SECRETS_PASSPHRASE;
    if (fromEnv) return fromEnv;
    if (opts.prompt) return opts.prompt();
    throw new Error(
      "The encrypted secrets file needs a passphrase: install the service with --passphrase-file " +
        "(a systemd credential), or set CHALITO_SECRETS_PASSPHRASE_FILE to a 0600 file.",
    );
  };
  const override = opts.env.CHALITO_SECRETS;
  if (override) {
    if (!override.startsWith("file:") || override.length <= 5)
      throw new Error("CHALITO_SECRETS must be file:<path> (dev/test only).");
    opts.warn(`Using the encrypted secrets file ${override.slice(5)} (CHALITO_SECRETS, dev/test only).`);
    return new EncryptedFileSecretStore({ path: override.slice(5), passphrase });
  }
  const chosen = await chooseSecretStore({
    keyring: opts.keyring ?? new KeyringStore(),
    fileStore: () => new EncryptedFileSecretStore({ passphrase }),
    ...(opts.probe ? { probe: opts.probe } : {}),
  });
  if (chosen.kind === "file") opts.warn(chosen.warning);
  return chosen.store;
};

/** Why a passphrase file can't be used (missing, not a regular file, or readable by others), or null. */
export const passphraseFileProblem = (path: string): string | null => {
  let st;
  try {
    st = statSync(path);
  } catch {
    return "it doesn't exist";
  }
  if (!st.isFile()) return "it isn't a regular file";
  if (process.platform !== "win32") {
    if ((st.mode & 0o077) !== 0) return "group or others can read it (chmod 600)";
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return "you don't own it";
  }
  return null;
};

const readPassphrase = (path: string, required: boolean): string | null => {
  try {
    const v = readFileSync(path, "utf8").replace(/\r?\n$/, "");
    return v.length > 0 ? v : null;
  } catch (err) {
    if (required) throw err;
    return null;
  }
};
