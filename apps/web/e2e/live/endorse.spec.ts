import { expect, test, type Page } from "@playwright/test";
import { clientWrites, dev, ready, rows } from "./helpers";

type Sess = { access_token: string; role: string } | null;
interface NewBrowser {
  codeId: string;
  shortCode: string;
  deviceId: string;
  fingerprint: string;
}

/** window.__chalitoDev.endorse.<fn>(...args) */
const endorse = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    ([f, a]) =>
      (window as unknown as { __chalitoDev: { endorse: Record<string, (...x: unknown[]) => unknown> } }).__chalitoDev
        .endorse[f as string]!(...(a as unknown[])),
    [fn, args] as const,
  ) as Promise<T>;

test("Esperando aprobación: a new browser shows a code, a trusted device approves, and it signs in as itself", async ({
  page,
}) => {
  await page.addInitScript(() => window.localStorage.setItem("chalito.dev.paired", "0"));
  await page.goto("/bandeja");
  await expect(page.getByTestId("gate-unpaired")).toBeVisible();
  await page.getByTestId("gate-link").click();
  await expect(page).toHaveURL(/\/vincular$/);
  await expect(page.getByTestId("endorse-name")).not.toHaveValue("");
  await page.getByTestId("endorse-name").fill("Chrome del estudio");
  await page.getByTestId("endorse-start-button").click();

  await expect(page.getByRole("heading", { name: "Esperando aprobación" })).toBeVisible();
  await expect(page.getByTestId("endorse-glyph")).toBeVisible();
  const code = (await page.getByTestId("endorse-code").textContent())!;
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  // Published as the person (role user), with the registration this browser signed.
  expect((await dev<Sess>(page, "session"))?.role).toBe("user");
  const opened = (await clientWrites(page)).find((w) => w.op === "endorse/codes")!;
  expect((opened.row.registration as { body: { name: string } }).body.name).toBe("Chrome del estudio");

  // "Navegador del trabajo" approves it, introducing the computer it trusts (ADR 0018).
  await endorse(page, "approveFromOther", code);
  await expect(page.getByTestId("endorse-done")).toBeVisible();
  await expect(page.getByTestId("endorse-introduced")).toContainText("Laptop de Aldo");
  const agent = await dev<string>(page, "agent");
  expect((await clientWrites(page)).find((w) => w.op === "trustIntroduced")?.row.agents).toEqual([agent]);
  await expect.poll(async () => (await dev<Sess>(page, "session"))?.role).toBe("client");
  const me = await dev<string>(page, "me");
  expect((await rows(page, "devices")).find((r) => r.device_id === me)).toMatchObject({
    role: "client",
    name: "Chrome del estudio",
    revoked: false,
  });
  // Introduced: prompts reach the computer right away (sealed to its key).
  const writes = (await clientWrites(page)).map((w) => w.op);
  expect(writes).toEqual(expect.arrayContaining(["endorse/take", "devices/endorsed"]));

  // The live screens open now, as this device.
  await page.getByRole("link", { name: "Ir a la bandeja" }).click();
  await expect(page.getByTestId("gate-unpaired")).toHaveCount(0);
  await expect(page.getByTestId("test-mode")).toBeVisible();
});

test("Esperando aprobación: cancelling goes back to the start, still as the person", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("chalito.dev.paired", "0"));
  await page.goto("/vincular");
  await page.getByTestId("endorse-start-button").click();
  await expect(page.getByTestId("endorse-code")).toBeVisible();
  await page.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByTestId("endorse-start")).toBeVisible();
  await expect(page.getByTestId("endorse-error")).toHaveCount(0);
  expect((await dev<Sess>(page, "session"))?.role).toBe("user");
});

