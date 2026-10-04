import { expect, test } from "@playwright/test";
import { clientWrites, ready, rows } from "./helpers";

test("settings live on the server: acknowledge charges, verify the phone (code), turn calls on through the api", async ({
  page,
}) => {
  await ready(page, "/ajustes");
  await expect(page.getByTestId("persisted")).toHaveAttribute("data-where", "server");
  await expect(page.getByRole("switch", { name: /Llamadas/ })).toBeDisabled();

  await page.getByLabel("Número").fill("55 1234 5678");
  // The api refuses to send a code before the charges notice is acknowledged.
  await expect(page.getByRole("button", { name: "Enviar código" })).toBeDisabled();
  await page.getByLabel("Entiendo que pueden aplicar cargos.").check();
  await page.getByRole("button", { name: "Enviar código" }).click();
  await expect(page.getByText("Te enviamos un código a +525512345678.")).toBeVisible();
  await page.getByLabel("Código").fill("000000");
  await page.getByRole("button", { name: "Verificar" }).click();
  await expect(page.getByText("Ese código no es correcto.")).toBeVisible();
  await page.getByLabel("Código").fill("123456");
  await page.getByRole("button", { name: "Verificar" }).click();
  await expect(page.getByTestId("phone-verified")).toContainText("+525512345678");

  await page.getByRole("switch", { name: /Llamadas/ }).check();
  await expect.poll(async () => (await rows(page, "users"))[0]!.calls_enabled).toBe(true);
  // Turned on through /v1/phone/channels, never through the settings RPC.
  const writes = await clientWrites(page);
  expect(writes).toContainEqual({ table: "api", op: "phone/channels", row: { calls: true } });
  const rpcPatches = writes.filter((w) => w.op === "rpc:update_my_settings").map((w) => w.row);
  for (const p of rpcPatches) {
    expect(p.calls_enabled).not.toBe(true);
    expect(p.whatsapp_opt_in).not.toBe(true);
    expect(Object.keys(p)).not.toContain("phone_e164");
  }
  expect(rpcPatches).toContainEqual({ phone_pending_e164: "+525512345678" });

  await page.getByLabel("Personalizado").check();
  await expect.poll(async () => (await rows(page, "users"))[0]!.quiet_hours).toEqual({ start: "22:00", end: "08:00" });
  await page.getByLabel("Sin horas de silencio").check();
  await expect.poll(async () => (await rows(page, "users"))[0]!.quiet_hours).toEqual({ off: true });
});

test("calls to a country that can't be dialled are refused with a clear message", async ({ page }) => {
  await ready(page, "/ajustes");
  await page.getByLabel("Entiendo que pueden aplicar cargos.").check();
  await page.getByLabel("País o región").selectOption("JP");
  await page.getByLabel("Número").fill("090-1234-5678");
  await page.getByRole("button", { name: "Enviar código" }).click();
  await page.getByLabel("Código").fill("123456");
  await page.getByRole("button", { name: "Verificar" }).click();
  await expect(page.getByTestId("phone-verified")).toBeVisible();
  // click(), not check(): the refused toggle snaps back, which is the point.
  await page.getByRole("switch", { name: /Llamadas/ }).click();
  await expect(page.locator("main [role=alert]")).toHaveText("Las llamadas a este país no están disponibles.");
  await expect(page.getByRole("switch", { name: /Llamadas/ })).not.toBeChecked();
  expect((await rows(page, "users"))[0]!.calls_enabled).toBe(false);
});

test("a number already on another account says so", async ({ page }) => {
  await ready(page, "/ajustes");
  await page.getByLabel("Entiendo que pueden aplicar cargos.").check();
  await page.getByLabel("Número").fill("55 0000 0000");
  await page.getByRole("button", { name: "Enviar código" }).click();
  await page.getByLabel("Código").fill("123456");
  await page.getByRole("button", { name: "Verificar" }).click();
  await expect(page.getByText("Ese número ya está en otra cuenta.")).toBeVisible();
});

test("onboarding on the server: 'Saltar' creates the default companion and stamps onboarded_at", async ({ page }) => {
  await ready(page, "/bienvenida");
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Saltar" }).click();
  for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Continuar" }).click();
  // Right after pairing: protect approvals with a passkey.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Protege tus aprobaciones");
  await page.getByRole("button", { name: "Crear passkey" }).click();
  await expect(page.getByTestId("passkey-enrolled")).toBeVisible();
  await page.getByRole("button", { name: "Terminar" }).click();
  await expect(page.getByTestId("home-companion")).toHaveText("Tu compañero: Chalito");
  expect(await rows(page, "companions")).toEqual([
    expect.objectContaining({ name: "Chalito", avatar: "chalito", is_renamed: false }),
  ]);
  expect(((await rows(page, "users"))[0]!.prefs as { onboarded_at?: string }).onboarded_at).toEqual(expect.any(String));
});
