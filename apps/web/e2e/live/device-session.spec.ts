import { expect, test } from "@playwright/test";
import { clientWrites, dev, ready } from "./helpers";

type Sess = { access_token: string; role: string } | null;

test("unpaired: the browser keeps the person's own session; live screens ask to pair, settings still work", async ({
  page,
}) => {
  await page.addInitScript(() => window.localStorage.setItem("chalito.dev.paired", "0"));
  await page.goto("/bandeja");
  await expect(page.getByTestId("gate-unpaired")).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as { __chalitoDev?: unknown }).__chalitoDev);
  expect((await dev<Sess>(page, "session"))?.role).toBe("user");
  expect((await clientWrites(page)).filter((w) => w.op === "devices/token")).toEqual([]);
  await page.goto("/ajustes");
  await expect(page.getByTestId("persisted")).toHaveAttribute("data-where", "server");
});

test("paired: the browser signs in as ITS device (role client) and approve + sharing go through with that session", async ({
  page,
}) => {
  await ready(page, "/sesiones/s_dev_1");
  await expect.poll(async () => (await dev<Sess>(page, "session"))?.role).toBe("client");
  expect((await clientWrites(page)).filter((w) => w.op === "devices/token")).toHaveLength(1);

  // Sharing (a client-role route) succeeds with the device session.
  const box = page.getByTestId("sharing-session");
  await box.getByRole("switch").click();
  await box.getByLabel("Entiendo que se guarda sin cifrar.").check();
  await box.getByRole("button", { name: "Compartir" }).click();
  await expect(box.getByRole("switch")).toBeChecked();

  // Consent approval (client-role) too.
  await page.getByRole("link", { name: "Dispositivos" }).click();
  await page.getByRole("button", { name: "Crear passkey" }).click();
  let landed = "";
  await page.route("https://claude.ai/**", async (r) => {
    landed = r.request().url();
    await r.fulfill({ body: "claude" });
  });
  await page.goto("/oauth/consent?request=req_dev_1");
  await page.getByRole("button", { name: "Permitir", exact: true }).click();
  await expect.poll(() => landed).toContain("code=dev_code");
});

test("revoked while connected: the gate says so, offers re-pairing, and the browser forgets its trust", async ({
  page,
}) => {
  await ready(page, "/bandeja");
  await dev(page, "revokeMe");
  await expect(page.getByTestId("gate-revoked")).toBeVisible();
  await expect(page.getByRole("link", { name: "Emparejar de nuevo" })).toHaveAttribute("href", "/descargar");
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("chalito.dev.paired"))).toBe("0");
});

test("revoked at sign-in: the device login is refused (DeviceRevokedError) and the gate shows revoked", async ({
  page,
}) => {
  await page.addInitScript(() => window.localStorage.setItem("chalito.dev.revoked", "1"));
  await page.goto("/bandeja");
  await expect(page.getByTestId("gate-revoked")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("chalito.dev.paired"))).toBe("0");
});
