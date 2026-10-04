import { expect, test } from "@playwright/test";
import { clientWrites, dev, ready } from "./helpers";

test("Ajustes → Plan y créditos → Tu uso: tokens by day, work vs communication, the 10% target, your keys apart", async ({
  page,
}) => {
  await ready(page, "/ajustes");
  await page.getByTestId("usage-link").click();
  await expect(page).toHaveURL(/\/uso$/);
  await expect(page.getByRole("heading", { name: "Tu uso" })).toBeVisible();

  // Default 30 days, read as this device.
  await expect(page.getByTestId("usage-managed-total")).toContainText("tokens");
  expect((await clientWrites(page)).filter((w) => w.op === "usage/daily").map((w) => w.row.days)).toEqual([30]);
  await expect(page.getByTestId("usage-managed-chart").locator("g")).toHaveCount(30);
  await expect(page.getByTestId("usage-share")).toHaveAttribute("data-over", "false");
  await expect(page.getByTestId("usage-share")).toContainText("meta: menos de 10");
  await expect(page.getByTestId("usage-target-line")).toBeAttached();
  await expect(page.getByRole("heading", { name: "Tus claves" })).toBeVisible();
  await expect(page.getByTestId("usage-byo-chart")).toBeVisible();

  // Tokens only: no money anywhere on the page.
  const text = await page.getByTestId("usage").innerText();
  expect(text).not.toMatch(/\$|USD|MXN|costo|cost/i);

  await page.getByTestId("usage-range-7").click();
  await expect(page.getByTestId("usage-managed-chart").locator("g")).toHaveCount(7);
  await expect(page.getByTestId("usage-range-7")).toHaveAttribute("aria-pressed", "true");
  await page.getByText("Ver por día").click();
  await expect(page.getByTestId("usage-table").locator("tbody tr")).toHaveCount(7);
});

test("above target says so; no usage and errors are explicit", async ({ page }) => {
  await ready(page, "/uso");
  await expect(page.getByTestId("usage")).toBeVisible();
  await dev(page, "setUsage", "over");
  await page.getByTestId("usage-range-7").click();
  await expect(page.getByTestId("usage-share")).toHaveAttribute("data-over", "true");
  await expect(page.getByText("Por encima de la meta")).toBeVisible();

  await dev(page, "setUsage", "empty");
  await page.getByTestId("usage-range-30").click();
  await expect(page.getByTestId("usage-empty")).toBeVisible();
  await expect(page.getByText("Sin uso de Chalito en este periodo.")).toBeVisible();

  await dev(page, "setUsage", "error");
  await page.getByTestId("usage-range-7").click();
  await expect(page.getByTestId("usage-error")).toBeVisible();
  await dev(page, "setUsage", "normal");
  await page.getByRole("button", { name: "Reintentar" }).click();
  await expect(page.getByTestId("usage-share")).toBeVisible();
});

test("unpaired: the page asks to pair (the read needs a device) and calls nothing", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("chalito.dev.paired", "0"));
  await page.goto("/uso");
  await expect(page.getByTestId("gate-unpaired")).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as { __chalitoDev?: unknown }).__chalitoDev);
  expect((await clientWrites(page)).filter((w) => w.op === "usage/daily")).toEqual([]);
});

test("EN: /en/usage", async ({ page }) => {
  await ready(page, "/en/usage");
  await expect(page.getByRole("heading", { name: "Your usage" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your keys" })).toBeVisible();
});
