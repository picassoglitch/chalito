import { ensureSession, type BrowserAuth } from "@chalito/client";
import { SsoExchangeResponse } from "@chalito/protocol";
import { safeNextPath } from "@chalito/ui";

/**
 * Desktop sign-in through the hub (ADR 0016), in the system browser, never in a webview:
 *
 *   1. `begin()` makes a state nonce bound to THIS launch (memory only, 10 min) and the URL
 *      to open: the SSO start URL + `client=desktop&state=…&redirect_uri=…`.
 *   2. The browser comes back to `chalito://auth/sso?token=…&state=…&next=…` (installed
 *      builds; in `tauri dev` a debug-only loopback turns its request into the same URL).
 *   3. `accept(url)` rejects anything that isn't exactly that, or whose state isn't the
 *      pending one. A matching state is consumed (single use) whatever happens next.
 *   4. `exchange(token)` posts the hub token to the api's /sso/exchange (single use there
 *      too) and opens the person's Supabase session with the returned magic-link hash.
 *
 * The token is never logged, stored or put in an error message.
 */

export const SSO_TTL_MS = 10 * 60 * 1000;
export const CALLBACK = { protocol: "chalito:", host: "auth", path: "/sso" } as const;

export type AcceptError =
  "malformed" | "wrong_target" | "no_pending" | "state_mismatch" | "expired" | "duplicate_param" | "missing_token";

export type AcceptResult = { ok: true; token: string; next: string } | { ok: false; reason: AcceptError };

export type ExchangeError = "exchange_failed" | "token_replayed" | "bad_response" | "verify_failed";
export type ExchangeResult = { ok: true; owner: string } | { ok: false; reason: ExchangeError };

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const newState = (random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))) =>
  b64url(random(32));

interface Pending {
  state: string;
  expiresAt: number;
}

export class SsoFlow {
  #pending: Pending | null = null;

  constructor(
    private readonly startUrl: string,
    private readonly opts: { now?: () => number; random?: (n: number) => Uint8Array } = {},
  ) {
    const u = new URL(startUrl);
    if (u.protocol !== "https:") throw new Error("SSO start URL must be https");
  }

  get pending(): boolean {
    return this.#pending !== null;
  }

  /** A new launch replaces any earlier one (its link will no longer be accepted). */
  begin(redirectUri = "chalito://auth/sso"): { state: string; url: string } {
    const state = newState(this.opts.random);
    this.#pending = { state, expiresAt: this.#now() + SSO_TTL_MS };
    return { state, url: this.#launchUrl(state, redirectUri) };
  }

  /** Same, when the redirect depends on the state (the dev loopback binds to it first). */
  async beginWith(redirectFor: (state: string) => Promise<string>): Promise<{ state: string; url: string }> {
    const { state } = this.begin();
    const redirect = await redirectFor(state);
    return { state, url: this.#launchUrl(state, redirect) };
  }

  #launchUrl(state: string, redirectUri: string): string {
    const url = new URL(this.startUrl);
    url.searchParams.set("client", "desktop");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", redirectUri);
    return url.toString();
  }

  cancel(): void {
    this.#pending = null;
  }

  accept(raw: string): AcceptResult {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (
      u.protocol !== CALLBACK.protocol ||
      u.host !== CALLBACK.host ||
      u.pathname !== CALLBACK.path ||
      u.username ||
      u.password ||
      u.hash
    )
      return { ok: false, reason: "wrong_target" };
    const p = u.searchParams;
    for (const k of ["token", "state", "next"])
      if (p.getAll(k).length > 1) return { ok: false, reason: "duplicate_param" };
    const pending = this.#pending;
    if (!pending) return { ok: false, reason: "no_pending" };
    // A forged link with another state must not cancel the real sign-in: keep it pending.
    if (p.get("state") !== pending.state) return { ok: false, reason: "state_mismatch" };
    this.#pending = null;
    if (this.#now() > pending.expiresAt) return { ok: false, reason: "expired" };
    const token = p.get("token");
    if (!token) return { ok: false, reason: "missing_token" };
    return { ok: true, token, next: safeNextPath(p.get("next")) };
  }

  #now(): number {
    return (this.opts.now ?? Date.now)();
  }
}

/** The api's /sso/exchange (single use server-side), then the person's session. */
export const exchange = async (
  token: string,
  deps: { apiBase: string; fetch: typeof fetch; auth: BrowserAuth },
): Promise<ExchangeResult> => {
  let res: Response;
  try {
    res = await deps.fetch(`${deps.apiBase}/sso/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "omit",
    });
  } catch {
    return { ok: false, reason: "exchange_failed" };
  }
  if (res.status === 409) return { ok: false, reason: "token_replayed" };
  if (!res.ok) return { ok: false, reason: "exchange_failed" };
  const body = SsoExchangeResponse.safeParse(await res.json().catch(() => null));
  if (!body.success) return { ok: false, reason: "bad_response" };
  try {
    // A launch is always for the person the hub just authenticated: ensureSession drops any
    // other stored session first.
    await ensureSession(deps.auth, { kind: "sso", exchange: async () => ({ token_hash: body.data.customToken }) });
  } catch {
    return { ok: false, reason: "verify_failed" };
  }
  return { ok: true, owner: body.data.owner };
};
