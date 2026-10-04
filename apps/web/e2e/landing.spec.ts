import { expect, signedIn, test } from "./fixtures";

test("/ is the landing: real renders, the brand credit and the plans from plans.yaml", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hola, soy Chalito");
  await expect(page.getByTestId("landing-credit")).toHaveText("impulsado por Chalito Bot");
  // Every render loads (served from public/showcase, listed in the manifest).
  const imgs = page.locator("img[data-showcase]");
  expect(await imgs.count()).toBe(12);
  for (const img of await imgs.all()) {
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true);
  }
  // No MXN amounts set on the hub yet.
  await expect(page.getByTestId("plan-lite-price")).toHaveText("Disponible pronto");
  await expect(page.getByTestId("hub-pro")).toContainText("Chalyb Pro");
  await expect(page.getByRole("link", { name: "Entrar con Chalyb" })).toBeVisible();
  await expect(page.getByTestId("landing-inbox")).toHaveCount(0);
});

test("/en is the English landing", async ({ page }) => {
  await page.goto("/en");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, I'm Chalito");
  await expect(page.getByTestId("landing-credit")).toHaveText("powered by Chalito Bot");
  await expect(page.getByTestId("plan-lite-price")).toHaveText("Coming soon");
});

test("reduced motion shows the posters, not the animations", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto("http://127.0.0.1:3100/");
  const hero = page.locator('img[data-showcase="hero-chalito"]');
  await expect.poll(() => hero.evaluate((i: HTMLImageElement) => i.currentSrc)).toMatch(/hero-chalito-poster\.webp$/);
  await ctx.close();
});

test("signed in, / stays the landing with a way into the app", async ({ page }) => {
  await signedIn(page);
  await page.goto("/");
  await expect(page.getByTestId("landing-inbox")).toHaveText("Ir a tu bandeja");
  expect(new URL(page.url()).pathname).toBe("/");
  await page.getByTestId("landing-inbox").click();
  await expect(page).toHaveURL(/\/bandeja$/);
});

test("the app's home is /inicio", async ({ page }) => {
  await page.goto("/inicio");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hola, soy Chalito");
  await expect(page.getByRole("link", { name: "Chalito" }).first()).toHaveAttribute("href", "/inicio");
});
