import { createHmac, timingSafeEqual } from "node:crypto";
import { HubSsoPayload } from "@chalito/protocol";

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
  const expected = createHmac("sha256", secret).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
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
  return { ok: true, payload: parsed.data, sigHash: createHmac("sha256", "chalito.sso.jti").update(sig).digest("hex") };
};

/** Validates a post-SSO redirect: same-origin relative path only (no open redirect). */
export const safeNextPath = (next: string | null | undefined): string => {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || /[\r\n]/.test(next))
    return "/";
  try {
    const u = new URL(next, "https://chalito.invalid");
    return u.origin === "https://chalito.invalid" ? `${u.pathname}${u.search}${u.hash}` : "/";
  } catch {
    return "/";
  }
};

/** Stable per-tenant token returned on create and on 409 (no secret storage needed). */
export const tenantApiToken = (adminToken: string, tenantId: string): string =>
  createHmac("sha256", adminToken).update(`tenant:${tenantId}`).digest("base64url");