test("Añadir un dispositivo: type the code, compare the fingerprint, approve with the passkey", async ({ page }) => {
  await ready(page, "/dispositivos");
  await page.getByRole("button", { name: "Crear passkey" }).click();
  await expect(page.getByTestId("passkey-enrolled")).toBeVisible();
  await page.getByTestId("add-device-link").click();
  await expect(page.getByRole("heading", { name: "Añadir un dispositivo" })).toBeVisible();

  // A wrong code first.
  await page.getByTestId("add-code").fill("AAAA-BBBB");
  await page.getByTestId("add-find").click();
  await expect(page.getByTestId("add-error")).toHaveAttribute("data-reason", "not_found");

  const nb = await endorse<NewBrowser>(page, "newBrowser", "Firefox en Linux");
  await page.getByTestId("add-code").fill(nb.shortCode.toLowerCase().replace("-", " "));
  await page.getByTestId("add-find").click();
  await expect(page.getByTestId("add-name")).toHaveText("Firefox en Linux");
  await expect(page.getByTestId("add-fingerprint")).toHaveText(nb.fingerprint);
  await expect(page.getByText("Al aprobar, te pediremos tu passkey.")).toBeVisible();

  // The step-up is a passkey assertion over the server's challenge (the mock's authenticator).
  await page.getByTestId("add-approve").click();
  await expect(page.getByTestId("add-done")).toContainText("Firefox en Linux");
  const me = await dev<string>(page, "me");
  // ADR 0018: this browser introduced its glyph-confirmed computer.
  expect(await endorse(page, "endorsementOf", nb.codeId)).toEqual({
    signer: me,
    newDeviceId: nb.deviceId,
    agents: [await dev<string>(page, "agent")],
  });
  const approve = (await clientWrites(page)).find((w) => w.op === "endorse/approve")!;
  // R-L13: the passkey signs the endorsement body itself (no separate top-level stepUp).
  expect(approve.row.stepUp).toBeUndefined();
  expect(
    (approve.row.endorsement as { body: { stepUp?: { assertion: { credentialId: string } } } }).body.stepUp?.assertion
      .credentialId,
  ).toBe("dev-passkey");

  // The same code can't be used twice.
  await page.getByRole("link", { name: "Volver a Dispositivos" }).click();
  await page.getByTestId("add-device-link").click();
  await page.getByTestId("add-code").fill(nb.shortCode);
  await page.getByTestId("add-find").click();
  await expect(page.getByTestId("add-error")).toHaveAttribute("data-reason", "already_endorsed");
});

test("Añadir un dispositivo: without a passkey there's no step-up; 'No es mío' signs nothing", async ({ page }) => {
  await ready(page, "/dispositivos/nuevo");
  const nb = await endorse<NewBrowser>(page, "newBrowser");
  await page.getByTestId("add-code").fill(nb.shortCode);
  await page.getByTestId("add-find").click();
  await expect(page.getByTestId("add-fingerprint")).toHaveText(nb.fingerprint);
  await page.getByRole("button", { name: "No es mío" }).click();
  await expect(page.getByTestId("add-input")).toBeVisible();
  expect(await endorse(page, "endorsementOf", nb.codeId)).toBeNull();
  expect((await clientWrites(page)).filter((w) => w.op === "endorse/approve")).toEqual([]);

  await page.getByTestId("add-code").fill(nb.shortCode);
  await page.getByTestId("add-find").click();
  await page.getByTestId("add-approve").click();
  await expect(page.getByTestId("add-done")).toBeVisible();
  const approve = (await clientWrites(page)).find((w) => w.op === "endorse/approve")!;
  expect((approve.row.endorsement as { body: { stepUp?: unknown } }).body.stepUp).toBeUndefined();
});

test("EN paths: /en/devices/new, and /en/link on a trusted browser says it's already trusted", async ({ page }) => {
  await ready(page, "/en/devices/new");
  await expect(page.getByRole("heading", { name: "Add a device" })).toBeVisible();
  await page.goto("/en/link");
  await expect(page.getByTestId("endorse-done")).toBeVisible();
});

test("ADR 0018: an introduced computer whose keys don't match the directory is dropped, with a way forward", async ({
  page,
}) => {
  await page.addInitScript(() => window.localStorage.setItem("chalito.dev.paired", "0"));
  await page.goto("/vincular");
  await page.getByTestId("endorse-start-button").click();
  const code = (await page.getByTestId("endorse-code").textContent())!;
  await endorse(page, "approveFromOther", code, "tampered");
  await expect(page.getByTestId("endorse-done")).toBeVisible();
  await expect(page.getByTestId("endorse-introduced")).toHaveCount(0);
  await expect(page.getByTestId("endorse-dropped").locator("li")).toHaveAttribute("data-reason", "key_mismatch");
  await expect(page.getByTestId("endorse-dropped")).toContainText("Emparéjala con su anillo");
  expect((await clientWrites(page)).filter((w) => w.op === "trustIntroduced")).toEqual([]);
});

test("R-L13: a computer that refused an endorsement shows a security notice on /dispositivos", async ({ page }) => {
  await ready(page, "/dispositivos");
  const other = await dev<string>(page, "other");
  await endorse(page, "refusedByAgent", other, "missing_step_up");
  await expect(page.getByTestId("endorse-refused")).toHaveAttribute("data-reason", "missing_step_up");
  await expect(page.getByTestId("endorse-refused")).toContainText("Laptop de Aldo rechazó un dispositivo nuevo");
});
