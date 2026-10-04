import { expect, test } from "@playwright/test";
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
