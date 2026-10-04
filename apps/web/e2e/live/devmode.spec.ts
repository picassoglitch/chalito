import { expect, test } from "@playwright/test";
import { clientWrites, dev, ready, rows } from "./helpers";

const ROUTES = [
  "/",
  "/bandeja",
  "/sesiones",
  "/sesiones/s_dev_1",
  "/dispositivos",
  "/ajustes",
  "/bienvenida",
  "/a/apr_med_1",
  "/creditos",
  "/descargar",
  "/en",
  "/en/inbox",
  "/en/devices",
  "/en/settings",
];
const ENABLE = /\b(activar|encender|habilitar|enable|turn on|switch on)\b/i;

test("no route enables Developer mode; the banner shows on every screen; controls only turn it off", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await ready(page);
  await dev(page, "setDevMode", true, ["allowSudo", "autoApproveHigh"]);
  for (const path of ROUTES) {
    await page.goto(path);
    await page.waitForFunction(() => !!(window as unknown as { __chalitoDev?: unknown }).__chalitoDev);
    await dev(page, "setDevMode", true, ["allowSudo", "autoApproveHigh"]);
    await expect(page.getByTestId("devmode-banner"), path).toBeVisible();
    const controls = await page.locator("button, a, [role=switch], input[type=checkbox]").allInnerTexts();
    for (const text of controls)
      expect(text.match(/desarrollador|developer/i) && ENABLE.test(text), `${path}: "${text}"`).toBeFalsy();
  }

  await page.goto("/dispositivos");
  await page.waitForFunction(() => !!(window as unknown as { __chalitoDev?: unknown }).__chalitoDev);
  await dev(page, "setDevMode", true, ["allowSudo", "autoApproveHigh"]);
  await page.getByRole("button", { name: "Apagar allowSudo" }).click();
  await expect(page.getByTestId("devmode-controls")).toContainText("autoApproveHigh");
  await page.getByTestId("devmode-off").click();
  await expect(page.getByTestId("devmode-banner")).toHaveCount(0);
  const agent = (await rows(page, "devices")).find((d) => d.role === "agent")!;
  expect(agent.dev_mode).toMatchObject({ on: false });
  const types = (await clientWrites(page))
    .filter((w) => w.table === "commands")
    .map((w) => (w.row.env as { body: { payload: { type: string } } }).body.payload.type);
  expect(types).toEqual(["devmode.toggleOff", "devmode.off"]);
});
