import type { Page } from "@playwright/test";
import { API, SSO_STATE, SUPABASE, expect, fakeSession, startedSignIn, storedSession, test } from "./fixtures";

const mockBackends = async (page: Page, exchanged: string[]) => {
  await page.route(`${API}/sso/exchange`, async (r) => {
    exchanged.push(r.request().postData() ?? "");
    await r.fulfill({ json: { customToken: "e2e-token-hash", owner: "hub-user-e2e" } });
  });
  await page.route(`${SUPABASE}/auth/v1/verify**`, (r) => r.fulfill({ json: fakeSession() }));
};

test("/auth/sso exchanges the hub token, opens a session and follows a relative next", async ({ page, context }) => {
  await startedSignIn(context);
  const exchanged: string[] = [];
  await mockBackends(page, exchanged);
  await page.goto("/auth/sso?token=hub.launch.token&next=%2Fcreditos");
  await expect(page).toHaveURL(/\/creditos$/);
  expect(exchanged).toEqual([JSON.stringify({ token: "hub.launch.token" })]);
  expect(JSON.parse((await storedSession(page))!).access_token).toBe("e2e-access");
});

test("/auth/sso never follows an off-origin next", async ({ page, context }) => {
  await startedSignIn(context);
  await mockBackends(page, []);
  await page.goto("/auth/sso?token=t&next=https%3A%2F%2Fevil.example%2F");
  await expect(page).toHaveURL(/127\.0\.0\.1:3100\/$/);
});

test("/auth/sso without a token, or with a failing exchange, shows an error and no session", async ({
  page,
  context,
}) => {
  await page.goto("/auth/sso");
  await expect(page.locator("main [role=alert]")).toContainText("Falta el enlace de acceso");
  await startedSignIn(context);
  await page.goto("/auth/sso?token=t");
  await expect(page.locator("main [role=alert]")).toContainText("No pudimos abrir tu sesión");
  expect(await storedSession(page)).toBeNull();
});

test("the launch token doesn't stay in the address bar", async ({ page }) => {
  await page.route(`${API}/sso/exchange`, () => undefined); // never answers
  await page.goto("/auth/sso?token=secret-launch-token&next=%2F");
  await expect(page).not.toHaveURL(/secret-launch-token/);
});

test("/n/<nid> signed out → hub sign-in (no next) → /auth/sso → back at /n/<nid>", async ({ page, context }) => {
  const launches: string[] = [];
  await page.route("https://hub.example/**", async (r) => {
    launches.push(r.request().url());
    await r.fulfill({ body: "hub" });
  });
  await page.goto("/n/n1");
  // On the hub before going on (the redirect's navigation must have committed), and only once.
  await page.waitForURL(/^https:\/\/hub\.example\/auth\/launch\/chalito\?state=[A-Za-z0-9_-]{43}$/);
  expect(launches).toHaveLength(1);
  const launched = launches[0]!;
  const cookie = (await context.cookies()).find((c) => c.name === "chalito_next");
  expect(cookie).toMatchObject({ value: "%2Fn%2Fn1", path: "/", sameSite: "Lax" });

  // The nonce is in a first-party cookie and in the launch's `state`.
  const state = (await context.cookies()).find((c) => c.name === "chalito_sso_state")!;
  expect(launched).toContain(`state=${state.value}`);
  // The hub's SSO lands on /auth/sso without a next; Chalito sends the person back.
  await mockBackends(page, []);
  await page.goto("/auth/sso?token=hub.launch.token");
  await expect(page).toHaveURL(/\/n\/n1$/);
  expect((await context.cookies()).find((c) => c.name === "chalito_next")).toBeUndefined();
  expect(launches).toHaveLength(1);
});

