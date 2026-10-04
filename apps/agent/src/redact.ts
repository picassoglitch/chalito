/**
 * Redaction lives in @chalito/redact (shared with every service, R-M9); the agent adds the
 * DeviceEvent sanitizer.
 */
import { redactDeep } from "@chalito/redact";

export { createLogger, redact, redactDeep, redactError, type Logger } from "@chalito/redact";

/** Fixed-format DeviceEvent fields that redaction must not touch. */
const DEVICE_EVENT_VERBATIM = new Set(["v", "type", "deviceId", "policyHash", "t"]);
export const DEVICE_EVENT_MAX_STRING = 64;

const capStrings = (v: unknown, max: number): unknown => {
  if (typeof v === "string") return v.slice(0, max);
  if (Array.isArray(v)) return v.map((x) => capStrings(x, max));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x, max)]));
  return v;
};

/**
 * DeviceEvents land in plaintext (`lastEvent`, the audit trail) and some fields echo remote
 * input, e.g. `attempted`. Redact first, then cap, so a cut can't leave half a secret behind.
 */
export const sanitizeDeviceEvent = <T extends object>(e: T): T =>
  Object.fromEntries(
    Object.entries(e).map(([k, v]) => [
      k,
      DEVICE_EVENT_VERBATIM.has(k) ? v : capStrings(redactDeep(v), DEVICE_EVENT_MAX_STRING),
    ]),
  ) as T;
