import {
  EndorseError,
  approveEndorsement,
  resolveForEndorsement,
  type ApiClient,
  type DeviceSigner,
  type EndorseTarget,
  type StepUpAssertion,
  type TrustedAgent,
  type DirectoryDevice,
} from "@chalito/client-keys";
import { normalizeShortCode } from "@chalito/glyph";

/**
 * "Añadir un dispositivo" (ADR 0006, /v1/endorse): a trusted browser endorses another one's keys.
 * New browsers approve themselves by sign-in (ADR 0032); this stays for older apps that show a code.
 */
/** A devices-directory row as the browser reads it (RLS, the person's session). */
export type DirectoryRow = DirectoryDevice & { name: string };

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
