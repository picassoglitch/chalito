import { expect, test } from "@playwright/test";
import { clientWrites, dev, ready } from "./helpers";

const SECRET = "SECRETO-7f3a plan de migración";

test("session detail: card, timeline, prompt, answer, interrupt/resume, modes capped at acceptEdits", async ({
  page,
}) => {
  await ready(page, "/sesiones/s_dev_1");
  await expect(page.getByTestId("session-card")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Agregar notas al README");
  await expect(page.locator('[data-type="message.assistant"]').first()).toContainText("Primero necesito tu aprobación");
  await expect(page.locator('[data-type="message.assistant"]').first()).toContainText("Agente");
  await expect(page.locator('[data-type="session.started"]')).toContainText("Sesión iniciada");

  await expect(page.getByTestId("permission-mode").locator("option")).toHaveText([
    "Preguntar",
    "Solo planear",
    "Aceptar ediciones",
  ]);
  const values = await page
    .getByTestId("permission-mode")
    .locator("option")
    .evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value));
  expect(values).toEqual(["default", "plan", "acceptEdits"]);
  await page.getByTestId("permission-mode").selectOption("acceptEdits");
  await expect(page.getByTestId("permission-mode")).toHaveValue("acceptEdits");

  await page.getByLabel("Mensaje").fill(SECRET);
  await page.getByRole("button", { name: "Enviar" }).click();
  await expect(page.locator('[data-type="message.assistant"]').last()).toContainText(`Recibido: ${SECRET}`);

  await dev(page, "askQuestion", "q1", "¿Qué rama uso?", ["main", "dev"]);
  const q = page.getByTestId("question");
  await q.getByLabel("dev").check();
  await q.getByRole("button", { name: "Responder" }).click();
  await expect(page.getByText("Respuesta enviada.")).toBeVisible();

  await page.getByRole("button", { name: "Interrumpir" }).click();
  await expect(page.getByTestId("session-state")).toHaveText("Interrumpida");
  await page.getByRole("button", { name: "Reanudar" }).click();
  await expect(page.getByTestId("session-state")).toHaveText("Trabajando");

  // What the agent received, opened with ITS key: the prompt and the answer.
  const inbox = await dev<{ type: string; text: unknown }[]>(page, "agentInbox");
  expect(inbox).toEqual(
    expect.arrayContaining([
      { type: "session.prompt", text: SECRET },
      { type: "session.answer", text: { "¿Qué rama uso?": "dev" } },
    ]),
  );
});

test("ciphertext only: nothing the browser writes to Supabase contains the prompt or answer in clear", async ({
  page,
}) => {
  await ready(page, "/sesiones/s_dev_1");
  await page.getByLabel("Mensaje").fill(SECRET);
  await page.getByRole("button", { name: "Enviar" }).click();
  await expect(page.locator('[data-type="message.assistant"]').last()).toContainText(SECRET);
  await page.goto("/bandeja");
  await page.waitForFunction(() => !!(window as unknown as { __chalitoDev?: unknown }).__chalitoDev);
  await page.locator('[data-aid="apr_med_1"]').getByRole("button", { name: "Denegar" }).click();
  await expect(page.locator('[data-aid="apr_med_1"]').getByTestId("approval-status")).toHaveText("Denegada");

  const writes = await clientWrites(page);
  expect(writes.length).toBeGreaterThan(0);
  const dump = JSON.stringify(writes);
  expect(dump).not.toContain("SECRETO-7f3a");
  expect(dump).not.toContain("Write: notes.txt");
  for (const w of writes.filter((x) => x.table === "commands")) {
    const p = (w.row.env as { body: { payload: Record<string, unknown> } }).body.payload;
    if ("promptCt" in p) expect(p.promptCt).toMatchObject({ ct: expect.any(String) });
  }
});

test("sessions list links to the detail (EN)", async ({ page }) => {
  await ready(page, "/en/sessions");
  await page.getByTestId("session-row").first().click();
  await expect(page).toHaveURL(/\/en\/sessions\/s_dev_1$/);
  await expect(page.getByTestId("permission-mode").locator("option")).toHaveText(["Ask", "Plan only", "Accept edits"]);
});
