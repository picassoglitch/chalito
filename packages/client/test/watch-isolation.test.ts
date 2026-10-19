import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserSupabase, createWatchSupabase, memoryStorage, type BrowserSupabase } from "../src/index.js";

/**
 * The endorsement watch signs a throwaway client in as the code's watcher (a magic link). In a
 * browser, supabase-js tells every client with the same storage key about a sign-in through a
 * BroadcastChannel. When the watch client shared the person's key, the person's client took the
 * watcher's session as its own, the hub saw another account, signed out, and "Usar este navegador"
 * hung on "Entrando a Chalito…" (2026-10-19). The watch client must never reach the person's client.
 */
const URL = "http://127.0.0.1:54321";
const KEY = "sb_publishable_test";

type Internal = { _notifyAllSubscribers(e: string, s: unknown, broadcast: boolean): Promise<void> };
const signInEvent = (sb: BrowserSupabase) =>
  (sb.auth as unknown as Internal)._notifyAllSubscribers(
    "SIGNED_IN",
    { access_token: "watch", user: { id: "watcher", app_metadata: {} } },
    true,
  );

const g = globalThis as Record<string, unknown>;
let saved: { window: unknown; document: unknown };
beforeEach(() => {
  // auth-js only opens its BroadcastChannel in a browser; Node has BroadcastChannel itself.
  saved = { window: g.window, document: g.document };
  g.window = globalThis;
  g.document = {};
});
afterEach(() => {
  g.window = saved.window;
  g.document = saved.document;
});

const seen = (sb: BrowserSupabase) => {
  const events: string[] = [];
  (sb.auth as unknown as { onAuthStateChange(cb: (e: string, s: unknown) => void): unknown }).onAuthStateChange((e) =>
    events.push(e),
  );
  return events;
};
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("watch clients are isolated from the person's session", () => {
  it("a sign-in on a client with the person's key reaches the person's client (the old bug)", async () => {
    const person = createBrowserSupabase(URL, KEY, memoryStorage());
    const events = seen(person);
    await settle();
    await signInEvent(createBrowserSupabase(URL, KEY, memoryStorage()));
    await settle();
    expect(events).toContain("SIGNED_IN");
  });

  it("a sign-in on the watch client does not", async () => {
    const person = createBrowserSupabase(URL, KEY, memoryStorage());
    const events = seen(person);
    await settle();
    await signInEvent(createWatchSupabase(URL, KEY));
    await settle();
    expect(events).not.toContain("SIGNED_IN");
  });
});
