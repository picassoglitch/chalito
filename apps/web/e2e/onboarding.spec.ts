import { expect, signedIn, test } from "./fixtures";

test("onboarding completes with 'Saltar' on the companion step and lands with the default companion", async ({
  page,
}) => {
  await signedIn(page);
  await page.goto("/bienvenida");
  await expect(page.getByTestId("signed-in")).toBeVisible();
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Elige a tu compañero");
  await page.getByRole("button", { name: "Saltar" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ponle nombre");
  for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Conecta tu computadora");
  await page.getByRole("button", { name: "Terminar" }).click();
  await expect(page).toHaveURL(/127\.0\.0\.1:3100\/$/);
  await expect(page.getByTestId("home-companion")).toHaveText("Tu compañero: Chalito");
});

test("signed out, onboarding can't get past sign-in", async ({ page }) => {
  await page.goto("/bienvenida");
  await expect(page.getByRole("button", { name: "Continuar" })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Entrar con Chalyb" })).toHaveAttribute("href", "https://hub.example");
});

test("the phone step shows the charges notice once WhatsApp is on (EN)", async ({ page }) => {
  await signedIn(page);
  await page.goto("/en/welcome");
  for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your phone");
  await page.getByLabel("Country or region").selectOption("BR");
  await page.getByLabel("Number").fill("11 91234 5678");
  await page.getByRole("switch", { name: /Calls/ }).check();
  await expect(page.getByTestId("charges-notice")).toHaveText("Charges may apply.");
});
