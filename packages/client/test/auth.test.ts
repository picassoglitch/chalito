import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  BROWSER_SESSION_KEY,
  DeviceRevokedError,
  NoSessionError,
  connect,
  ensureSession,
  indexedDbStorage,
  memoryStorage,
  type BrowserAuth,
  type BrowserSupabase,
} from "../src/auth.js";
import { FakeSupabase, newDevice, testKeys, tick } from "./helpers.js";

type S = { access_token: string; user?: { id: string; app_metadata?: Record<string, unknown> } };
const asDevice = (token: string, deviceId: string): S => ({
  access_token: token,
  user: { id: `u-${deviceId}`, app_metadata: { chalito: { device_id: deviceId } } },
});

class FakeAuth implements BrowserAuth {
  session: S | null = null;
  calls: string[] = [];
  async signOut(opts?: { scope?: string }) {
    this.calls.push(`signOut:${opts?.scope ?? "global"}`);
    this.session = null;
    return {};
  }
  cbs: ((e: string, s: { access_token: string } | null) => void)[] = [];
  async verifyOtp(p: { token_hash: string; type: "magiclink" }) {
    this.calls.push(`verifyOtp:${p.token_hash}`);
    if (p.token_hash === "bad") return { data: { session: null }, error: { message: "invalid" } };
    this.session = { access_token: `at-${p.token_hash}` };
    return { data: { session: this.session }, error: null };
  }
  async setSession(p: { access_token: string; refresh_token: string }) {
    this.calls.push(`setSession:${p.access_token}`);
    this.session = { access_token: p.access_token };
    return { data: { session: this.session }, error: null };
  }
  async getSession() {
    return { data: { session: this.session }, error: null };
  }
  onAuthStateChange(cb: (e: string, s: { access_token: string } | null) => void) {
    this.cbs.push(cb);
    return { data: { subscription: { unsubscribe: () => (this.cbs = this.cbs.filter((c) => c !== cb)) } } };
  }
  refreshed(t: string) {
    this.session = { access_token: t };
    for (const cb of this.cbs) cb("TOKEN_REFRESHED", this.session);
  }
}

describe("ensureSession", () => {
  it("a device reuses its OWN stored session as is", async () => {
    const auth = new FakeAuth();
    auth.session = asDevice("stored", "dev1");
    expect(await ensureSession(auth, { kind: "device", deviceId: "dev1", login: async () => "never" })).toBe("stored");
    expect(auth.calls).toEqual([]);
  });

  it("a device never inherits another identity's stored session: sign out, then log in", async () => {
    const auth = new FakeAuth();
    auth.session = asDevice("someone-else", "dev_other");
    expect(await ensureSession(auth, { kind: "device", deviceId: "dev1", login: async () => "h1" })).toBe("at-h1");
    expect(auth.calls).toEqual(["signOut:local", "verifyOtp:h1"]);
    const person = new FakeAuth();
    person.session = { access_token: "a-person", user: { id: "hub-user-A" } };
    expect(await ensureSession(person, { kind: "device", deviceId: "dev1", login: async () => "h2" })).toBe("at-h2");
    expect(person.calls[0]).toBe("signOut:local");
  });

  it("an SSO launch always replaces the stored session (user A signed in, launch for user B)", async () => {
    const auth = new FakeAuth();
    auth.session = { access_token: "session-of-A", user: { id: "hub-user-A" } };
    expect(await ensureSession(auth, { kind: "sso", exchange: async () => ({ token_hash: "launch-B" }) })).toBe(
      "at-launch-B",
    );
    expect(auth.calls).toEqual(["signOut:local", "verifyOtp:launch-B"]);
  });

  it("stored: restores only; with nothing stored it fails instead of signing anyone in", async () => {
    const auth = new FakeAuth();
    await expect(ensureSession(auth, { kind: "stored" })).rejects.toBeInstanceOf(NoSessionError);
    auth.session = { access_token: "kept", user: { id: "hub-user-A" } };
    expect(await ensureSession(auth, { kind: "stored" })).toBe("kept");
    expect(auth.calls).toEqual([]);
  });

  it("device: signed-challenge login → magic-link token_hash → verifyOtp", async () => {
    const auth = new FakeAuth();
    expect(await ensureSession(auth, { kind: "device", deviceId: "dev1", login: async () => "h1" })).toBe("at-h1");
    expect(auth.calls).toEqual(["verifyOtp:h1"]);
  });

  it("sso: accepts a token_hash or a session pair from the exchange", async () => {
    const a = new FakeAuth();
    expect(await ensureSession(a, { kind: "sso", exchange: async () => ({ token_hash: "sso" }) })).toBe("at-sso");
    const b = new FakeAuth();
    expect(
      await ensureSession(b, { kind: "sso", exchange: async () => ({ access_token: "A", refresh_token: "R" }) }),
    ).toBe("A");
    expect(b.calls).toEqual(["setSession:A"]);
  });

  it("a revoked device gets DeviceRevokedError; a failed exchange is an ordinary error", async () => {
    await expect(
      ensureSession(new FakeAuth(), {
        kind: "device",
        deviceId: "dev1",
        login: async () => {
          throw Object.assign(new Error("device_revoked"), { code: "device_revoked" });
        },
      }),
    ).rejects.toBeInstanceOf(DeviceRevokedError);
    await expect(
      ensureSession(new FakeAuth(), { kind: "device", deviceId: "dev1", login: async () => "bad" }),
    ).rejects.toThrow(/sign-in failed/);
  });
});

describe("connect", () => {
  it("signs in, hands every new access token to Realtime, starts the live store; close() cleans up", async () => {
    const me = await newDevice();
    const auth = new FakeAuth();
    const fake = Object.assign(new FakeSupabase(), { auth }) as unknown as BrowserSupabase & FakeSupabase;
    const client = await connect({
      url: "http://127.0.0.1:54321",
      publishableKey: "k",
      keys: testKeys(me),
      owner: "hub-user-1",
      signIn: { kind: "device", deviceId: me.deviceId, login: async () => "h" },
      stepUp: async () => null,
      storage: memoryStorage(),
      create: () => fake,
    });
    await tick();
    // The explicit token first; the live store then re-asserts it (no argument = from the session).
    expect(fake.authTokens.filter(Boolean)).toEqual(["at-h"]);
    auth.refreshed("at-2");
    expect(fake.authTokens.filter(Boolean)).toEqual(["at-h", "at-2"]);
    expect(fake.channels[0]!.topic).toBe(`chalito:device:${me.deviceId}`);
    expect(client.live.getSnapshot().status).toBe("live");
    await client.close();
    expect(auth.cbs).toHaveLength(0);
    expect(fake.channels.every((c) => c.removed)).toBe(true);
  });
});

describe("indexedDbStorage", () => {
  it("keeps the session in IndexedDB across instances", async () => {
    const idb = new IDBFactory();
    const a = indexedDbStorage({ idb, dbName: "t1" });
    await a.setItem(BROWSER_SESSION_KEY, JSON.stringify({ refresh_token: "r" }));
    const b = indexedDbStorage({ idb, dbName: "t1" });
    expect(await b.getItem(BROWSER_SESSION_KEY)).toContain("refresh_token");
    await b.removeItem(BROWSER_SESSION_KEY);
    expect(await a.getItem(BROWSER_SESSION_KEY)).toBeNull();
    expect(await a.getItem("missing")).toBeNull();
  });
});
