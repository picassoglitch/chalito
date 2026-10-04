import {
  EndorseCodeExpiredError,
  EndorseFailedError,
  EndorsementUnavailableError,
  endorsementChannel,
  endorsementMatches,
  type EndorseDisplay,
  type EndorseWatch,
} from "@chalito/client";
import {
  ApiError,
  EndorseError,
  approveEndorsement,
  endorseGlyph,
  enrollEndorsed,
  generateDeviceKeys,
  resolveForEndorsement,
  signDeviceRegistration,
  type ApiClient,
  type DeviceKeys as RawDeviceKeys,
  type DeviceSigner,
  type EndorseTarget,
  type StepUpAssertion,
  type TrustedAgent,
  type DirectoryDevice,
  type DroppedAgent,
  introducedAgents,
} from "@chalito/client-keys";
import { fingerprint } from "@chalito/crypto";
import { normalizeShortCode } from "@chalito/glyph";
import type { DeviceRegistration, Endorsement, IntroducedAgent } from "@chalito/protocol";

/**
 * Adding a browser to the account (ADR 0006, /v1/endorse). Two screens, one per side:
 *
 *  - "Esperando aprobación" (this browser is new: signed in as the person, not yet trusted). It
 *    makes a fresh device identity, publishes its self-signed registration, shows the short code
 *    and the glyph it signed, waits for a trusted device's endorsement, then enrols with
 *    /v1/devices/endorsed and from then on signs in as itself.
 *  - "Añadir un dispositivo" (this browser is trusted): resolve the code typed or scanned, show
 *    the fingerprint to compare, then sign the endorsement for exactly those keys (with a passkey
 *    step-up when this device has one).
 *
 * An endorsed browser can approve right away; agents verify the endorsement locally. Sending
 * prompts to an agent still needs that agent's key, confirmed by pairing with its glyph.
 */

export type WaitError =
  | "expired"
  | "cancelled"
  | "unavailable"
  | "endorsement_mismatch"
  | "endorser_not_trusted"
  | "device_exists"
  | "rejected"
  | "failed";

/**
 * ADR 0018: the computers the endorsing device introduced. `trusted` can be prompted right away;
 * `dropped` didn't check out against the devices directory and need pairing by their ring.
 */
export interface Introduced {
  trusted: { deviceId: string; name: string }[];
  dropped: { deviceId: string; name: string; reason: DroppedAgent["reason"] }[];
}

export type WaitResult =
  { ok: true; deviceId: string; customToken: string; introduced: Introduced } | { ok: false; reason: WaitError };

/** A devices-directory row as the new browser reads it (RLS, the person's session). */
export type DirectoryRow = DirectoryDevice & { name: string };

export interface Waiting {
  display: EndorseDisplay;
  /** This browser's key fingerprint: the trusted device shows the same one before approving. */
  fingerprint: string;
  result: Promise<WaitResult>;
  cancel(): void;
}

export interface NewDeviceDeps {
  /** Authenticated as the person (hub session): /v1/endorse/codes, /take and /v1/devices/endorsed are `user` routes. */
  api: ApiClient;
  watch: EndorseWatch;
  /** Stores the new identity (replacing any old one, and the agents it trusted). */
  save(keys: RawDeviceKeys): Promise<void>;
  owner: string;
  /** What the trusted device shows, e.g. "Chrome en Mac". */
  name: string;
  now?: () => number;
  generate?: () => Promise<RawDeviceKeys>;
  pollMs?: number;
  /** The account's devices (ADR 0018: introduced agents are checked against it). */
  directory?: () => Promise<DirectoryRow[]>;
  /** Stores the vetted introduced agents in this browser's trust list. */
  trustIntroduced?: (keys: RawDeviceKeys, agents: IntroducedAgent[], endorsedBy: string) => Promise<void>;
}

const NO_INTRO: Introduced = { trusted: [], dropped: [] };

/**
 * Best effort: vet the endorser's computers against the directory and trust those that check out.
 * Any failure just means pairing computers by their ring later.
 */
const introduce = async (
  d: NewDeviceDeps,
  keys: RawDeviceKeys,
  registration: DeviceRegistration,
  endorsement: Endorsement,
): Promise<Introduced> => {
  if (!d.directory || !d.trustIntroduced || !endorsement.body.agents?.length) return NO_INTRO;
  try {
    const dir = await d.directory();
    const check = await introducedAgents(
      endorsement,
      { uid: d.owner, deviceId: keys.deviceId, pubSign: registration.body.pubSign, pubBox: registration.body.pubBox },
      dir,
    );
    if (!check.ok) return NO_INTRO;
    if (check.agents.length) await d.trustIntroduced(keys, check.agents, endorsement.signerDeviceId);
    const name = (id: string) => dir.find((r) => r.deviceId === id)?.name ?? id.slice(0, 8);
    return {
      trusted: check.agents.map((a) => ({ deviceId: a.deviceId, name: name(a.deviceId) })),
      dropped: check.dropped.map((x) => ({ deviceId: x.deviceId, name: name(x.deviceId), reason: x.reason })),
    };
  } catch {
    return NO_INTRO;
  }
};

const ENROL_REASONS: Record<string, WaitError> = {
  endorsement_mismatch: "endorsement_mismatch",
  endorser_not_trusted: "endorser_not_trusted",
  device_exists: "device_exists",
};

const waitReason = (err: unknown): WaitError => {
  if (err instanceof EndorseCodeExpiredError) return "expired";
  if (err instanceof EndorseFailedError) return err.code === "cancelled" ? "cancelled" : "failed";
  return "failed";
};

