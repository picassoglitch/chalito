import { describe, expect, it } from "vitest";
import { ApiRequestError, supabaseCloud, supabasePairingWatcher } from "../src/cloud.js";
import {
  DeviceRevokedError,
  SUPABASE_SESSION_SECRET,
  SupabaseAuthTokenSource,
  secretAuthStorage,
  type AuthLike,
} from "../src/device-auth.js";
import { MemorySecretStore } from "../src/secrets.js";
import { FakeSupabase, tick } from "./fake-supabase.js";

/** Plays GoTrue: a stored session (or none), verifyOtp, auto-refresh events, refresh failures. */
class FakeAuth implements AuthLike {
  session: { access_token: string } | null = null;
  sessionError: { message: string } | null = null;
  verified: string[] = [];
  cbs: ((event: string, s: { access_token: string } | null) => void)[] = [];
  autoRefresh = false;

  async verifyOtp(p: { token_hash: string; type: "magiclink" }) {
    this.verified.push(`${p.type}:${p.token_hash}`);
    if (p.token_hash === "bad")
      return { data: { session: null }, error: { message: "Token has expired or is invalid" } };
    this.session = { access_token: `access-for-${p.token_hash}` };
    for (const cb of this.cbs) cb("SIGNED_IN", this.session);
    return { data: { session: this.session }, error: null };
  }
  async getSession() {
    if (this.sessionError) {
      const error = this.sessionError;
      this.sessionError = null;
      this.session = null;
      return { data: { session: null }, error };
    }
    return { data: { session: this.session }, error: null };
  }
  onAuthStateChange(cb: (event: string, s: { access_token: string } | null) => void) {
    this.cbs.push(cb);
    return { data: { subscription: { unsubscribe: () => (this.cbs = this.cbs.filter((c) => c !== cb)) } } };
  }
  async startAutoRefresh() {
    this.autoRefresh = true;
  }
  async stopAutoRefresh() {
    this.autoRefresh = false;
  }
  /** supabase-js refreshed the access token in the background. */
  refreshed(token: string) {
    this.session = { access_token: token };
    for (const cb of this.cbs) cb("TOKEN_REFRESHED", this.session);
  }
}

const source = (auth: FakeAuth, login: () => Promise<string>) => new SupabaseAuthTokenSource(auth, login);

describe("SupabaseAuthTokenSource (a Supabase Auth user per device)", () => {
  it("first start: signed-challenge login → magic-link token_hash → verifyOtp; auto-refresh on", async () => {
    const auth = new FakeAuth();
    let logins = 0;
    const src = source(auth, async () => `hash-${++logins}`);
    expect(await src.getToken()).toBe("access-for-hash-1");
    expect(auth.verified).toEqual(["magiclink:hash-1"]);
    expect(auth.autoRefresh).toBe(true);
    await src.close();
    expect(auth.autoRefresh).toBe(false);
  });

  it("a session restored from the keychain is used without logging in", async () => {
    const auth = new FakeAuth();
    auth.session = { access_token: "restored" };
    let logins = 0;
    const src = source(auth, async () => `hash-${++logins}`);
    expect(await src.getToken()).toBe("restored");
    expect(logins).toBe(0);
  });

  it("background refreshes reach listeners; the cloud hands each new token to realtime.setAuth", async () => {
    const auth = new FakeAuth();
    const src = source(auth, async () => "h");
    let fake: FakeSupabase | undefined;
    const cloud = supabaseCloud({ url: "http://127.0.0.1:54321", publishableKey: "k" }, src, {
      create: (_u, _k, at) => (fake = new FakeSupabase(at)),
    });
    await cloud.refresh();
    auth.refreshed("access-2");
    auth.refreshed("access-3");
    expect(fake!.authTokens).toEqual(["access-for-h", "access-2", "access-3"]);
    expect(await fake!.accessToken!()).toBe("access-3");
    await cloud.close();
    expect(auth.cbs).toHaveLength(0);
  });

  it("when the refresh fails (banned/revoked user, lost refresh token) it logs in again with a fresh challenge", async () => {
    const auth = new FakeAuth();
    let logins = 0;
    const src = source(auth, async () => `hash-${++logins}`);
    await src.getToken();
    auth.sessionError = { message: "Invalid Refresh Token: Refresh Token Not Found" };
    expect(await src.getToken()).toBe("access-for-hash-2");
    expect(logins).toBe(2);
  });

  it("if the API refuses the login (device_revoked), DeviceRevokedError", async () => {
    const auth = new FakeAuth();
    const src = source(auth, async () => {
      throw new ApiRequestError(403, "device_revoked");
    });
    await expect(src.getToken()).rejects.toBeInstanceOf(DeviceRevokedError);
    await expect(src.getToken()).rejects.toThrow(/chalito pair/);
  });

  it("other login failures (network, a bad token_hash) are ordinary errors, retried on the next tick", async () => {
    const network = source(new FakeAuth(), async () => {
      throw new Error("fetch failed");
    });
    await expect(network.getToken()).rejects.toThrow("fetch failed");
    const bad = source(new FakeAuth(), async () => "bad");
    await expect(bad.getToken()).rejects.toThrow(/sign-in failed/);
  });

  it("concurrent callers share one login", async () => {
    const auth = new FakeAuth();
    let logins = 0;
    const src = source(auth, async () => (await tick(), `hash-${++logins}`));
    const [a, b] = await Promise.all([src.getToken(), src.getToken()]);
    expect([a, b]).toEqual(["access-for-hash-1", "access-for-hash-1"]);
    expect(logins).toBe(1);
  });

  it("supabase-js auth storage writes the session into the SecretStore under supabase-refresh", async () => {
    const secrets = new MemorySecretStore();
    const storage = secretAuthStorage(secrets);
    await storage.setItem(SUPABASE_SESSION_SECRET, JSON.stringify({ refresh_token: "r1" }));
    expect(JSON.parse((await secrets.get("supabase-refresh"))!)).toEqual({ refresh_token: "r1" });
    expect(await storage.getItem(SUPABASE_SESSION_SECRET)).toContain("r1");
    await storage.removeItem(SUPABASE_SESSION_SECRET);
    expect(await secrets.get("supabase-refresh")).toBeNull();
  });

  it("the pairing watcher exchanges the API's watch credential before joining", async () => {
    let fake: FakeSupabase | undefined;
    const exchanged: string[] = [];
    const w = supabasePairingWatcher(
      { url: "http://127.0.0.1:54321", publishableKey: "k" },
      {
        create: (_u, _k, at) => (fake = new FakeSupabase(at)),
        exchange: async (h) => (exchanged.push(h), `pairing-access-${h}`),
      },
    );
    const stop = await w.watch("pair-hash", "code_123456789", () => undefined);
    expect(exchanged).toEqual(["pair-hash"]);
    expect(await fake!.accessToken!()).toBe("pairing-access-pair-hash");
    await stop();
  });
});
