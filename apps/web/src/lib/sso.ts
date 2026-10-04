import { ensureSession, type BrowserAuth } from "@chalito/client";
import { safeNextPath } from "@chalito/ui";

export type SsoResult =
  { ok: true; next: string } | { ok: false; reason: "missing_token" | "exchange_failed" | "verify_failed" };

/**
 * /auth/sso (ADR 0016): the hub's launch token goes to the api, which verifies it and returns
 * a one-time magic-link `{token_hash}` for the person's own hub account; packages/client's
 * `ensureSession` turns it into a browser session. Any session already in this browser is
 * signed out first: a launch is always for the person the hub just authenticated.
 * `next` is relative-only.
 */
export const completeSso = async (
  params: { token: string | null; next: string | null },
  deps: { apiBase: string; fetch: typeof fetch; auth: BrowserAuth },
): Promise<SsoResult> => {
  if (!params.token) return { ok: false, reason: "missing_token" };
  let exchangeFailed = false;
  try {
    // Local scope: clear this browser only (no network call, other devices keep their sessions).
    await (deps.auth.signOut as ((o: { scope: "local" }) => Promise<unknown>) | undefined)?.({ scope: "local" });
    await ensureSession(deps.auth, {
      kind: "sso",
      exchange: async () => {
        try {
          const res = await deps.fetch(`${deps.apiBase}/sso/exchange`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: params.token }),
            credentials: "omit",
          });
          const body = (res.ok ? await res.json() : null) as { token_hash?: unknown } | null;
          if (typeof body?.token_hash !== "string" || !body.token_hash) throw new Error("exchange");
          return { token_hash: body.token_hash };
        } catch (err) {
          exchangeFailed = true;
          throw err;
        }
      },
    });
  } catch {
    return { ok: false, reason: exchangeFailed ? "exchange_failed" : "verify_failed" };
  }
  return { ok: true, next: safeNextPath(params.next) };
};
