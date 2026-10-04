import { expect, test } from "./fixtures";

test("/creditos signed out still explains credits and links to recharge on Chalyb", async ({ page }) => {
  await page.goto("/creditos");
  await expect(page.getByTestId("credits-tier")).toHaveText("Entra con tu cuenta de Chalyb para ver tu plan.");
  await expect(page.getByTestId("credits-recharge")).toHaveAttribute("href", "https://hub.example/app/usage");
});
