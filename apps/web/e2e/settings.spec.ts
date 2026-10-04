import { SETTINGS } from "@chalito/ui";
import { expect, test } from "./fixtures";

// Settings parity (brief M5): enumerate the registry and check each key renders in the web shell,
// in both locales. The desktop shell is covered by packages/ui's parity test until it exists.
for (const path of ["/ajustes", "/en/settings"]) {
  test(`every registered setting renders on ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('[data-shell="web"]')).toBeVisible();
    for (const s of SETTINGS) await expect(page.locator(`[data-setting-key="${s.key}"]`), s.key).toHaveCount(1);
  });
}

test("settings persist on this device", async ({ page }) => {
  await page.goto("/ajustes");
  await page.getByLabel("Nombre").fill("Pepe");
  await expect(page.getByTestId("credit-line")).toContainText("impulsado por Chalito Bot");
  await page.reload();
  await expect(page.getByLabel("Nombre")).toHaveValue("Pepe");
});
