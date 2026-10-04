import { expect, test } from "./fixtures";

test("/ is Spanish, unprefixed", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hola, soy Chalito");
  expect(new URL(page.url()).pathname).toBe("/");
});

test("/en is English", async ({ page }) => {
  await page.goto("/en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, I'm Chalito");
});

test("/es redirects to the unprefixed path", async ({ page }) => {
  await page.goto("/es/ajustes");
  expect(new URL(page.url()).pathname).toBe("/ajustes");
  await page.goto("/es");
  expect(new URL(page.url()).pathname).toBe("/");
});

test("the locale comes from the URL only, not the browser language or a cookie", async ({ browser }) => {
  const ctx = await browser.newContext({ locale: "en-US", extraHTTPHeaders: { "accept-language": "en-US,en" } });
  const page = await ctx.newPage();
  await ctx.addCookies([{ name: "NEXT_LOCALE", value: "en", url: "http://127.0.0.1:3100" }]);
  await page.goto("http://127.0.0.1:3100/");
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await ctx.close();
});

test("localized slugs and the language switch", async ({ page }) => {
  await page.goto("/en/settings");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");
  await page.getByTestId("locale-switch").click();
  await expect(page).toHaveURL(/\/ajustes$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ajustes");
});

test("deep-link stubs exist in both locales", async ({ page }) => {
  test.setTimeout(90_000);
  const links: [string, string][] = [
    ["/m/m1", "Mesa m1"],
    ["/creditos", "Créditos"],
    ["/en/creditos", "Credits"],
  ];
  for (const [path, heading] of links) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
  }
  expect((await page.goto("/a/bad%20id"))?.status()).toBe(404);
  // /a/<id> is a live screen: signed out, it asks you to sign in first.
  await page.goto("/a/apr_1");
  await expect(page.getByTestId("gate-signed_out")).toBeVisible();
  // So is a room (/r/<id>, /en/r/<id>).
  for (const path of ["/r/r1", "/en/r/r1"]) {
    await page.goto(path);
    await expect(page.getByTestId("gate-signed_out")).toBeVisible();
  }
});

test("the language switch keeps a deep link's id", async ({ page }) => {
  await page.goto("/m/m1");
  await page.getByTestId("locale-switch").click();
  await expect(page).toHaveURL(/\/en\/m\/m1$/);
});
