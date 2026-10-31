import { expect, test } from "@playwright/test";
import { clientWrites, ready } from "./helpers";

test("ADR 0032: a waiting approval pops up on any screen, without locking it", async ({ page }) => {
  await ready(page, "/ajustes");
  const popup = page.getByTestId("approval-popup");
  await expect(popup).toBeVisible();
  await expect(popup.getByRole("heading")).toContainText("Chalito necesita");
  // The page under it still works.
  await expect(page.getByTestId("persisted")).toBeVisible();

  // "Más tarde" moves on; it stays in the inbox, where no pop-up covers the list.
  const first = await popup.getAttribute("data-aid");
  await page.getByTestId("approval-popup-later").click();
  await expect(popup).not.toHaveAttribute("data-aid", first!);
  await page.goto("/bandeja");
  await expect(page.getByTestId("test-mode")).toBeVisible();
  await expect(page.getByTestId("approval-popup")).toHaveCount(0);
});

test("deciding from the pop-up sends the signed decision, then shows the next one", async ({ page }) => {
  await ready(page, "/dispositivos");
  const popup = page.getByTestId("approval-popup");
  await expect(popup).toBeVisible();
  const aid = (await popup.getAttribute("data-aid"))!;
  const before = (await clientWrites(page)).filter((w) => w.table === "approval_decisions").length;
  await popup.getByRole("button", { name: "Denegar" }).click();
  await expect
    .poll(async () => (await clientWrites(page)).filter((w) => w.table === "approval_decisions").length)
    .toBe(before + 1);
  await expect(page.locator(`[data-testid="approval-popup"][data-aid="${aid}"]`)).toHaveCount(0);
});

test("not on the approval's own page (/a/<id>), in English too", async ({ page }) => {
  await ready(page, "/en/a/apr_med_1");
  await expect(page.getByTestId("approval")).toBeVisible();
  await expect(page.getByTestId("approval-popup")).toHaveCount(0);
  await page.goto("/en/settings");
  await expect(page.getByTestId("approval-popup")).toBeVisible();
  await expect(page.getByTestId("approval-popup").getByRole("heading")).toContainText("Chalito needs");
});
