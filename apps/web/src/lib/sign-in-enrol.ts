import {
  ApiError,
  SIGN_IN_INTRODUCER,
  accountAgents,
  enrollSignedIn,
  generateDeviceKeys,
  signDeviceRegistration,
  type ApiClient,
  type DeviceKeys as RawDeviceKeys,
  type DirectoryDevice,
} from "@chalito/client-keys";
import type { IntroducedAgent } from "@chalito/protocol";

// ADR 0032 — signing in approves this browser by itself (/v1/devices/signin): no code, no second device.

export { SIGN_IN_INTRODUCER } from "@chalito/client-keys";

export type SignInEnrolError = "device_exists" | "unsupported" | "rejected" | "failed";

export type SignInEnrolResult =
  { ok: true; deviceId: string; customToken: string; computers: number } | { ok: false; reason: SignInEnrolError };

export interface SignInEnrolDeps {
  /** Authenticated as the person (hub session): /v1/devices/signin is a `user` route. */
  api: ApiClient;
  /** Stores the new identity (replacing any old one, and the agents it trusted). */
  save(keys: RawDeviceKeys): Promise<void>;
  owner: string;
  /** What the person's other devices see in the alert and in Devices, e.g. "Chrome en Mac". */
  name: string;
  /** The account's devices, read with the person's session before this browser switches to its own. */
  directory?: () => Promise<DirectoryDevice[]>;
  /** Stores the account's computers in this browser's trust list. */
  trust?: (keys: RawDeviceKeys, agents: IntroducedAgent[], endorsedBy: string) => Promise<void>;
  generate?: () => Promise<RawDeviceKeys>;
  now?: () => number;
}

export const enrolBySignIn = async (d: SignInEnrolDeps): Promise<SignInEnrolResult> => {
  const now = d.now ?? Date.now;
  // Always a fresh identity: a revoked one must not come back, and an unregistered leftover is
  // worth nothing. Saved first, so the enrolled device always has its keys.
  let keys: RawDeviceKeys;
  let enrolled: { customToken: string; deviceId: string };
  try {
    keys = await (d.generate ?? generateDeviceKeys)();
    await d.save(keys);
    const registration = await signDeviceRegistration(keys, {
      owner: d.owner,
      kind: "web",
      platform: "web",
      name: d.name.slice(0, 40),
      now: now(),
    });
    enrolled = await enrollSignedIn(d.api, { registration });
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 404) return { ok: false, reason: "unsupported" };
      if (err.code === "device_exists") return { ok: false, reason: "device_exists" };
      return { ok: false, reason: err.status < 500 ? "rejected" : "failed" };
    }
    return { ok: false, reason: "failed" };
  }
  if (enrolled.deviceId !== keys.deviceId) return { ok: false, reason: "failed" };

  // The account's computers, from the directory. Best effort: the connect after this retries.
  let computers = 0;
  if (d.directory && d.trust) {
    try {
      const agents = await accountAgents(await d.directory());
      if (agents.length) await d.trust(keys, agents, SIGN_IN_INTRODUCER);
      computers = agents.length;
    } catch {
      computers = 0;
    }
  }
  return { ok: true, deviceId: enrolled.deviceId, customToken: enrolled.customToken, computers };
};
