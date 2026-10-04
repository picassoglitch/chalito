import { expect, test } from "@playwright/test";
import { clientWrites, ready, rows } from "./helpers";

test("settings live on the server: verify the phone (code), acknowledge charges, then calls can go on", async ({
  page,
}) => {
  await ready(page, "/ajustes");
  await expect(page.getByTestId("persisted")).toHaveAttribute("data-where", "server");
  await expect(page.getByRole("switch", { name: /Llamadas/ })).toBeDisabled();

  await page.getByLabel("Número").fill("55 1234 5678");
  await page.getByRole("button", { name: "Enviar código" }).click();
  await expect(page.getByText("Te enviamos un código a +525512345678.")).toBeVisible();
  await page.getByLabel("Código").fill("000000");
  await page.getByRole("button", { name: "Verificar" }).click();
  await expect(page.getByText("Ese código no es correcto.")).toBeVisible();
  await page.getByLabel("Código").fill("123456");
  await page.getByRole("button", { name: "Verificar" }).click();
  await expect(page.getByTestId("phone-verified")).toContainText("+525512345678");

  await expect(page.getByRole("switch", { name: /Llamadas/ })).toBeDisabled();
  await page.getByLabel("Entiendo que pueden aplicar cargos.").check();
  await page.getByRole("switch", { name: /Llamadas/ }).check();
  await expect(page.getByTestId("charges-notice").first()).toHaveText("Pueden aplicar cargos.");
  await expect.poll(async () => (await rows(page, "users"))[0]!.calls_enabled).toBe(true);

  await page.getByLabel("Personalizado").check();
  await expect.poll(async () => (await rows(page, "users"))[0]!.quiet_hours).toEqual({ start: "22:00", end: "08:00" });
  await page.getByLabel("Sin horas de silencio").check();
  await expect.poll(async () => (await rows(page, "users"))[0]!.quiet_hours).toEqual({ off: true });

  // The browser proposed the number; it never wrote phone_e164 itself.
  const sent = (await clientWrites(page)).filter((w) => w.op === "rpc:update_my_settings").map((w) => w.row);
  expect(sent).toContainEqual({ phone_pending_e164: "+525512345678" });
  for (const p of sent) expect(Object.keys(p)).not.toContain("phone_e164");
});

test("onboarding on the server: 'Saltar' creates the default companion and stamps onboarded_at", async ({ page }) => {
  await ready(page, "/bienvenida");
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Saltar" }).click();
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("button", { name: "Terminar" }).click();
  await expect(page.getByTestId("home-companion")).toHaveText("Tu compañero: Chalito");
  expect(await rows(page, "companions")).toEqual([
    expect.objectContaining({ name: "Chalito", avatar: "chalito", is_renamed: false }),
  ]);
  expect(((await rows(page, "users"))[0]!.prefs as { onboarded_at?: string }).onboarded_at).toEqual(expect.any(String));
});
