import { expect, test } from "@playwright/test";
import { ids, ready, rows } from "./helpers";

test("devices: presence, and revoking another client goes to the agent", async ({ page }) => {
  await ready(page, "/dispositivos");
  const { other, me } = await ids(page);
  await expect(page.getByTestId("device")).toHaveCount(3);
  await expect(page.locator(`[data-device="${me}"]`).getByRole("button", { name: "Retirar" })).toHaveCount(0);
  const row = page.locator(`[data-device="${other}"]`);
  await expect(row.getByTestId("presence")).toHaveText("En línea");
  await row.getByRole("button", { name: "Retirar" }).click();
  await row.getByRole("button", { name: "Sí, retirar" }).click();
  await expect(row.getByTestId("presence")).toHaveText("Retirado");
  expect((await rows(page, "devices")).find((d) => d.device_id === other)?.revoked).toBe(true);
});
