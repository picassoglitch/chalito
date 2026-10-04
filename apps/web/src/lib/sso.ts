import type { SupabaseClient } from "@supabase/supabase-js";
import { safeNextPath } from "@chalito/ui";

export type SsoResult =
  { ok: true; next: string } | { ok: false; reason: "missing_token" | "exchange_failed" | "verify_failed" };

/**
 * /auth/sso (ADR 0016): the hub's launch token goes to the api, which verifies it and
 * returns a one-time Supabase magic-link `token_hash` for the person's own hub account
 * (`customToken`). verifyOtp turns that into a browser session. `next` is relative-only.
 */
export const completeSso = async (
  params: { token: string | null; next: string | null },
  deps: { apiBase: string; fetch: typeof fetch; supabase: Pick<SupabaseClient, "auth"> },
): Promise<SsoResult> => {
  if (!params.token) return { ok: false, reason: "missing_token" };
  let tokenHash: string;
  try {
    const res = await deps.fetch(`${deps.apiBase}/sso/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: params.token }),
      credentials: "omit",
    });
    if (!res.ok) return { ok: false, reason: "exchange_failed" };
    const body = (await res.json()) as { customToken?: unknown };
    if (typeof body.customToken !== "string" || !body.customToken) return { ok: false, reason: "exchange_failed" };
    tokenHash = body.customToken;
  } catch {
    return { ok: false, reason: "exchange_failed" };
  }
  const { error } = await deps.supabase.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
  if (error) return { ok: false, reason: "verify_failed" };
  return { ok: true, next: safeNextPath(params.next) };
};
