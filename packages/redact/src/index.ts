/**
 * Redaction shared by every Chalito service and the agent (R-M9): API keys and tokens, secrets in
 * `key=value` / JSON pairs and URL parameters, emails, phone numbers. It filters session cards,
 * call lines and device events (agent) and every log line a service writes (`createLogger`,
 * `installConsoleRedaction`). Logs never carry tokens, keys or full phone numbers (brief §1).
 */
const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<private key>"],
  // Provider keys and tokens, by their documented prefixes.
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-…"],
  [/\bsk-(proj-)?[A-Za-z0-9_-]{16,}/g, "sk-…"],
  [/\b[sr]k_(live|test)_[A-Za-z0-9]{8,}/g, "sk_…"], // Stripe secret and restricted keys
  [/\bwhsec_[A-Za-z0-9+/=_-]{8,}/g, "whsec_…"],
  [/\bxai-[A-Za-z0-9_-]{16,}/g, "xai-…"],
  [/\bek_[A-Za-z0-9_-]{8,}/g, "ek_…"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza…"],
  [/\bya29\.[A-Za-z0-9_-]{10,}/g, "ya29.…"], // Google OAuth access tokens
  [/(?<![\w/])1\/\/[A-Za-z0-9_-]{20,}/g, "1//…"], // Google OAuth refresh tokens
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_…"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh…"],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, "glpat-…"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "xox…"], // Slack
  [/\bnpm_[A-Za-z0-9]{20,}/g, "npm_…"],
  [/\bsb_(secret|publishable)_[A-Za-z0-9_-]{10,}/g, "sb_…"], // Supabase
  [/\bEAA[A-Za-z0-9]{20,}/g, "EAA…"], // Meta (WhatsApp) access tokens
  [/\bSK[0-9a-f]{32}\b/g, "SK…"], // Twilio API keys
  [/\bchalito_(at|rt|ac)_[A-Za-z0-9_-]{16,}/g, "chalito_$1_…"], // Chalito's own OAuth secrets
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "AKIA…"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<jwt>"],
  [/(?<bearer>Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$<bearer>…"],
  [/(?<basic>Basic\s+)[A-Za-z0-9+/]{8,}=*/g, "$<basic>…"],
  // Secrets by name: key=value, key: value and "key": "value" (Twilio auth tokens have no prefix).
  [
    /(?<k>["']?\b[\w.-]*(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|pwd|auth[_-]?token|credential|private[_-]?key|signature)["']?\s*[:=]\s*["']?)(?<v>[^\s"'&,;}]{4,})/gi,
    "$<k>…",
  ],
  // Secrets in URLs.
  [/(?<q>[?&](?:token|code|access_token|refresh_token|id_token|key|sig|signature|secret)=)[^&#\s"']+/gi, "$<q>…"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
];

// E.164-ish (+52 55 1234 5678, +1 (415) 555-0100) or a bare 10–15 digit run.
const PHONE = /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}|\b\d{10,15}\b/g;

export const redact = (text: string): string => {
  let out = text;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out.replace(PHONE, (m) => `…${m.replace(/\D/g, "").slice(-2)}`);
};

/**
 * A property whose NAME says it holds a secret. Its string value is dropped whole: a bare value
 * (a Twilio auth token, a hub api_token, a magic-link hash) has no prefix the RULES could spot.
 */
const SECRET_KEY =
  /^(?:authorization|cookie|set-cookie|.*(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|pwd|credential|private[_-]?key|signature))$/i;

/** A rule that recognised the value keeps its hint ("sk-ant-…"); anything else goes whole. */
const secretValue = (x: string) => {
  const r = redact(x);
  return r !== x ? r : "…";
};

/** Redacts every string inside a value (numbers and structure untouched). Cycles become "[Circular]". */
export const redactDeep = (v: unknown, seen: WeakSet<object> = new WeakSet()): unknown => {
  if (typeof v === "string") return redact(v);
  if (v instanceof Error) return redactError(v);
  if (!v || typeof v !== "object") return v;
  // A cycle used to recurse until the stack overflowed, so the log call itself threw.
  if (seen.has(v)) return "[Circular]";
  seen.add(v);
  try {
    if (Array.isArray(v)) return v.map((x) => redactDeep(x, seen));
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        typeof x === "string" && SECRET_KEY.test(k) ? secretValue(x) : redactDeep(x, seen),
      ]),
    );
  } finally {
    // Only ancestors make a cycle: the same object twice side by side is printed twice.
    seen.delete(v);
  }
};

/** An error as loggable data: redacted name, message and (trimmed) stack; never the raw object. */
export const redactError = (err: unknown): { name: string; message: string; stack?: string } => {
  if (!(err instanceof Error)) return { name: "Error", message: redact(String(err)).slice(0, 500) };
  return {
    name: err.name,
    message: redact(err.message).slice(0, 500),
    ...(err.stack ? { stack: redact(err.stack).split("\n").slice(0, 8).join("\n") } : {}),
  };
};

/** A loggable error message: redacted and capped. */
export const errorMessage = (err: unknown) => redactError(err).message;

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

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

/**
 * The log sanitizer for services: console.log/info/warn/error/debug redact every argument before
 * writing (strings, objects, errors), so a stray `console.error(err)` can't leak a secret.
 * Idempotent; call once at process start.
 */
export const installConsoleRedaction = (c: Console = console) => {
  const marked = c as Console & { __chalitoRedacted?: true };
  if (marked.__chalitoRedacted) return;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = c[level].bind(c);
    c[level] = (...args: unknown[]) => original(...args.map((a) => redactDeep(a)));
  }
  marked.__chalitoRedacted = true;
};
