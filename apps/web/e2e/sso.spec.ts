import type { Page } from "@playwright/test";
import { API, SUPABASE, expect, fakeSession, storedSession, test } from "./fixtures";

const mockBackends = async (page: Page, exchanged: string[]) => {
  await page.route(`${API}/sso/exchange`, async (r) => {
    exchanged.push(r.request().postData() ?? "");
    await r.fulfill({ json: { token_hash: "e2e-token-hash" } });
  });
  await page.route(`${SUPABASE}/auth/v1/verify**`, (r) => r.fulfill({ json: fakeSession() }));
};

test("/auth/sso exchanges the hub token, opens a session and follows a relative next", async ({ page }) => {
  const exchanged: string[] = [];
  await mockBackends(page, exchanged);
  await page.goto("/auth/sso?token=hub.launch.token&next=%2Fcreditos");
  await expect(page).toHaveURL(/\/creditos$/);
  expect(exchanged).toEqual([JSON.stringify({ token: "hub.launch.token" })]);
  expect(JSON.parse((await storedSession(page))!).access_token).toBe("e2e-access");
});

test("/auth/sso never follows an off-origin next", async ({ page }) => {
  await mockBackends(page, []);
  await page.goto("/auth/sso?token=t&next=https%3A%2F%2Fevil.example%2F");
  await expect(page).toHaveURL(/127\.0\.0\.1:3100\/$/);
});

test("/auth/sso without a token, or with a failing exchange, shows an error and no session", async ({ page }) => {
  await page.goto("/auth/sso");
  await expect(page.locator("main [role=alert]")).toContainText("Falta el enlace de acceso");
  await page.goto("/auth/sso?token=t");
  await expect(page.locator("main [role=alert]")).toContainText("No pudimos abrir tu sesión");
  expect(await storedSession(page)).toBeNull();
});

test("the launch token doesn't stay in the address bar", async ({ page }) => {
  await page.route(`${API}/sso/exchange`, () => undefined); // never answers
  await page.goto("/auth/sso?token=secret-launch-token&next=%2F");
  await expect(page).not.toHaveURL(/secret-launch-token/);
});

test("/n/<nid> signed out goes to the hub sign-in and comes back to the same link", async ({ page }) => {
  let launched = "";
  await page.route("https://hub.example/**", async (r) => {
    launched = r.request().url();
    await r.fulfill({ body: "hub" });
  });
  await page.goto("/n/n1");
  await expect.poll(() => launched).toBe("https://hub.example/auth/launch/chalito?next=%2Fn%2Fn1");
});
