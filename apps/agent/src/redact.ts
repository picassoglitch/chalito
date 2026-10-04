/**
 * Redaction for logs, cards and call lines: API keys and tokens, emails, phone numbers.
 * Logs never carry tokens, keys or full phone numbers (brief §1).
 */
const RULES: [RegExp, string][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-…"],
  [/\bsk-(proj-)?[A-Za-z0-9_-]{16,}/g, "sk-…"],
  [/\bxai-[A-Za-z0-9_-]{16,}/g, "xai-…"],
  [/\bek_[A-Za-z0-9_-]{8,}/g, "ek_…"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza…"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh…"],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "AKIA…"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<jwt>"],
  [/(?<bearer>Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$<bearer>…"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<private key>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
];

// E.164-ish (+52 55 1234 5678, +1 (415) 555-0100) or a bare 10–15 digit run.
const PHONE = /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}|\b\d{10,15}\b/g;

export const redact = (text: string): string => {
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out.replace(PHONE, (m) => `…${m.replace(/\D/g, "").slice(-2)}`);
};

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Redacts every string inside a value (numbers and structure untouched). */
export const redactDeep = (v: unknown): unknown => {
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
};

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

/** JSON-lines logger that redacts every string it writes. */
export const createLogger = (write: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): Logger => {
  const log = (level: string, msg: string, meta?: Record<string, unknown>) =>
    write(
      JSON.stringify({
        t: new Date().toISOString(),
        level,
        msg: redact(msg),
        ...(meta ? (redactDeep(meta) as object) : {}),
      }),
    );
  return { info: (m, x) => log("info", m, x), warn: (m, x) => log("warn", m, x), error: (m, x) => log("error", m, x) };
};
