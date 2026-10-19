import type {
  ApiClient,
  Ceremonies,
  DeviceKeys,
  DeviceSigner,
  DirectoryDevice,
  DroppedAgent,
} from "@chalito/client-keys";
import {
  ApiError,
  accountAgents,
  enrollEndorsed,
  enrollSignedIn,
  generateDeviceKeys,
  introducedAgents,
  registerPasskey,
  signDeviceRegistration,
} from "@chalito/client-keys";
import { EndorsementUnavailableError, endorsementMatches, type EndorsementChannel } from "@chalito/client";
import type { DeviceRegistration, Endorsement, IntroducedAgent } from "@chalito/protocol";

export {
  EndorsementUnavailableError,
  endorsementMatches,
  unavailableEndorsement,
  type EndorsementChannel,
} from "@chalito/client";

/**
 * Making this desktop panel a trusted client. Owner decision 2026-10-19 ("sign-in alone"): the
 * person's hub sign-in enrols it (/v1/devices/signin) and it trusts the account's computers from
 * the directory. The endorsement steps below are only the fallback for an api without that route.
 * It is a browser client like any other:
 *   1. the person is signed in (hub SSO → their own session: `user` routes);
 *   2. the panel has device keys (client-keys: libsodium in IndexedDB, wrapped by a
 *      non-extractable WebCrypto key) and signs its own registration;
 *   3. an EXISTING trusted client endorses exactly those keys (the m5-keys "new browser"
 *      flow; the transport is `EndorsementChannel`);
 *   4. the panel posts {registration, endorsement} to /v1/devices/endorsed and gets its own
 *      device credential;
 *   5. a passkey is enrolled right after, where the platform allows it (never required).
 * Never through the agent's IPC: the agent must not mint client trust for itself.
 */

/** `endorsedBy` recorded for computers a sign-in client trusts from the account's directory. */
export const SIGN_IN_INTRODUCER = "sign_in";

export type EnrollError =
  | "channel_unavailable"
  | "cancelled"
  | "endorsement_mismatch"
  | "endorser_not_trusted"
  | "device_exists"
  | "rejected"
  | "failed";

export type PasskeyOutcome = "enrolled" | "unavailable" | "failed";

export type EnrollResult =
  | {
      ok: true;
      deviceId: string;
      customToken: string;
      passkey: PasskeyOutcome;
      /** Public identifiers of the enrolled passkey (for step-up), or null. */
      credential: { credentialId: string; rpId: string } | null;
      /** ADR 0018: agents introduced by the endorsement and now trusted here. */
      agents: string[];
      /** Introduced agents refused (directory disagrees with the endorsement). */
      droppedAgents: DroppedAgent[];
    }
  | { ok: false; reason: EnrollError };

export interface EnrollDeps {
  owner: string;
  name: string;
  /** Stored keys, or null to generate and store a new identity. */
  keys: { load(): Promise<DeviceKeys | null>; save(k: DeviceKeys): Promise<void> };
  channel: EndorsementChannel;
  /** Authenticated as the person (hub session): /v1/devices/endorsed is a `user` route. */
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
  /**
   * ADR 0018: the account's devices directory and where to keep the agents the endorsement
   * introduced (after `introducedAgents` checked them). Without it no agent is trusted here
   * until a glyph pairing.
   */
  introduce?: {
    directory: () => Promise<DirectoryDevice[]>;
    trust: (keys: DeviceKeys, agents: IntroducedAgent[], endorsedBy: string) => Promise<string[]>;
  };
  onDisplay?: (display: unknown) => void;
  signal?: AbortSignal;
  now?: () => number;
}

const API_REASONS: Record<string, EnrollError> = {
  endorsement_mismatch: "endorsement_mismatch",
  endorser_not_trusted: "endorser_not_trusted",
  device_exists: "device_exists",
};

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

  // Owner decision 2026-10-19 ("sign-in alone"): the person's sign-in approves this computer's
  // panel. Only an api without /v1/devices/signin (404) falls back to the endorsement below.
  const bySignIn = await enrollBySignIn(d, keys, registration);
  if (bySignIn.kind === "fresh_keys") {
    // Keys left from an earlier attempt are taken (or were revoked): start over with new ones.
    keys = await generateDeviceKeys();
    await d.keys.save(keys);
    registration = await register(keys);
    const retry = await enrollBySignIn(d, keys, registration);
    if (retry.kind !== "enrolled")
      return { ok: false, reason: retry.kind === "error" ? retry.reason : "device_exists" };
    return finish(d, keys, retry.enrolled, null, registration, now);
  }
  if (bySignIn.kind === "error") return { ok: false, reason: bySignIn.reason };
  if (bySignIn.kind === "enrolled") return finish(d, keys, bySignIn.enrolled, null, registration, now);

  let session: Awaited<ReturnType<EndorsementChannel["open"]>>;
  try {
    session = await d.channel.open(registration);
  } catch (err) {
    return { ok: false, reason: err instanceof EndorsementUnavailableError ? "channel_unavailable" : "failed" };
  }
  d.onDisplay?.(session.display);
  let endorsement: Endorsement;
  try {
    endorsement = await new Promise<Endorsement>((resolve, reject) => {
      if (d.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
      d.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      session.endorsement.then(resolve, reject);
    });
  } catch {
    session.cancel();
    return { ok: false, reason: d.signal?.aborted ? "cancelled" : "failed" };
  }
  if (!endorsementMatches(endorsement, registration)) return { ok: false, reason: "endorsement_mismatch" };

  let enrolled: { customToken: string; deviceId: string };
  try {
    enrolled = await enrollEndorsed(d.userApi, { registration, endorsement });
  } catch (err) {
    if (err instanceof ApiError)
      return { ok: false, reason: API_REASONS[err.code] ?? (err.status < 500 ? "rejected" : "failed") };
    return { ok: false, reason: "failed" };
  }
  return finish(d, keys, enrolled, endorsement, registration, now);
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
  /** The endorsement it came with; null when the person's sign-in enrolled it. */
  endorsement: Endorsement | null,
  registration: DeviceRegistration,
  now: () => number,
): Promise<EnrollResult> => {
  if (enrolled.deviceId !== keys.deviceId) return { ok: false, reason: "failed" };

  // ADR 0018: the computers the endorser trusts, where the directory agrees; by sign-in, the
  // account's computers from the directory. Best effort: a failure here only means pairing each
  // computer by glyph later.
  let agents: string[] = [];
  let droppedAgents: DroppedAgent[] = [];
  if (d.introduce) {
    try {
      if (endorsement) {
        const check = await introducedAgents(
          endorsement,
          {
            uid: d.owner,
            deviceId: keys.deviceId,
            pubSign: registration.body.pubSign,
            pubBox: registration.body.pubBox,
          },
          await d.introduce.directory(),
        );
        if (check.ok) {
          droppedAgents = check.dropped;
          if (check.agents.length) agents = await d.introduce.trust(keys, check.agents, endorsement.signerDeviceId);
        }
      } else {
        const found = await accountAgents(await d.introduce.directory());
        if (found.length) agents = await d.introduce.trust(keys, found, SIGN_IN_INTRODUCER);
      }
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
    droppedAgents,
  };
};
