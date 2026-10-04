import { test as base, type Page } from "@playwright/test";

export const SUPABASE = "http://127.0.0.1:54399";
export const API = "http://127.0.0.1:8799";
/** packages/client keeps the Supabase Auth session in IndexedDB "chalito", store "auth", under this key. */
export const STORAGE_KEY = "chalito-supabase-session";

/** Reads the stored session (null when signed out). */
export const storedSession = (page: Page) =>
  page.evaluate(
    (key) =>
      new Promise<string | null>((resolve, reject) => {
        const open = indexedDB.open("chalito", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("auth");
        open.onsuccess = () => {
          const get = open.result.transaction("auth", "readonly").objectStore("auth").get(key);
          get.onsuccess = () => resolve((get.result as string | undefined) ?? null);
          get.onerror = () => reject(get.error);
        };
        open.onerror = () => reject(open.error);
      }),
    STORAGE_KEY,
  );

export const fakeSession = (tier = "pro") => ({
  access_token: "e2e-access",
  refresh_token: "e2e-refresh",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: {
    id: "00000000-0000-0000-0000-0000000000e2",
    aud: "authenticated",
    role: "authenticated",
    email: "e2e@example.invalid",
    app_metadata: { chalito: { tier } },
    user_metadata: {},
    created_at: new Date().toISOString(),
  },
});

/** Every backend call fails loudly unless a spec mocks it: nothing live is ever reached. */
const guardBackends = async (page: Page) => {
  await page.route(`${SUPABASE}/**`, (r) => r.fulfill({ status: 503, body: "e2e: unmocked supabase call" }));
  await page.route(`${API}/**`, (r) => r.fulfill({ status: 503, body: "e2e: unmocked api call" }));
};

/** Seeds a session the way packages/client stores it, from a cheap page, before the spec navigates. */
export const signedIn = async (page: Page) => {
  await page.goto("/descargar");
  await page.evaluate(
    ([key, session]) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("chalito", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("auth");
        open.onsuccess = () => {
          const tx = open.result.transaction("auth", "readwrite");
          tx.objectStore("auth").put(JSON.stringify(session), key as string);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
      }),
    [STORAGE_KEY, fakeSession()] as const,
  );
};

export const test = base.extend<{ guarded: void }>({
  guarded: [
    async ({ page }, use) => {
      await guardBackends(page);
      await use();
    },
    { auto: true },
  ],
});
export { expect } from "@playwright/test";
