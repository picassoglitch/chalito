import { expect, test } from "@playwright/test";
import { clientWrites, dev, ready, rows } from "./helpers";

test("approve from the phone releases the session; HIGH needs step-up and cancelling sends nothing", async ({
  page,
}) => {
  await ready(page);
  const med = page.locator('[data-aid="apr_med_1"]');
  const high = page.locator('[data-aid="apr_high_1"]');
  await expect(med.getByTestId("risk-badge")).toHaveText("Medio");
  await expect(high.getByTestId("risk-badge")).toHaveText("Alto");
  await expect(med).toContainText("Write: notes.txt");
  await expect(high).toContainText("Bash: rm -rf dist");

  await med.getByRole("button", { name: "Aprobar" }).click();
  await expect(page.locator('[data-aid="apr_med_1"]').getByTestId("approval-status")).toHaveText("Aprobada");

  // HIGH without a passkey: approving is blocked and the card says why, with a way to enrol.
  await expect(high.getByTestId("needs-passkey")).toBeVisible();
  await expect(high.getByRole("button", { name: "Aprobar" })).toBeDisabled();
  await page.getByRole("link", { name: "Dispositivos" }).click();
  await page.getByRole("button", { name: "Crear passkey" }).click();
  await expect(page.getByTestId("passkey-enrolled")).toBeVisible();
  await page.getByRole("link", { name: "Bandeja" }).click();
  await expect(high.getByTestId("needs-passkey")).toHaveCount(0);

  // HIGH: the step-up dialog; cancel → nothing written.
  const before = (await clientWrites(page)).filter((w) => w.table === "approval_decisions").length;
  await high.getByRole("button", { name: "Aprobar" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancelar" }).click();
  await expect(high).toContainText("Cancelado: no se envió nada.");
  expect((await clientWrites(page)).filter((w) => w.table === "approval_decisions").length).toBe(before);

  await high.getByRole("button", { name: "Aprobar" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirmar" }).click();
  await expect(page.locator('[data-aid="apr_high_1"]').getByTestId("approval-status")).toHaveText("Aprobada");

  // The simulated agent verified both signed decisions and moved on.
  const decisions = (await rows(page, "approval_decisions")).map(
    (r) => r.decision as { body: { aid: string; stepUp?: { method: string } } },
  );
  expect(decisions.find((d) => d.body.aid === "apr_high_1")!.body.stepUp?.method).toBe("platform_biometric");
  await page.getByRole("link", { name: "Sesiones" }).click();
  await page.getByTestId("session-row").first().click();
  await expect(page.getByTestId("session-state")).toHaveText("Trabajando");
  await expect(page.getByTestId("files-touched")).toHaveText("2");
});

test("the countdown runs and an unanswered approval expires as denied", async ({ page }) => {
  await ready(page);
  await dev(page, "seedApproval", { aid: "apr_soon", risk: "MED", ttlMs: 4000, summary: "Write: soon.txt" });
  const card = page.locator('[data-aid="apr_soon"]');
  await expect(card.getByTestId("countdown")).toHaveText(/^0:0[1-4]$/);
  await expect(card.getByTestId("approval-status")).toHaveText("Expiró: denegada", { timeout: 10_000 });
  await expect(card.getByRole("button", { name: "Aprobar" })).toHaveCount(0);
  await expect
    .poll(async () => (await rows(page, "approvals")).find((r) => r.aid === "apr_soon")?.status)
    .toBe("expired");
});

test("the /a/<id> deep link shows that approval", async ({ page }) => {
  await ready(page, "/a/apr_high_1");
  await expect(page.locator('[data-aid="apr_high_1"]')).toContainText("Bash: rm -rf dist");
  await page.goto("/en/a/apr_med_1");
  await expect(page.locator('[data-aid="apr_med_1"]').getByTestId("risk-badge")).toHaveText("Medium");
});

test("expired approvals say 'Expired: denied' in English too", async ({ page }) => {
  await ready(page, "/en/inbox");
  await dev(page, "seedApproval", { aid: "apr_soon_en", risk: "HIGH", ttlMs: 2000 });
  await expect(page.locator('[data-aid="apr_soon_en"]').getByTestId("approval-status")).toHaveText("Expired: denied", {
    timeout: 10_000,
  });
});
