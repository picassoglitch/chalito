import { expect, test } from "./fixtures";

test("privacy and terms render from config with the draft banner, linked from the footer (ES/EN)", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("contentinfo").getByRole("link", { name: "Aviso de privacidad" }).click();
  await expect(page).toHaveURL(/\/privacidad$/);
  await expect(page.getByTestId("legal-draft")).toContainText("Borrador: pendiente de revisión legal");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Aviso de privacidad de Chalito");
  await expect(page.getByTestId("legal-privacy")).toContainText("ARCO");

  await page.getByRole("contentinfo").getByRole("link", { name: "Términos de uso" }).click();
  await expect(page).toHaveURL(/\/terminos$/);
  // The Developer-mode clause, verbatim from packages/config/legal (version 1).
  await expect(page.getByTestId("legal-terms").locator("blockquote")).toContainText("la responsabilidad es mía");
  await expect(page.getByTestId("legal-terms")).toContainText("versión 1");
  // The terms' own link to the privacy notice stays inside the app.
  await expect(page.getByTestId("legal-terms").getByRole("link", { name: "Aviso de privacidad" })).toHaveAttribute(
    "href",
    "/privacidad",
  );

  await page.goto("/en/terms");
  await expect(page.getByTestId("legal-draft")).toContainText("Draft: pending legal review");
  await expect(page.getByTestId("legal-terms").getByRole("link", { name: "Privacy notice" })).toHaveAttribute(
    "href",
    "/en/privacy",
  );
  await page.goto("/en/privacy");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Chalito privacy notice");
});

test("onboarding's sign-in step links the terms and the privacy notice", async ({ page }) => {
  await page.goto("/bienvenida");
  const consent = page.getByTestId("legal-consent");
  await expect(consent).toContainText("Al continuar aceptas los Términos de uso y el Aviso de privacidad.");
  await expect(consent.getByRole("link", { name: "Términos de uso" })).toHaveAttribute("href", "/terminos");
  await expect(consent.getByRole("link", { name: "Aviso de privacidad" })).toHaveAttribute("href", "/privacidad");
});
