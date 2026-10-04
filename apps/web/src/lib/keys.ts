import type { ClientKeys, StepUpProvider } from "@chalito/client";
import {
  DeviceClientKeys,
  KeyVault,
  httpApi,
  passkeyStepUp,
  registerPasskey,
  type DeviceKeys as RawDeviceKeys,
} from "@chalito/client-keys";
import type { IntroducedAgent } from "@chalito/protocol";

export interface DeviceKeys {
  keys: ClientKeys & Pick<DeviceClientKeys, "sign" | "deviceId" | "trustedAgents">;
  /** WebAuthn step-up for HIGH and CRITICAL decisions (assertion bound to the decision, D-019). */
  stepUp: StepUpProvider;
  /** After revocation: drop every agent this browser trusted (it must be paired again). */
  forget: () => Promise<void>;
}

/**
 * This device's passkey reference after enrolment: `{credentialId, rpId}`, public identifiers only
 * (the private key stays in the authenticator).
 */
export const PASSKEY_REF_KEY = "chalito.passkey.v1";

export const passkeyRef = (): { credentialId: string; rpId: string } | null => {
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

export const savePasskeyRef = (ref: { credentialId: string; rpId: string }): void =>
  window.localStorage.setItem(PASSKEY_REF_KEY, JSON.stringify({ credentialId: ref.credentialId, rpId: ref.rpId }));

/**
 * Set once a trusted device endorsed this browser's current identity (/v1/devices/endorsed): it
 * is a client of the account even before it pairs with a computer. Public identifiers only.
 */
export const ENDORSED_KEY = "chalito.endorsed.v1";

export const endorsedDevice = (): string | null => {
  try {
    const v = JSON.parse(window.localStorage.getItem(ENDORSED_KEY) ?? "null") as { deviceId?: unknown } | null;
    return typeof v?.deviceId === "string" ? v.deviceId : null;
  } catch {
    return null;
  }
};

/** After enrolment: this identity is trusted, and any passkey belonged to the old one. */
export const markEndorsed = (deviceId: string): void => {
  window.localStorage.setItem(ENDORSED_KEY, JSON.stringify({ deviceId }));
  window.localStorage.removeItem(PASSKEY_REF_KEY);
};

/** ADR 0018: trust the computers the endorsing device introduced (already vetted against the directory). */
export const trustIntroducedAgents = async (
  raw: RawDeviceKeys,
  agents: readonly IntroducedAgent[],
  endorsedBy: string,
): Promise<void> => {
  const vault = await KeyVault.open();
  await (await DeviceClientKeys.create(raw, vault)).trustIntroducedAgents(agents, endorsedBy, Date.now());
};

/** A new identity for this browser, replacing the old one and the agents it trusted. */
export const saveDeviceKeys = async (keys: RawDeviceKeys): Promise<void> => {
  window.localStorage.removeItem(ENDORSED_KEY);
  await (await KeyVault.open()).save(keys);
};

/**
 * "Protege tus aprobaciones con tu passkey": registers a passkey for this device through the api
 * (client-keys registerPasskey: options → authenticator → verify → device-signed binding) and keeps
 * its reference. With a passkey already here, this REPLACES it, confirmed with the current one
 * (R-M11). Throws on failure; a cancelled authenticator prompt rejects with NotAllowedError.
 */
export const enrollPasskey = async (
  device: DeviceKeys["keys"],
  apiBase: string,
  token: () => Promise<string | null>,
): Promise<void> => {
  // R-M11: replacing an existing passkey needs an assertion by the current one first.
  const credential = await registerPasskey(httpApi({ baseUrl: apiBase, token }), device, undefined, undefined, {
    replace: passkeyRef() !== null,
  });
  savePasskeyRef(credential);
};

/**
 * This browser's device keys from packages/client-keys: libsodium secrets in IndexedDB, wrapped
 * by a non-extractable WebCrypto key. Null until this browser is enrolled and paired with at least
 * one computer, or endorsed by a trusted device. Never a stub here: the dev/test stub lives in src/dev. The step-up reads the passkey
 * reference when a decision is made, so enrolling mid-session works; without a passkey it yields
 * null and the UI asks to enrol instead of sending an unbound allow.
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
  // Trusted once paired with a computer (its glyph) or endorsed by another trusted device.
  if (keys.trustedAgents().length === 0 && endorsedDevice() !== stored.deviceId) return null;
  const stepUp: StepUpProvider = (approval, body) => passkeyStepUp(passkeyRef())(approval, body);
  const forget = async () => {
    for (const a of keys.trustedAgents()) await keys.forgetAgent(a.deviceId);
    window.localStorage.removeItem(ENDORSED_KEY);
  };
  return { keys, stepUp, forget };
};
