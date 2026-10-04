import { expect, test, type Page } from "@playwright/test";
import { clientWrites, ready } from "./helpers";

const withPasskey = (page: Page) =>
  page.addInitScript(() =>
    localStorage.setItem("chalito.passkey.v1", JSON.stringify({ credentialId: "dev-passkey-1", rpId: "127.0.0.1" })),
  );

const apiCalls = async (page: Page) =>
  (await clientWrites(page)).filter((w) => w.table === "api" && w.op.includes("account/"));

test("Ajustes → Privacidad: delete with the passkey, see the 7-day countdown, download the export, cancel", async ({
  page,
}) => {
  await withPasskey(page);
  await ready(page, "/ajustes");
  const box = page.getByTestId("account-deletion");
  await expect(box).toHaveAttribute("data-state", "none");
  await expect(box.getByRole("button", { name: "Descargar mis datos" })).toHaveCount(0);

  await box.getByRole("button", { name: "Eliminar mi cuenta…" }).click();
  await expect(box).toContainText("Tu cuenta de Chalyb, tu plan y tus créditos no cambian.");
  const confirm = box.getByRole("button", { name: "Confirmar con mi passkey" });
  await expect(confirm).toBeDisabled();
  await box.getByLabel("Entiendo que esto borra mi cuenta de Chalito.").check();
  await confirm.click();

  await expect(box).toHaveAttribute("data-state", "scheduled");
  await expect(box.getByTestId("deletion-countdown")).toHaveText("Quedan 7 días y 0 horas para cancelarlo.");
  await expect(box.getByTestId("deletion-due")).toContainText("Tu cuenta de Chalito se eliminará el");
  // Sent with the passkey assertion as the step-up.
  const post = (await apiCalls(page)).find((w) => w.op === "POST account/deletion");
  expect(post?.row.stepUp).toEqual(expect.objectContaining({ type: "public-key" }));

  const download = page.waitForEvent("download");
  await box.getByRole("button", { name: "Descargar mis datos" }).click();
  expect((await download).suggestedFilename()).toBe("chalito-export.json");

  await box.getByRole("button", { name: "Cancelar la eliminación" }).click();
  await expect(box.getByTestId("account-note")).toHaveText("Listo: tu cuenta ya no se eliminará.");
  await expect(box).toHaveAttribute("data-state", "cancelled");
  expect((await apiCalls(page)).map((w) => w.op)).toContain("DELETE account/deletion");
});

test("without a passkey on this device it points to creating one, and requests nothing", async ({ page }) => {
  await ready(page, "/ajustes");
  const box = page.getByTestId("account-deletion");
  await box.getByRole("button", { name: "Eliminar mi cuenta…" }).click();
  await expect(box).toContainText("Para pedirlo, este dispositivo necesita una passkey.");
  await expect(box.getByRole("link", { name: "Crear passkey" })).toHaveAttribute("href", "/dispositivos");
  expect((await apiCalls(page)).filter((w) => w.op.startsWith("POST"))).toEqual([]);
});

test("English", async ({ page }) => {
  await withPasskey(page);
  await ready(page, "/en/settings");
  const box = page.getByTestId("account-deletion");
  await expect(box.getByRole("heading")).toHaveText("Delete my Chalito account");
  await box.getByRole("button", { name: "Delete my account…" }).click();
  await box.getByLabel("I understand this deletes my Chalito account.").check();
  await box.getByRole("button", { name: "Confirm with my passkey" }).click();
  await expect(box.getByTestId("deletion-countdown")).toHaveText("7 days and 0 hours left to cancel.");
});
