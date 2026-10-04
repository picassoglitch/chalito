import type { ClientKeys, StepUpProvider } from "@chalito/client";
import { DeviceClientKeys, KeyVault, passkeyStepUp } from "@chalito/client-keys";

export interface DeviceKeys {
  keys: ClientKeys;
  /** WebAuthn step-up for HIGH and CRITICAL decisions (assertion bound to the decision, D-019). */
  stepUp: StepUpProvider;
}

/**
 * Where the enrolment flow keeps this device's passkey reference after `registerPasskey`:
 * `{credentialId, rpId}`, public identifiers only (the private key stays in the authenticator).
 */
export const PASSKEY_REF_KEY = "chalito.passkey.v1";

const passkeyRef = (): { credentialId: string; rpId: string } | null => {
  try {
    const v = JSON.parse(window.localStorage.getItem(PASSKEY_REF_KEY) ?? "null") as {
      credentialId?: unknown;
      rpId?: unknown;
    } | null;
    return typeof v?.credentialId === "string" && typeof v.rpId === "string"
      ? { credentialId: v.credentialId, rpId: v.rpId }
      : null;
  } catch {
    return null;
  }
};

/**
 * This browser's device keys from packages/client-keys: libsodium secrets in IndexedDB, wrapped
 * by a non-extractable WebCrypto key. Null until this browser is enrolled and paired with at least
 * one computer (pairing has its own slice). Never a stub here: the dev/test stub lives in src/dev.
 * Without a passkey, step-up yields null and a HIGH/CRITICAL allow is refused, never sent unbound.
 */
export const loadDeviceKeys = async (): Promise<DeviceKeys | null> => {
  let vault: KeyVault;
  try {
    vault = await KeyVault.open();
  } catch {
    return null; // no IndexedDB/WebCrypto (very old browser, some private modes)
  }
  const stored = await vault.load();
  if (!stored) return null;
  const keys = await DeviceClientKeys.create(stored, vault);
  if (keys.trustedAgents().length === 0) return null;
  return { keys, stepUp: passkeyStepUp(passkeyRef()) as StepUpProvider };
};
