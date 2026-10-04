import { expect, test, type Page } from "@playwright/test";
import { clientWrites, ready, rows } from "./helpers";

/** window.__chalitoDev.storeState.<fn>(...args) */
const storeState = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    ([f, a]) =>
      (window as unknown as { __chalitoDev: { storeState: Record<string, (...x: unknown[]) => unknown> } }).__chalitoDev
        .storeState[f as string]!(...(a as unknown[])),
    [fn, args] as const,
  ) as Promise<T>;

const item = (page: Page, id: string) => page.locator(`[data-testid=store-item][data-item=${id}]`);

const withCompanion = async (page: Page, avatar = "luna") => {
  await ready(page, "/ajustes");
  await storeState(page, "seedCompanion", avatar);
  await page.getByRole("link", { name: "Tienda" }).click();
  await expect(page.getByTestId("store")).toBeVisible();
};

test("tienda: free items wear straight away; the preview places them on the roster card", async ({ page }) => {
  await withCompanion(page);
  await expect(page.getByRole("heading", { name: "Tienda" })).toBeVisible();
  await expect(page.getByTestId("store-item")).toHaveCount(6);
  await expect(item(page, "viking_hat").getByTestId("store-price")).toHaveText("Gratis");
  await expect(item(page, "star_cape").getByTestId("store-price")).toHaveText(/^250[\s,.\u202f]?000 tokens$/);

  // The roster's art is served (copied from @chalito/roster at build).
  const card = await page.request.get("/roster/assets/luna/card.json");
  expect(card.ok()).toBe(true);
  await expect(page.getByTestId("store-preview").locator("img").first()).toHaveJSProperty("complete", true);

  await item(page, "viking_hat").getByTestId("store-equip").click();
  await expect(item(page, "viking_hat")).toHaveAttribute("data-worn", "true");
  await expect(page.getByTestId("store-preview")).toHaveAttribute("data-worn", "viking_hat");
  const worn = page.getByTestId("store-worn");
  await expect(worn).toHaveAttribute("data-item", "viking_hat");
  await expect(worn).toHaveCSS("visibility", "visible");
  // The equipped map is written by the api (server), never by the browser.
  expect((await rows(page, "companions"))[0]!.equipped).toEqual({ head: "viking_hat" });
  expect((await clientWrites(page)).filter((w) => w.table === "companions")).toEqual([]);

  // Same slot: the crown replaces the helmet.
  await item(page, "flower_crown").getByTestId("store-equip").click();
  await expect(item(page, "flower_crown")).toHaveAttribute("data-worn", "true");
  await expect(item(page, "viking_hat")).toHaveAttribute("data-worn", "false");
  await item(page, "flower_crown").getByTestId("store-unequip").click();
  await expect(page.getByTestId("store-worn")).toHaveCount(0);
});

test("tienda: buying spends tokens once, a retry reuses the purchase id, no tokens shows the inline chip", async ({
  page,
}) => {
  await withCompanion(page);
  // The hub is down on the first try: the retry must reuse the same purchaseId.
  await storeState(page, "failNextPurchase", "hub_unavailable");
  await item(page, "star_cape").getByTestId("store-buy").click();
  await expect(item(page, "star_cape").getByTestId("store-retry")).toBeVisible();
  await item(page, "star_cape").getByRole("button", { name: "Reintentar" }).click();
  await expect(item(page, "star_cape")).toHaveAttribute("data-owned", "true");
  const tries = (await clientWrites(page)).filter((w) => w.op === "store/purchase");
  expect(tries).toHaveLength(2);
  expect(tries[0]!.row.purchaseId).toBe(tries[1]!.row.purchaseId);
  expect(tries[0]!.row.purchaseId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  expect(await storeState(page, "balance")).toBe(50_000);
  expect(Object.keys(await storeState<Record<string, unknown>>(page, "purchases"))).toHaveLength(1);

  // Not enough left: an inline chip to /creditos, never a modal.
  await item(page, "sparkle_aura").getByTestId("store-buy").click();
  const chip = item(page, "sparkle_aura").getByTestId("store-no-tokens");
  await expect(chip).toContainText("No te alcanzan los tokens.");
  await expect(chip.getByRole("link", { name: "¿Por qué?" })).toHaveAttribute("href", "/creditos");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // A new tap is a new purchase.
  await item(page, "sparkle_aura").getByTestId("store-buy").click();
  const ids = (await clientWrites(page)).filter((w) => w.op === "store/purchase").map((w) => w.row.purchaseId);
  expect(ids.at(-1)).not.toBe(ids.at(-2));

  // Bought, then worn.
  await item(page, "star_cape").getByTestId("store-equip").click();
  await expect(page.getByTestId("store-preview")).toHaveAttribute("data-worn", "star_cape");

  // Nothing here reads like money.
  expect(await page.getByTestId("store").innerText()).not.toMatch(/\$|USD|MXN/);
});

test("tienda: a network drop mid-purchase is retried with the same id and charged once", async ({ page }) => {
  await withCompanion(page);
  await storeState(page, "failNextPurchase", "network");
  await item(page, "portal_swirl").getByTestId("store-buy").click();
  await expect(item(page, "portal_swirl").getByTestId("store-retry")).toBeVisible();
  await storeState(page, "setBalance", 500_000);
  await item(page, "portal_swirl").getByRole("button", { name: "Reintentar" }).click();
  await expect(item(page, "portal_swirl")).toHaveAttribute("data-owned", "true");
  expect(await storeState(page, "balance")).toBe(100_000);
});

test("tienda without a companion: items can be bought but not worn; it points to choosing one", async ({ page }) => {
  await ready(page, "/tienda");
  await expect(page.getByTestId("store-no-companion")).toBeVisible();
  await expect(page.getByTestId("store-equip")).toHaveCount(0);
  await expect(page.getByTestId("store-preview")).toHaveCount(0);
});

test("tienda unpaired (the person's session) still works; EN at /en/tienda", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("chalito.dev.paired", "0"));
  await page.goto("/en/tienda");
  await expect(page.getByRole("heading", { name: "Store" })).toBeVisible();
  await expect(page.getByTestId("store-item")).toHaveCount(6);
  await expect(page.locator("[data-item=viking_hat]").getByTestId("store-price")).toHaveText("Free");
});

test("onboarding offers the six roster companions with their pictures", async ({ page }) => {
  await ready(page, "/bienvenida");
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Elige a tu compañero");
  const group = page.getByRole("radiogroup");
  await expect(group.getByRole("radio")).toHaveCount(6);
  for (const name of ["Chalito", "Bruno", "Luna", "Tito", "Canela", "Nube"]) await expect(group).toContainText(name);
  await expect(group.locator("img").first()).toHaveAttribute("src", "/roster/assets/chalito/thumb-128.webp");
});
