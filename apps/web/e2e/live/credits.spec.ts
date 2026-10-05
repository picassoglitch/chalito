import { expect, test, type Page } from "@playwright/test";
import { ready } from "./helpers";

test("/creditos: the plan from the account, how tokens work, and recharging on Chalyb (no amounts)", async ({
  page,
}) => {
  await ready(page, "/creditos");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Créditos");
  await expect(page.getByTestId("credits-tier")).toHaveText("Tu plan: Chalyb Pro");
  await expect(page.getByTestId("credits-explain")).toContainText("no gasta tokens de Chalito");
  await expect(page.getByTestId("credits-recharge")).toHaveText("Recargar en Chalyb");
  await expect(page.getByTestId("credits-recharge")).toHaveAttribute("href", "https://hub.example/app/usage");
  await expect(page.getByRole("link", { name: "Ver tu uso" })).toHaveAttribute("href", "/uso");
  // Prices only ever live on the hub.
  await expect(page.locator("main")).not.toContainText(/\$|MXN|USD|€/);
});

test("/en/creditos", async ({ page }) => {
  await ready(page, "/en/creditos");
  await expect(page.getByTestId("credits-tier")).toHaveText("Your plan: Chalyb Pro");
  await expect(page.getByTestId("credits-recharge")).toHaveText("Recharge on Chalyb");
});

test("/creditos shows the hub balance in tokens: left, monthly, extra, used, held", async ({ page }) => {
  await ready(page, "/creditos");
  const card = page.getByTestId("credits-balance");
  await expect(card.getByTestId("balance-remaining")).toHaveText(/^Te quedan 300.000 tokens$/);
  await expect(card.getByTestId("balance-monthly")).toHaveText(/^1.000.000 tokens$/);
  await expect(card.getByTestId("balance-bonus")).toHaveText(/^50.000 tokens$/);
  await expect(card.getByTestId("balance-used")).toHaveText(/^750.000 tokens$/);
  await expect(card.getByTestId("balance-reserved")).toHaveText(/^12.000 tokens$/);
  await expect(page.locator("main")).not.toContainText(/\$|MXN|USD|€/);
});

/** Sets the simulated hub's balance answer as soon as the mock backend is up, before the page reads it. */
const balanceMode = (page: Page, mode: "unlimited" | "down") =>
  page.addInitScript((m) => {
    const w = window as unknown as { __chalitoDev?: { storeState?: { setBalanceMode(x: string): void } } };
    const t = setInterval(() => {
      if (w.__chalitoDev?.storeState) {
        w.__chalitoDev.storeState.setBalanceMode(m);
        clearInterval(t);
      }
    }, 1);
  }, mode);

test("/creditos: an unlimited account (hub admins)", async ({ page }) => {
  await balanceMode(page, "unlimited");
  await ready(page, "/creditos");
  await expect(page.getByTestId("balance-remaining")).toHaveText("Tokens ilimitados");
  await expect(page.getByTestId("balance-used")).toHaveCount(0);
});

test("/creditos: the hub doesn't answer, and the rest of the page still works", async ({ page }) => {
  await balanceMode(page, "down");
  await ready(page, "/creditos");
  await expect(page.getByTestId("balance-error")).toHaveText("Chalyb no respondió. Vuelve a intentarlo en un momento.");
  await expect(page.getByTestId("credits-recharge")).toBeVisible();
});
