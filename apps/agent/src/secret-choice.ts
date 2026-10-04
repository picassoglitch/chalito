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
 * The passphrase comes from `CHALITO_SECRETS_PASSPHRASE`, else the interactive `prompt`
 * (the CLI). The daemon has no prompt, so a headless install must provide it in the
 * service environment.
 */
export const openSecretStore = async (opts: {
  env: Record<string, string | undefined>;
  prompt?: () => Promise<string>;
  warn: (message: string) => void;
  keyring?: SecretStore;
  probe?: () => Promise<boolean | "addon_missing">;
}): Promise<SecretStore> => {
  const passphrase = async (): Promise<string> => {
    const fromEnv = opts.env.CHALITO_SECRETS_PASSPHRASE;
    if (fromEnv) return fromEnv;
    if (opts.prompt) return opts.prompt();
    throw new Error("The encrypted secrets file needs a passphrase: set CHALITO_SECRETS_PASSPHRASE.");
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
