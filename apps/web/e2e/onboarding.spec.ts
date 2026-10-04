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
  await expect(page.getByRole("link", { name: "Entrar con Chalyb" })).toHaveAttribute(
    "href",
    "https://hub.example/auth/launch/chalito",
  );
});

test("the phone step locks calls and WhatsApp until the number is verified (EN)", async ({ page }) => {
  await signedIn(page);
  await page.goto("/en/welcome");
  for (let i = 0; i < 5; i++) await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your phone");
  await page.getByLabel("Country or region").selectOption("BR");
  await page.getByLabel("Number").fill("11 91234 5678");
  await expect(page.getByText("We'll text you a code to verify it.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send code" })).toBeEnabled();
  await expect(page.getByRole("switch", { name: /Calls/ })).toBeDisabled();
  await expect(page.getByRole("switch", { name: /WhatsApp alerts/ })).toBeDisabled();
});