/** New browser: open a code and wait. Rejects only when no code could be opened. */
export const waitForEndorsement = async (d: NewDeviceDeps): Promise<Waiting | { error: WaitError }> => {
  const now = d.now ?? Date.now;
  // Always a fresh identity: a revoked one must not come back, and an unregistered leftover is
  // worth nothing. Saved before the code opens, so the enrolled device always has its keys.
  const keys = await (d.generate ?? generateDeviceKeys)();
  let registration: DeviceRegistration;
  try {
    await d.save(keys);
    registration = await signDeviceRegistration(keys, {
      owner: d.owner,
      kind: "web",
      platform: "web",
      name: d.name.slice(0, 40),
      now: now(),
    });
  } catch {
    return { error: "failed" };
  }
  const channel = endorsementChannel({
    api: d.api,
    watch: d.watch,
    glyphFor: (code) => endorseGlyph(keys, code, { label: d.name, now: now() }),
    ...(d.pollMs ? { pollMs: d.pollMs } : {}),
    now,
  });
  let session: Awaited<ReturnType<typeof channel.open>>;
  try {
    session = await channel.open(registration);
  } catch (err) {
    return { error: err instanceof EndorsementUnavailableError ? "unavailable" : "failed" };
  }
  const result = (async (): Promise<WaitResult> => {
    let endorsement: Endorsement;
    try {
      endorsement = await session.endorsement;
    } catch (err) {
      return { ok: false, reason: waitReason(err) };
    }
    if (!endorsementMatches(endorsement, registration)) return { ok: false, reason: "endorsement_mismatch" };
    try {
      const r = await enrollEndorsed(d.api, { registration, endorsement });
      if (r.deviceId !== keys.deviceId) return { ok: false, reason: "failed" };
      const introduced = await introduce(d, keys, registration, endorsement);
      return { ok: true, deviceId: r.deviceId, customToken: r.customToken, introduced };
    } catch (err) {
      if (err instanceof ApiError)
        return { ok: false, reason: ENROL_REASONS[err.code] ?? (err.status < 500 ? "rejected" : "failed") };
      return { ok: false, reason: "failed" };
    }
  })();
  return {
    display: session.display as EndorseDisplay,
    fingerprint: await fingerprint(keys.sign.publicKey),
    result,
    cancel: session.cancel,
  };
};

/** What the trusted side shows for an error (EndorseError codes, local and api). */
export type AddError =
  | "invalid_code"
  | "not_found"
  | "expired"
  | "wrong_account"
  | "same_device"
  | "already_endorsed"
  | "step_up"
  | "not_trusted"
  | "tampered"
  | "passkey_cloned"
  | "failed";

const ADD_REASONS: Record<string, AddError> = {
  malformed: "invalid_code",
  wrong_purpose: "invalid_code",
  not_found: "not_found",
  expired: "expired",
  not_yet_valid: "invalid_code",
  owner_mismatch: "wrong_account",
  self_endorsement: "same_device",
  already_endorsed: "already_endorsed",
  step_up_required: "step_up",
  step_up_failed: "step_up",
  endorser_not_trusted: "not_trusted",
  signer_mismatch: "not_trusted",
  bad_signature: "tampered",
  key_mismatch: "tampered",
  device_id_mismatch: "tampered",
  bad_registration: "tampered",
  code_mismatch: "tampered",
  endorsement_mismatch: "tampered",
  stale_endorsement: "failed",
  authenticator_cloned: "passkey_cloned",
};

export const addReason = (err: unknown): AddError => {
  if (err instanceof EndorseError) return ADD_REASONS[err.code] ?? "failed";
  if ((err as { name?: string } | null)?.name === "NotAllowedError") return "step_up";
  return "failed";
};

export type Resolved = { ok: true; target: EndorseTarget } | { ok: false; reason: AddError };

/** Trusted browser: a scanned glyph or a typed short code → what the person compares. */
export const resolveTarget = async (
  api: ApiClient,
  input: { glyph: unknown } | { shortCode: string },
  now: number,
): Promise<Resolved> => {
  if ("shortCode" in input) {
    const code = normalizeShortCode(input.shortCode);
    if (!code) return { ok: false, reason: "invalid_code" };
    input = { shortCode: code };
  }
  try {
    return { ok: true, target: await resolveForEndorsement(api, input, now) };
  } catch (err) {
    return { ok: false, reason: addReason(err) };
  }
};

/** Trusted browser, after the person compared the fingerprint. */
export const approveTarget = async (
  api: ApiClient,
  signer: DeviceSigner,
  target: EndorseTarget,
  /** `stepUp`: this device's passkey, signing the endorsement body itself (R-L13). */
  o: { owner: string; now: number; stepUp?: StepUpAssertion; agents?: readonly TrustedAgent[] },
): Promise<{ ok: true } | { ok: false; reason: AddError }> => {
  try {
    await approveEndorsement(api, signer, target, {
      uid: o.owner,
      now: o.now,
      ...(o.stepUp ? { stepUp: o.stepUp } : {}),
      // ADR 0018: introduce this browser's glyph-confirmed computers to the new one.
      ...(o.agents ? { agents: o.agents } : {}),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: addReason(err) };
  }
};

/** A readable default name for this browser ("Chrome en Mac"); the person can edit it. */
export const browserName = (ua: string, locale: string): string => {
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : null;
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "Mac"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  const on = locale === "en" ? "on" : "en";
  if (browser && os) return `${browser} ${on} ${os}`;
  return browser ?? os ?? (locale === "en" ? "Browser" : "Navegador");
};
