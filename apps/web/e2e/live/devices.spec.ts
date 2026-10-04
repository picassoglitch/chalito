import { expect, test } from "@playwright/test";
import { clientWrites, dev, ids, ready, rows } from "./helpers";

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
  // Review R-H5: the server first, then the signed command to each computer.
  const ops = (await clientWrites(page)).map((w) => (w.table === "api" ? w.op : w.table));
  expect(ops.indexOf("devices/revoke")).toBeGreaterThanOrEqual(0);
  expect(ops.indexOf("devices/revoke")).toBeLessThan(ops.lastIndexOf("commands"));
  await expect(page.getByTestId("revoke-result")).toContainText("ya no puede entrar a tu cuenta");
  await expect(page.getByTestId("revoke-agent")).toHaveText("Laptop de Aldo: lo quitó de su lista.");
  await expect.poll(() => dev(page, "agentDropped", other)).toBe(true);
});

test("revoking while a computer is asleep: the server ban holds, and the page says that computer is offline", async ({
  page,
}) => {
  await ready(page, "/dispositivos");
  const { other } = await ids(page);
  await dev(page, "sleepAgent");
  const row = page.locator(`[data-device="${other}"]`);
  await row.getByRole("button", { name: "Retirar" }).click();
  await row.getByRole("button", { name: "Sí, retirar" }).click();
  await expect(row.getByTestId("presence")).toHaveText("Retirado");
  await expect(page.getByTestId("revoke-agent")).toHaveAttribute("data-online", "false");
  await expect(page.getByTestId("revoke-agent")).toContainText("sin conexión");
  expect(await dev(page, "agentDropped", other)).toBe(false);
  await expect(page.getByTestId("revoke-agent")).toContainText("lo quitará de su lista en cuanto se conecte");
  // It reconnects: the directory says revoked, so it drops the device (R-H5 agent reconcile).
  await dev(page, "wakeAgent");
  expect(await dev(page, "agentDropped", other)).toBe(true);
});

test("R-M11: changing the passkey asks for the current one; without it nothing changes", async ({ page }) => {
  await ready(page, "/dispositivos");
  await page.getByRole("button", { name: "Crear passkey" }).click();
  await expect(page.getByTestId("passkey-enrolled")).toBeVisible();
  const registers = async () =>
    (await clientWrites(page)).filter((w) => w.op === "webauthn/register").map((w) => w.row.replace);
  expect(await registers()).toEqual([false]);

  await page.getByTestId("passkey-replace").click();
  await expect(page.getByTestId("passkey-enrolled")).toContainText("tu nueva llave de acceso");
  expect(await registers()).toEqual([false, true]);
  const ref = () => page.evaluate(() => JSON.parse(localStorage.getItem("chalito.passkey.v1")!).credentialId);
  expect(await ref()).toBe("dev-passkey-2");

  await dev(page, "losePasskey");
  await page.getByTestId("passkey-replace").click();
  await expect(page.getByTestId("passkey-replace-error")).toContainText("confirma primero con la actual");
  expect(await ref()).toBe("dev-passkey-2");
});

test("sign out everywhere else: needs a passkey; revokes every other client server-side and tells each computer", async ({
  page,
}) => {
  await ready(page, "/dispositivos");
  const { other } = await ids(page);
  await expect(page.getByTestId("everywhere-needs-passkey")).toBeVisible();
  await page.getByRole("button", { name: "Crear passkey" }).click();
  await expect(page.getByTestId("passkey-enrolled")).toBeVisible();

  await page.getByTestId("everywhere").click();
  await expect(page.getByText("¿Cerrar sesión en todos los demás teléfonos y navegadores?")).toBeVisible();
  await page.getByTestId("everywhere-yes").click();
  // Each signed revoke to a computer is stepped up (R-L1), then the server's assertion.
  await page.getByRole("dialog").getByRole("button", { name: "Confirmar" }).click();
  await expect(page.getByTestId("everywhere-result")).toContainText("Se cerró la sesión en 1 dispositivo.");
  await expect(page.getByTestId("everywhere-agent")).toHaveText("Laptop de Aldo: los quitó de su lista.");

  const writes = await clientWrites(page);
  const call = writes.find((w) => w.op === "devices/revoke-all")!;
  expect((call.row.commands as unknown[]).length).toBe(1);
  expect((await rows(page, "devices")).find((d) => d.device_id === other)?.revoked).toBe(true);
  await expect.poll(() => dev(page, "agentDropped", other)).toBe(true);
  // This browser stays signed in.
  await expect(page.locator(`[data-device="${other}"]`).getByTestId("presence")).toHaveText("Retirado");
});
