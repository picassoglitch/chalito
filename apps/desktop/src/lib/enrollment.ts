import type { ApiClient, Ceremonies, DeviceKeys, DeviceSigner, DirectoryDevice } from "@chalito/client-keys";
import {
  ApiError,
  SIGN_IN_INTRODUCER,
  accountAgents,
  enrollSignedIn,
  generateDeviceKeys,
  registerPasskey,
  signDeviceRegistration,
} from "@chalito/client-keys";
import type { DeviceRegistration, IntroducedAgent } from "@chalito/protocol";

// ADR 0032 — the hub sign-in enrols this panel (/v1/devices/signin), then the account's computers
// and a passkey. Never through the agent's IPC: the agent must not mint client trust for itself.

export { SIGN_IN_INTRODUCER } from "@chalito/client-keys";

export type EnrollError = "unsupported" | "device_exists" | "rejected" | "failed";

export type PasskeyOutcome = "enrolled" | "unavailable" | "failed";

export type EnrollResult =
  | {
      ok: true;
      deviceId: string;
      customToken: string;
      passkey: PasskeyOutcome;
      /** Public identifiers of the enrolled passkey (for step-up), or null. */
      credential: { credentialId: string; rpId: string } | null;
      /** The account's computers trusted here at enrolment. */
      agents: string[];
    }
  | { ok: false; reason: EnrollError };

export interface EnrollDeps {
  owner: string;
  name: string;
  /** Stored keys, or null to generate and store a new identity. */
  keys: { load(): Promise<DeviceKeys | null>; save(k: DeviceKeys): Promise<void> };
  /** Authenticated as the person (hub session): /v1/devices/signin is a `user` route. */
  userApi: ApiClient;
  /** Authenticated as this device (after step 4): webauthn routes are `client` routes. */
  deviceApi: (customToken: string) => Promise<ApiClient>;
  signer: (keys: DeviceKeys) => Promise<DeviceSigner>;
  platformAuthenticator: () => Promise<boolean>;
  /**
   * The webview's origin. WebAuthn binds a passkey to the rpId's https origin, and the panel's
   * (tauri://localhost, http://tauri.localhost) never matches: off https the attempt is skipped
   * entirely and the panel is a client without step-up (beta decision).
   */
  origin?: string;
  ceremonies?: Ceremonies;
  /** The account's devices directory, and where to keep its computers. */
  introduce?: {
    directory: () => Promise<DirectoryDevice[]>;
    trust: (keys: DeviceKeys, agents: IntroducedAgent[], endorsedBy: string) => Promise<string[]>;
  };
  now?: () => number;
}

export const enrollDesktop = async (d: EnrollDeps): Promise<EnrollResult> => {
  const now = d.now ?? Date.now;
  let keys = await d.keys.load();
  if (!keys) {
    keys = await generateDeviceKeys();
    await d.keys.save(keys);
  }
  const register = (k: DeviceKeys) =>
    signDeviceRegistration(k, {
      owner: d.owner,
      // The protocol's client kinds are phone | web: the panel is a web client in a webview.
      kind: "web",
      platform: "web",
      name: d.name,
      now: now(),
    });
  let registration = await register(keys);

  const bySignIn = await enrollBySignIn(d, keys, registration);
  // ADR 0032 — no trusted-device fallback: an api without the route is an error, never a code to approve.
  if (bySignIn.kind === "unsupported") return { ok: false, reason: "unsupported" };
  if (bySignIn.kind === "fresh_keys") {
    // Keys left from an earlier attempt are taken (or were revoked): start over with new ones.
    keys = await generateDeviceKeys();
    await d.keys.save(keys);
    registration = await register(keys);
    const retry = await enrollBySignIn(d, keys, registration);
    if (retry.kind !== "enrolled")
      return { ok: false, reason: retry.kind === "error" ? retry.reason : "device_exists" };
    return finish(d, keys, retry.enrolled, now);
  }
  if (bySignIn.kind === "error") return { ok: false, reason: bySignIn.reason };
  return finish(d, keys, bySignIn.enrolled, now);
};

type SignInAttempt =
  | { kind: "enrolled"; enrolled: { customToken: string; deviceId: string } }
  | { kind: "unsupported" }
  | { kind: "fresh_keys" }
  | { kind: "error"; reason: EnrollError };

const enrollBySignIn = async (
  d: EnrollDeps,
  keys: DeviceKeys,
  registration: DeviceRegistration,
): Promise<SignInAttempt> => {
  try {
    const enrolled = await enrollSignedIn(d.userApi, { registration });
    if (enrolled.deviceId !== keys.deviceId) return { kind: "error", reason: "failed" };
    return { kind: "enrolled", enrolled };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { kind: "unsupported" };
    if (err instanceof ApiError && err.code === "device_exists") return { kind: "fresh_keys" };
    if (err instanceof ApiError) return { kind: "error", reason: err.status < 500 ? "rejected" : "failed" };
    return { kind: "error", reason: "failed" };
  }
};

/** After enrolment: the computers to trust, then a passkey where the platform allows it. */
const finish = async (
  d: EnrollDeps,
  keys: DeviceKeys,
  enrolled: { customToken: string; deviceId: string },
  now: () => number,
): Promise<EnrollResult> => {
  if (enrolled.deviceId !== keys.deviceId) return { ok: false, reason: "failed" };

  // Best effort: an unreadable directory only means the next connect picks the computers up.
  let agents: string[] = [];
  if (d.introduce) {
    try {
      const found = await accountAgents(await d.introduce.directory());
      if (found.length) agents = await d.introduce.trust(keys, found, SIGN_IN_INTRODUCER);
    } catch {
      agents = [];
    }
  }

  // Passkey right after, where available. Not having one is fine: the panel then asks the
  // person to approve HIGH/CRITICAL actions from their phone.
  let passkey: PasskeyOutcome = "unavailable";
  let credential: { credentialId: string; rpId: string } | null = null;
  const httpsOrigin = (d.origin ?? globalThis.location?.origin ?? "").startsWith("https://");
  if (httpsOrigin && (await d.platformAuthenticator())) {
    try {
      const cred = await registerPasskey(
        await d.deviceApi(enrolled.customToken),
        await d.signer(keys),
        d.ceremonies,
        now,
      );
      passkey = "enrolled";
      credential = { credentialId: cred.credentialId, rpId: cred.rpId };
    } catch {
      passkey = "failed";
    }
  }
  return {
    ok: true,
    deviceId: enrolled.deviceId,
    customToken: enrolled.customToken,
    passkey,
    credential,
    agents,
  };
};
