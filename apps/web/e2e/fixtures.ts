import { test as base, type Page } from "@playwright/test";

export const SUPABASE = "http://127.0.0.1:54399";
export const API = "http://127.0.0.1:8799";
/** supabase-js storage key for the e2e project URL (`sb-<first host label>-auth-token`). */
export const STORAGE_KEY = "sb-127-auth-token";

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

export const signedIn = async (page: Page) => {
  await page.addInitScript(
    ([key, session]) => window.localStorage.setItem(key as string, JSON.stringify(session)),
    [STORAGE_KEY, fakeSession()],
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
