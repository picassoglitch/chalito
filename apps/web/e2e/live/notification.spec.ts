import { expect, test, type Page } from "@playwright/test";

const loggedWrites = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(sessionStorage.getItem("chalito.dev.clientWrites") ?? "[]") as {
        table: string;
        op: string;
        row: Record<string, unknown>;
      }[],
  );

test("/n/<nid> resolves the notification, acks it via WhatsApp and opens its deep link", async ({ page }) => {
  await page.goto("/n/n1", { referer: "https://l.wl.co/l?u=https%3A%2F%2Fchalito.chalyb.com%2Fn%2Fn1" });
  await expect(page).toHaveURL(/\/a\/apr_med_1$/);
  await expect(page.locator('[data-aid="apr_med_1"]')).toBeVisible();
  const acks = (await loggedWrites(page)).filter((w) => w.table === "notifications");
  expect(acks).toEqual([
    { table: "notifications", op: "update", row: expect.objectContaining({ state: "acked", acked_via: "whatsapp" }) },
  ]);
});

test("/en/n/<nid> lands on the English deep link and acks via app without a known referrer", async ({ page }) => {
  await page.goto("/en/n/n1");
  await expect(page).toHaveURL(/\/en\/a\/apr_med_1$/);
  const acks = (await loggedWrites(page)).filter((w) => w.table === "notifications");
  expect(acks.at(-1)?.row).toMatchObject({ acked_via: "app" });
});

test("an unknown notification says so and goes nowhere", async ({ page }) => {
  await page.goto("/n/nope");
  await expect(page.locator("main [role=alert]")).toContainText("Ese aviso ya no existe");
  await expect(page).toHaveURL(/\/n\/nope$/);
});
