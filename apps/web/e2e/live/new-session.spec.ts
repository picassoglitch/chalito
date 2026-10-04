import { expect, test } from "@playwright/test";
import { clientWrites, dev, ready } from "./helpers";

test("Nueva sesión: a signed, sealed session.start to the paired computer opens the new session", async ({ page }) => {
  await ready(page, "/sesiones");
  await page.getByRole("link", { name: "Nueva sesión" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nueva sesión");

  const form = page.getByTestId("new-session");
  await expect(form.getByRole("combobox", { name: /^Computadora/ })).toContainText("Laptop de Aldo · en línea");
  // Workspaces the computer's sessions have used (Chalito never sees its paths).
  await form.getByRole("button", { name: "chalito" }).click();
  await expect(form.getByLabel("Espacio de trabajo")).toHaveValue("chalito");
  await form.getByLabel("Codex").check();
  await form.getByLabel("Modo").selectOption("plan");
  await form.getByLabel("Primer mensaje").fill("Revisa los tests que fallan");
  await form.getByRole("button", { name: "Iniciar sesión" }).click();

  await expect(page).toHaveURL(/\/sesiones\/s_dev_new_1$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Revisa los tests que fallan");
  expect(await dev(page, "agentInbox")).toContainEqual({ type: "session.start", text: "Revisa los tests que fallan" });

  // The command row carries the prompt sealed, never in the clear.
  const commands = (await clientWrites(page)).filter((w) => w.table === "commands");
  expect(commands).toHaveLength(1);
  const raw = JSON.stringify(commands[0]!.row);
  expect(raw).not.toContain("Revisa los tests");
  expect(raw).toContain("session.start");
});

test("a workspace the computer doesn't allow: it never starts, and the page says what to check", async ({ page }) => {
  await page.clock.install();
  await ready(page, "/sesiones/nueva");
  const form = page.getByTestId("new-session");
  await form.getByLabel("Espacio de trabajo").fill("/home/aldo/secret");
  await form.getByLabel("Primer mensaje").fill("Hola");
  await form.getByRole("button", { name: "Iniciar sesión" }).click();
  await expect(form.getByRole("status")).toHaveText("Enviado. Esperando a que tu computadora la inicie…");
  await page.clock.fastForward(31_000);
  await expect(form.getByTestId("start-timeout")).toContainText("que ese espacio de trabajo exista");
  await expect(page).toHaveURL(/\/sesiones\/nueva$/);
  // The form is usable again.
  await expect(form.getByRole("button", { name: "Iniciar sesión" })).toBeEnabled();
});

test("English: /en/sessions/new", async ({ page }) => {
  await ready(page, "/en/sessions/new");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("New session");
  await expect(page.getByLabel("Claude Code")).toBeChecked();
});
