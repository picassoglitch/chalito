import { expect, test, type Page } from "@playwright/test";
import { clientWrites, dev, ready, rows } from "./helpers";

type Sess = { access_token: string; role: string } | null;
/** An older app (no sign-in approval) showing its endorsement code. */
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

test("ADR 0032: signing in approves this browser by itself — no code, no trusted device", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("chalito.dev.paired", "0"));
  await page.goto("/bandeja");
  // Straight into the live inbox, as this browser's own device.
  await expect(page.getByTestId("test-mode")).toBeVisible();
  await expect(page.getByTestId("gate-unpaired")).toHaveCount(0);
  await page.waitForFunction(() => !!(window as unknown as { __chalitoDev?: unknown }).__chalitoDev);
  await expect.poll(async () => (await dev<Sess>(page, "session"))?.role).toBe("client");

  const writes = await clientWrites(page);
  const signin = writes.filter((w) => w.op === "devices/signin");
  expect(signin).toHaveLength(1);
  const reg = (signin[0]!.row.registration as { body: { name: string; kind: string } }).body;
  expect(reg).toMatchObject({ kind: "web", name: expect.stringMatching(/^Chrome (en|on) /) });
  expect(writes.map((w) => w.op)).not.toContain("endorse/codes");
  // The account's computer is trusted from the directory, introduced by the sign-in.
  const agent = await dev<string>(page, "agent");
  const trust = writes.find((w) => w.op === "trustIntroduced")!;
  expect(trust.row).toMatchObject({ agents: [agent], endorsedBy: "sign_in" });

  const me = await dev<string>(page, "me");
  expect((await rows(page, "devices")).find((r) => r.device_id === me)).toMatchObject({
    role: "client",
    kind: "web",
    revoked: false,
  });
});

test("/vincular when the sign-in can't approve: it says why, and Try again approves it", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("chalito.dev.paired", "0");
    window.localStorage.setItem("chalito.dev.signin", "fail");
  });
  await page.goto("/vincular");
  await expect(page.getByTestId("endorse-error")).toHaveAttribute("data-reason", "rejected");
  await page.waitForFunction(() => !!(window as unknown as { __chalitoDev?: unknown }).__chalitoDev);
  // Never a code to show, nor a wait for another device.
  await expect(page.getByTestId("endorse-code")).toHaveCount(0);
  expect((await dev<Sess>(page, "session"))?.role).toBe("user");

  await page.evaluate(() => window.localStorage.removeItem("chalito.dev.signin"));
  await page.getByTestId("endorse-retry").click();
  await expect(page.getByTestId("endorse-done")).toBeVisible();
  await expect.poll(async () => (await dev<Sess>(page, "session"))?.role).toBe("client");
});

test("an api without /v1/devices/signin: says so, and no endorsement code is opened", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("chalito.dev.paired", "0");
    window.localStorage.setItem("chalito.dev.signin", "404");
  });
  await page.goto("/en/link");
  await expect(page.getByTestId("endorse-error")).toHaveAttribute("data-reason", "unsupported");
  await page.waitForFunction(() => !!(window as unknown as { __chalitoDev?: unknown }).__chalitoDev);
  expect((await clientWrites(page)).map((w) => w.op)).not.toContain("endorse/codes");
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

test("R-L13: a computer that refused an endorsement shows a security notice on /dispositivos", async ({ page }) => {
  await ready(page, "/dispositivos");
  const other = await dev<string>(page, "other");
  await endorse(page, "refusedByAgent", other, "missing_step_up");
  await expect(page.getByTestId("endorse-refused")).toHaveAttribute("data-reason", "missing_step_up");
  await expect(page.getByTestId("endorse-refused")).toContainText("Laptop de Aldo rechazó un dispositivo nuevo");
});
