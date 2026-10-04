import { createClient } from "@supabase/supabase-js";
import { ApiRequestError, type MintToken, type TokenSource } from "./cloud.js";
import type { Logger } from "./redact.js";
import type { SecretStore } from "./secrets.js";

/**
 * Device credentials as a Supabase Auth user per device (owner decision, ADR 0017 §Tokens
 * option C; claims in app_metadata.chalito).
 *
 * - Sign-in: Chalito's API verifies the Ed25519 challenge as before and answers with a
 *   magic-link `token_hash` for this device's Auth user (`/v1/devices/token` → customToken).
 *   The agent exchanges it with `auth.verifyOtp({token_hash, type: "magiclink"})`.
 * - The session (refresh token included) lives in the OS keychain under "supabase-refresh",
 *   through a SecretStore-backed auth storage; never in a plaintext file.
 * - supabase-js refreshes the access token on its own. Every new access token is handed to
 *   listeners (the cloud passes it to `realtime.setAuth`).
 * - When the session can't be refreshed (the user was banned or revoked, or the refresh
 *   token is gone), the agent logs in again with a fresh signed challenge. If the API
 *   refuses that too (device_revoked), DeviceRevokedError: the daemon stops.
 */

/** SecretStore name of the persisted Supabase Auth session (refresh token inside). */
export const SUPABASE_SESSION_SECRET = "supabase-refresh";

export class DeviceRevokedError extends Error {
  override name = "DeviceRevokedError";
  constructor() {
    super("This computer was removed from your Chalito account (device revoked). Run `chalito pair` to add it again.");
  }
}

interface AuthSession {
  access_token: string;
}
interface AuthError {
  message: string;
  status?: number;
}

/** The slice of supabase-js `auth` used here (a fake in tests). */
export interface AuthLike {
  verifyOtp(p: { token_hash: string; type: "magiclink" }): Promise<{
    data: { session: AuthSession | null };
    error: AuthError | null;
  }>;
  getSession(): Promise<{ data: { session: AuthSession | null }; error: AuthError | null }>;
  onAuthStateChange(cb: (event: string, session: AuthSession | null) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
  startAutoRefresh?(): Promise<void>;
  stopAutoRefresh?(): Promise<void>;
}

/** supabase-js auth storage backed by the OS keychain (or the encrypted secrets file). */
export const secretAuthStorage = (secrets: SecretStore) => ({
  getItem: (key: string) => secrets.get(key),
  setItem: (key: string, value: string) => secrets.set(key, value),
  removeItem: (key: string) => secrets.delete(key),
});

/** A supabase-js auth client that persists its session in `secrets` and refreshes itself. */
export const createDeviceAuth = (url: string, publishableKey: string, secrets: SecretStore): AuthLike =>
  createClient(url, publishableKey, {
    auth: {
      storage: secretAuthStorage(secrets),
      storageKey: SUPABASE_SESSION_SECRET,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  }).auth as unknown as AuthLike;

/** An auth client that keeps the session in memory only (the 5-minute pairing watch). */
export const createEphemeralAuth = (url: string, publishableKey: string): AuthLike =>
  createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }).auth as unknown as AuthLike;

/** Exchanges a magic-link token_hash for an access token. */
export const exchangeTokenHash = async (auth: AuthLike, tokenHash: string): Promise<string> => {
  const { data, error } = await auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
  if (error || !data.session) throw new Error(`Supabase sign-in failed: ${error?.message ?? "no session"}`);
  return data.session.access_token;
};

const REVOKED_CODES = new Set(["device_revoked"]);

export class SupabaseAuthTokenSource implements TokenSource {
  readonly refreshIntervalMs: number;
  #token: string | null = null;
  readonly #listeners: ((token: string) => void)[] = [];
  #sub: { unsubscribe(): void } | null = null;
  #inflight: Promise<string> | null = null;

  constructor(
    private readonly auth: AuthLike,
    /** Signed-challenge login at Chalito's API; resolves to a magic-link token_hash. */
    private readonly login: MintToken,
    opts: { log?: Logger; refreshIntervalMs?: number } = {},
  ) {
    this.log = opts.log;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 4 * 60 * 1000;
  }

  private readonly log: Logger | undefined;

  onToken(cb: (token: string) => void): void {
    this.#listeners.push(cb);
  }

  /**
   * The current access token, after checking the session: restored from the keychain,
   * refreshed by supabase-js if it expired, or a fresh login when that's impossible.
   * Called at start and on every daemon refresh tick.
   */
  getToken(): Promise<string> {
    // One check at a time: a tick and a startup call must not both log in.
    this.#inflight ??= this.#ensure().finally(() => (this.#inflight = null));
    return this.#inflight;
  }

  async close(): Promise<void> {
    this.#sub?.unsubscribe();
    this.#sub = null;
    await this.auth.stopAutoRefresh?.().catch(() => undefined);
  }

  async #ensure(): Promise<string> {
    if (!this.#sub) {
      this.#sub = this.auth.onAuthStateChange((event, session) => {
        if (session?.access_token) this.#set(session.access_token);
        else if (event === "SIGNED_OUT") {
          this.#token = null;
          this.log?.warn("auth.signed_out", { action: "logging in again on the next refresh" });
        }
      }).data.subscription;
      await this.auth.startAutoRefresh?.().catch(() => undefined);
    }
    const { data, error } = await this.auth.getSession();
    if (!error && data.session?.access_token) {
      this.#set(data.session.access_token);
      return data.session.access_token;
    }
    if (error)
      this.log?.warn("auth.session_refresh_failed", { error: error.message, action: "signed-challenge login" });
    return this.#login();
  }

  async #login(): Promise<string> {
    let tokenHash: string;
    try {
      tokenHash = await this.login();
    } catch (err) {
      if (err instanceof ApiRequestError && (REVOKED_CODES.has(err.code) || err.status === 403)) {
        this.log?.error("device.revoked", { action: "stopping; run `chalito pair` to add this computer again" });
        throw new DeviceRevokedError();
      }
      throw err;
    }
    const token = await exchangeTokenHash(this.auth, tokenHash);
    this.#set(token);
    this.log?.info("auth.signed_in", { via: "signed_challenge" });
    return token;
  }

  #set(token: string): void {
    if (token === this.#token) return;
    this.#token = token;
    for (const cb of this.#listeners) cb(token);
  }
}
