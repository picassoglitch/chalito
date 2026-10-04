import { createHmac, timingSafeEqual } from "node:crypto";
import { HubSsoPayload } from "@chalito/protocol";

const B64URL = /^[A-Za-z0-9_-]+$/;
/** HMAC-SHA256 (32 bytes) in unpadded base64url. */
const SIG_LEN = 43;

export type SsoResult =
  | { ok: true; payload: HubSsoPayload; sigHash: string }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "bad_payload" };

/**
 * Verifies a Chalyb hub launch token: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
 * `exp` is in seconds (hub factory). `sigHash` identifies the token for single-use tracking.
 */
export const verifySsoToken = (token: string, secret: string, nowMs: number): SsoResult => {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [body, sig] = parts as [string, string];
  // Canonical base64url only: Node's decoder ignores stray characters, padding and the last
  // character's spare bits, so `t + "="` or a different final character would decode to the
  // same signature under a new string (review R-H2). Re-encoding must give back the input.
  if (!B64URL.test(body) || !B64URL.test(sig) || sig.length !== SIG_LEN) return { ok: false, reason: "malformed" };
  const given = Buffer.from(sig, "base64url");
  if (given.toString("base64url") !== sig) return { ok: false, reason: "malformed" };
  const expected = createHmac("sha256", secret).update(body).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: "bad_signature" };
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = HubSsoPayload.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "bad_payload" };
  if (parsed.data.exp * 1000 <= nowMs) return { ok: false, reason: "expired" };
  // The single-use id comes from the verified bytes, never from how they were spelled.
  return {
    ok: true,
    payload: parsed.data,
    sigHash: createHmac("sha256", "chalito.sso.jti").update(given).digest("hex"),
  };
};

const NEXT_BASE = "https://chalito.invalid";
const hasControl = (s: string) => [...s].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

/**
 * Validates a post-SSO redirect: a same-origin relative path only (no open redirect, review R-M1).
 * Checked BEFORE and AFTER URL normalisation, because dot segments ("/.//evil.com",
 * "/%2e//evil.com", "/a/..//evil.com") only become protocol-relative ("//evil.com") once
 * normalised. No backslashes, control characters or encoded slashes/backslashes at all.
 */
export const safeNextPath = (next: string | null | undefined): string => {
  if (!next || !next.startsWith("/") || next.length > 2048) return "/";
  if (next.includes("\\") || /%(2f|5c)/i.test(next) || hasControl(next)) return "/";
  if (next.startsWith("//")) return "/";
  let u: URL;
  try {
    u = new URL(next, NEXT_BASE);
  } catch {
    return "/";
  }
  if (u.origin !== NEXT_BASE) return "/";
  // After normalisation: exactly one leading slash.
  if (!u.pathname.startsWith("/") || u.pathname.startsWith("//")) return "/";
  return `${u.pathname}${u.search}${u.hash}`;
};

/** Stable per-tenant token returned on create and on 409 (no secret storage needed). */
export const tenantApiToken = (adminToken: string, tenantId: string): string =>
  createHmac("sha256", adminToken).update(`tenant:${tenantId}`).digest("base64url");