test("a rate-limited exchange (429) says to wait and offers no relaunch", async ({ page, context }) => {
  await startedSignIn(context);
  await page.route(`${API}/sso/exchange`, (r) =>
    r.fulfill({ status: 429, headers: { "retry-after": "30" }, json: { error: "rate_limited" } }),
  );
  await page.goto("/auth/sso?token=t");
  await expect(page.locator("main [role=alert]")).toContainText("Demasiados intentos, espera un momento");
  await expect(page.locator("main [role=alert] a")).toHaveCount(0);
  expect(await storedSession(page)).toBeNull();
});

for (const tampered of ["https%3A%2F%2Fevil.example%2F", "%2F%2Fevil.example", "%2Fapi%2Fanything"]) {
  test(`a tampered chalito_next (${decodeURIComponent(tampered)}) lands home`, async ({ page, context }) => {
    await context.addCookies([{ name: "chalito_next", value: tampered, url: "http://127.0.0.1:3100" }]);
    await startedSignIn(context);
    await mockBackends(page, []);
    await page.goto("/auth/sso?token=hub.launch.token");
    await expect(page).toHaveURL(/127\.0\.0\.1:3100\/$/);
  });
}

test("the token's own next wins over the remembered one", async ({ page, context }) => {
  await context.addCookies([{ name: "chalito_next", value: "%2Fn%2Fn1", url: "http://127.0.0.1:3100" }]);
  await startedSignIn(context);
  await mockBackends(page, []);
  await page.goto("/auth/sso?token=t&next=%2Fcreditos");
  await expect(page).toHaveURL(/\/creditos$/);
});

test("consent signed out → hub sign-in, remembering the consent request", async ({ page, context }) => {
  let launched = "";
  await page.route("https://hub.example/**", async (r) => {
    launched = r.request().url();
    await r.fulfill({ body: "hub" });
  });
  await page.goto("/oauth/consent?request=req_1");
  await expect.poll(() => launched).toMatch(/^https:\/\/hub\.example\/auth\/launch\/chalito\?state=[A-Za-z0-9_-]{43}$/);
  const cookie = (await context.cookies()).find((c) => c.name === "chalito_next");
  expect(decodeURIComponent(cookie!.value)).toBe("/oauth/consent?request=req_1");
});

test("login CSRF (R-M1): a launch token this browser didn't ask for is never exchanged", async ({ page, context }) => {
  const exchanged: string[] = [];
  await mockBackends(page, exchanged);
  await page.goto("/auth/sso?token=attackers.token&next=%2F.%2F%2Fevil.example");
  await expect(page.getByTestId("sso-unsolicited")).toBeVisible();
  expect(exchanged).toEqual([]);
  expect(await storedSession(page)).toBeNull();
  // Starting here works: it sets a fresh nonce and goes to the hub (the dot-segment next is dropped).
  let launched = "";
  await page.route("https://hub.example/**", async (r) => {
    launched = r.request().url();
    await r.fulfill({ body: "hub" });
  });
  await page.getByTestId("sign-in").click();
  await expect.poll(() => launched).toContain("state=");
  const next = (await context.cookies()).find((c) => c.name === "chalito_next")!;
  expect(decodeURIComponent(next.value)).toBe("/");
});

test("login CSRF (R-M1): a state the hub echoes must match, and the nonce is single-use", async ({ page, context }) => {
  const exchanged: string[] = [];
  await mockBackends(page, exchanged);
  await startedSignIn(context);
  await page.goto("/auth/sso?token=t&state=" + "x".repeat(43));
  await expect(page.getByTestId("sso-unsolicited")).toBeVisible();
  expect(exchanged).toEqual([]);

  await startedSignIn(context);
  await page.goto(`/auth/sso?token=t&state=${SSO_STATE}&next=%2Fcreditos`);
  await expect(page).toHaveURL(/\/creditos$/);
  expect(exchanged).toHaveLength(1);
  // Used up: the same link again is refused.
  await page.goto(`/auth/sso?token=t&state=${SSO_STATE}`);
  await expect(page.getByTestId("sso-unsolicited")).toBeVisible();
  expect(exchanged).toHaveLength(1);
});
