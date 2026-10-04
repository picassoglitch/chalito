import { expect, test, type Page } from "@playwright/test";
import { clientWrites, ready, rows } from "./helpers";

const enrolPasskey = async (page: Page) => {
  await ready(page, "/dispositivos");
  await page.getByRole("button", { name: "Crear passkey" }).click();
  await expect(page.getByTestId("passkey-enrolled")).toBeVisible();
};

test("consent: who is asking and where you go back; session:prompt is never pre-checked; allow needs the passkey", async ({
  page,
}) => {
  await ready(page, "/oauth/consent?request=req_dev_1");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Claude quiere conectarse a Chalito");
  await expect(page.getByTestId("redirect-host")).toHaveText("claude.ai");
  await expect(page.locator('[data-scope="mcp:read"] input')).toBeChecked();
  await expect(page.locator('[data-scope="session:prompt"] input')).not.toBeChecked();
  await expect(page.getByTestId("consent-needs-passkey")).toBeVisible();
  await expect(page.getByRole("button", { name: "Permitir", exact: true })).toBeDisabled();

  await enrolPasskey(page);
  let landed = "";
  await page.route("https://claude.ai/**", async (r) => {
    landed = r.request().url();
    await r.fulfill({ body: "claude" });
  });
  await ready(page, "/oauth/consent?request=req_dev_1");
  await page.getByRole("button", { name: "Permitir", exact: true }).click();
  await expect.poll(() => landed).toContain("https://claude.ai/api/mcp/auth_callback?code=dev_code&state=st_dev");
});

test("consent: 'No permitir' sends access_denied back to the app", async ({ page }) => {
  let landed = "";
  await page.route("https://claude.ai/**", async (r) => {
    landed = r.request().url();
    await r.fulfill({ body: "claude" });
  });
  await ready(page, "/en/oauth/consent?request=req_dev_1");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Claude wants to connect to Chalito");
  await page.getByRole("button", { name: "Don't allow" }).click();
  await expect.poll(() => landed).toContain("error=access_denied");
});

test("consent: an unknown request says so", async ({ page }) => {
  await ready(page, "/oauth/consent?request=nope");
  await expect(page.locator("main [role=alert]")).toContainText("Esa solicitud ya no existe");
});

test("Apps conectadas: list and revoke with an inline confirmation", async ({ page }) => {
  await ready(page, "/ajustes");
  await page.getByRole("link", { name: "Apps conectadas" }).click();
  const row = page.locator('[data-cid="con_dev_gpt"]');
  await expect(row).toContainText("ChatGPT");
  await row.getByRole("button", { name: "Desconectar" }).click();
  await row.getByRole("button", { name: "Sí, desconectar" }).click();
  await expect(page.getByTestId("connector")).toHaveCount(0);
  expect(await clientWrites(page)).toContainEqual({
    table: "api",
    op: "connectors/revoke",
    row: { cid: "con_dev_gpt" },
  });
});

test("card sharing: off by default, on only after the plaintext warning is acknowledged, then off again", async ({
  page,
}) => {
  await ready(page, "/sesiones/s_dev_1");
  const box = page.getByTestId("sharing-session");
  const toggle = box.getByRole("switch", { name: "Compartir tarjeta con apps conectadas" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(box.getByRole("note")).toContainText("sin cifrar");
  await expect(box.getByRole("button", { name: "Compartir" })).toBeDisabled();
  await box.getByLabel("Entiendo que se guarda sin cifrar.").check();
  await box.getByRole("button", { name: "Compartir" }).click();
  await expect(toggle).toBeChecked();
  await expect
    .poll(async () => (await rows(page, "mcp_sharing"))[0])
    .toMatchObject({ scope: "session", target: "s_dev_1", enabled: true });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(async () => (await rows(page, "mcp_sharing"))[0]?.enabled).toBe(false);
  const sharing = (await clientWrites(page)).filter((w) => w.op === "mcp/sharing").map((w) => w.row);
  expect(sharing).toEqual([
    { scope: "session", target: "s_dev_1", enabled: true, plaintextAck: true },
    { scope: "session", target: "s_dev_1", enabled: false, plaintextAck: false },
  ]);
});

test("card sharing per computer on /dispositivos", async ({ page }) => {
  await ready(page, "/dispositivos");
  const box = page.getByTestId("sharing-device");
  await box.getByRole("switch").click();
  await box.getByLabel("Entiendo que se guarda sin cifrar.").check();
  await box.getByRole("button", { name: "Compartir" }).click();
  await expect(box.getByRole("switch")).toBeChecked();
  await expect.poll(async () => (await rows(page, "mcp_sharing"))[0]).toMatchObject({ scope: "device", enabled: true });
});
