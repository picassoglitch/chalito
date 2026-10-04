import type { ApiClient, DeviceKeys, DeviceSigner, Ceremonies } from "@chalito/client-keys";
import {
  ApiError,
  enrollEndorsed,
  generateDeviceKeys,
  registerPasskey,
  signDeviceRegistration,
} from "@chalito/client-keys";
import { EndorsementUnavailableError, type EndorsementChannel } from "@chalito/client";
import type { DeviceRegistration, Endorsement } from "@chalito/protocol";

export { EndorsementUnavailableError, unavailableEndorsement, type EndorsementChannel } from "@chalito/client";

/**
 * Making this desktop panel a trusted client (decision: no special path; ADR 0006). It is a
 * browser client like any other:
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
  onDisplay?: (display: unknown) => void;
  signal?: AbortSignal;
  now?: () => number;
}

const API_REASONS: Record<string, EnrollError> = {
  endorsement_mismatch: "endorsement_mismatch",
  endorser_not_trusted: "endorser_not_trusted",
  device_exists: "device_exists",
};

/** The endorsement must vouch for exactly this account and these keys (the api checks too). */
export const endorsementMatches = (e: Endorsement, reg: DeviceRegistration): boolean =>
  e.body.uid === reg.body.owner &&
  e.body.newDeviceId === reg.body.deviceId &&
  e.body.pubSign === reg.body.pubSign &&
  e.body.pubBox === reg.body.pubBox;

export const enrollDesktop = async (d: EnrollDeps): Promise<EnrollResult> => {
  const now = d.now ?? Date.now;
  let keys = await d.keys.load();
  if (!keys) {
    keys = await generateDeviceKeys();
    await d.keys.save(keys);
  }
  const registration = await signDeviceRegistration(keys, {
    owner: d.owner,
    // The protocol's client kinds are phone | web: the panel is a web client in a webview.
    kind: "web",
    platform: "web",
    name: d.name,
    now: now(),
  });

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
  if (enrolled.deviceId !== keys.deviceId) return { ok: false, reason: "failed" };

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
  return { ok: true, deviceId: enrolled.deviceId, customToken: enrolled.customToken, passkey, credential };
};
