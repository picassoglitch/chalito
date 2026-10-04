import type { ClientKeys, StepUpProvider } from "@chalito/client";
import { DeviceClientKeys, KeyVault } from "@chalito/client-keys";

export interface DeviceKeys {
  keys: ClientKeys;
  /** WebAuthn / platform step-up for HIGH and CRITICAL decisions. Null result = nothing is sent. */
  stepUp: StepUpProvider;
}

/**
 * This browser's device keys from packages/client-keys: libsodium secrets in IndexedDB, wrapped
 * by a non-extractable WebCrypto key. Null until this browser is enrolled and paired (the
 * pairing UI is its own slice). Never a stub here: the dev/test stub lives in src/dev.
 *
 * Step-up: client-keys' passkeyStepUp binds the WebAuthn assertion to the unsigned decision body
 * (D-019), but packages/client's StepUpProvider doesn't pass that body yet. Until the two agree,
 * step-up yields null, so a HIGH/CRITICAL allow is refused ("cancelled: nothing was sent")
 * instead of being sent without a binding assertion.
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
  if (keys.trustedAgents().length === 0) return null; // enrolled but not paired with any computer yet
  return { keys, stepUp: async () => null };
};
