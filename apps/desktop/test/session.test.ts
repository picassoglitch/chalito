import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateDeviceKeys, type KeyVault } from "@chalito/client-keys";
import { createSession, type DesktopEnv } from "../src/lib/session.js";
import type * as Client from "@chalito/client";

// jsdom has no IndexedDB: the auth session lives in memory; the rest of createSession is real.
vi.mock("@chalito/client", async (importOriginal) => {
  const m = await importOriginal<typeof Client>();
  return { ...m, indexedDbStorage: () => m.memoryStorage() };
});

/** The panel's sign-in must not wait on this device's saved sign-in (owner, 2026-10-28). */

const ENV: DesktopEnv = {
  supabaseUrl: "https://example.supabase.co",
  supabaseKey: "sb_publishable_test",
  apiBase: "https://api.example.test",
  ssoStartUrl: "https://www.chalyb.com/app/chalito/auth/desktop",
};
const OWNER = "8a7a0d3c-5b5e-4a39-9d2b-2f8b1e0c4a11";

const enrolled = () => localStorage.setItem("chalito-desktop-account", JSON.stringify({ owner: OWNER, passkey: null }));

const vaultWith = (load: KeyVault["load"]) => ({ load, loadTrustedAgents: async () => [] }) as unknown as KeyVault;

/** Resolves with what createSession settled to, or "pending" if it hasn't within `ms`. */
const settle = <T>(p: Promise<T>, ms = 2000) =>
  Promise.race([p, new Promise<"pending">((r) => setTimeout(() => r("pending"), ms))]);

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("createSession", () => {
  it("hands over the sign-in controller while the saved sign-in still waits on the network", async () => {
    enrolled();
    const keys = await generateDeviceKeys();
    const calls: string[] = [];
    // The api never answers this device's login, like a stalled connection.
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return new Promise<Response>(() => undefined);
    });
    const onConnected = vi.fn();
    const s = await settle(createSession(ENV, onConnected, async () => vaultWith(async () => keys)));
    expect(s).not.toBe("pending");
    if (s === "pending") return;
    expect(s.controller.getSnapshot().step).toBe("signed_out");
    expect(s.restoring).toBe(true);
    // The saved sign-in really started, and is still running.
    await vi.waitFor(() => expect(calls.some((u) => u.startsWith(ENV.apiBase))).toBe(true));
    expect(await settle(s.restored, 50)).toBe("pending");
    expect(onConnected).not.toHaveBeenCalled();
    s.dispose();
  });

  it("still hands over the controller when the saved keys can't be read", async () => {
    enrolled();
    const err = new DOMException("The operation failed for an operation-specific reason", "OperationError");
    const s = await settle(createSession(ENV, vi.fn(), async () => vaultWith(() => Promise.reject(err))));
    expect(s).not.toBe("pending");
    if (s === "pending") return;
    expect(s.controller.getSnapshot().step).toBe("signed_out");
    expect(await s.restored).toBe(false);
  });

  it("restores nothing on a computer that never signed in", async () => {
    const load = vi.fn(async () => null);
    const s = await createSession(ENV, vi.fn(), async () => vaultWith(load));
    expect(s.restoring).toBe(false);
    expect(await s.restored).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("rejects when this computer's key store can't open, so the panel can say why", async () => {
    const err = new DOMException("Internal error opening backing store", "UnknownError");
    await expect(createSession(ENV, vi.fn(), () => Promise.reject(err))).rejects.toBe(err);
  });
});
