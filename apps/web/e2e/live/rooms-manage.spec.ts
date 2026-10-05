import { expect, test, type Page } from "@playwright/test";
import { ids, ready } from "./helpers";

type Row = Record<string, unknown>;
/** window.__chalitoDev.rooms.<fn>(...args) */
const rooms = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    ([f, a]) => {
      const r = (window as unknown as { __chalitoDev: { rooms: Record<string, unknown> } }).__chalitoDev.rooms;
      const v = r[f as string];
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown)(...(a as unknown[])) : v;
    },
    [fn, args] as const,
  ) as Promise<T>;
const log = (page: Page) => rooms<Row[]>(page, "log");
/** The room row doesn't broadcast; the page re-reads it when the tab regains focus. */
const refocus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));

const openFamilia = async (page: Page) => {
  await page.addInitScript(() => window.localStorage.setItem("chalito.dev.rooms", "1"));
  await ready(page, "/salas");
  await page.getByTestId("room-link").filter({ hasText: "Familia" }).click();
  await expect(page.getByRole("heading", { name: "Familia" })).toBeVisible();
};

test("Nueva sala: epoch 1 wrapped to every client device of this owner, created, opened, writable", async ({
  page,
}) => {
  await page.addInitScript(() => window.localStorage.setItem("chalito.dev.rooms", "1"));
  await ready(page, "/salas");
  const form = page.getByTestId("room-new");
  await form.getByLabel("Nombre").fill("Vecinos");
  await form.getByLabel("Tipo").selectOption("project");
  await form.getByRole("button", { name: "Crear sala" }).click();

  await expect(page).toHaveURL(/\/r\/room_[0-9a-f]{32}$/);
  await expect(page.getByRole("heading", { name: "Vecinos" })).toBeVisible();
  await expect(page.getByTestId("room-member").filter({ hasText: "creó la sala" })).toContainText("Tú");
  const { me, other } = await ids(page);
  expect((await log(page)).find((r) => r.op === "create")).toMatchObject({ devices: [me, other].sort() });

  // The key works: a notice posts and reads back.
  await page.getByTestId("room-composer").fill("Hola vecinos");
  await page.getByRole("button", { name: "Enviar" }).click();
  await expect(page.getByTestId("room-event-text").filter({ hasText: "Hola vecinos" })).toBeVisible();
});

test("Invitar: a glyph signed by this device plus a one-time code; the guest shows up as a member", async ({
  page,
}) => {
  await openFamilia(page);
  await page.getByTestId("room-invite").getByRole("button", { name: "Invitar" }).click();
  const code = (await page.getByTestId("room-invite-code").textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await expect(page.getByTestId("room-invite").locator("canvas")).toBeVisible();
  expect((await log(page)).find((r) => r.op === "invite")).toMatchObject({
    purpose: "room_invite",
    signedByMe: true,
    maxUses: 1,
  });

  await rooms(page, "anaLeaves");
  await rooms(page, "anaJoins", code);
  await refocus(page);
  await expect(page.getByTestId("room-member")).toHaveCount(2);
});

test("Quitar de la sala (owner) → the room asks for a key rotation → new epoch to the remaining members only", async ({
  page,
}) => {
  await openFamilia(page);
  const { ana } = await rooms<{ ana: string }>(page, "seed");
  const anaRow = page.locator(`[data-testid="room-member"][data-companion="${ana}"]`);
  // Never on yourself.
  await expect(
    page.getByTestId("room-member").filter({ hasText: "Tú" }).getByRole("button", { name: "Quitar de la sala" }),
  ).toHaveCount(0);
  await anaRow.getByRole("button", { name: "Quitar de la sala" }).click();
  await anaRow.getByRole("button", { name: "Sí, quitar" }).click();
  await expect(page.getByTestId("room-member")).toHaveCount(1);
  expect((await log(page)).find((r) => r.op === "remove")).toMatchObject({ target: ana });

  const rotation = page.getByTestId("room-rotation");
  await expect(rotation).toContainText("cambia la llave");
  await rotation.getByRole("button", { name: "Rotar la llave" }).click();
  await expect(rotation).toHaveCount(0);
  const { me } = await rooms<{ me: string }>(page, "seed");
  expect((await log(page)).find((r) => r.op === "rotate")).toMatchObject({ epoch: 2, companions: [me] });

  // Writing works again, under the new key.
  await page.getByTestId("room-composer").fill("Ya con llave nueva");
  await page.getByRole("button", { name: "Enviar" }).click();
  await expect(page.getByTestId("room-event-text").filter({ hasText: "Ya con llave nueva" })).toBeVisible();
});

test("someone else leaving shows the rotation prompt too", async ({ page }) => {
  await openFamilia(page);
  await expect(page.getByTestId("room-rotation")).toHaveCount(0);
  await rooms(page, "anaLeaves");
  await refocus(page);
  await expect(page.getByTestId("room-rotation")).toBeVisible();
});

test("owner settings: retention, then dissolving (with a confirmation) ends the room", async ({ page }) => {
  await openFamilia(page);
  const owner = page.getByTestId("room-owner");
  await expect(owner.getByLabel("Los mensajes duran")).toHaveValue("PT24H");
  await owner.getByLabel("Los mensajes duran").selectOption("P7D");
  await owner.getByLabel("Guardar los registros que alguien conserve").uncheck();
  await owner.getByRole("button", { name: "Guardar" }).click();
  await expect(owner.getByTestId("room-retention-saved")).toBeVisible();
  expect((await log(page)).find((r) => r.op === "retention")).toMatchObject({
    ephemeralTtl: "P7D",
    keepPromoted: false,
  });

  await owner.getByRole("button", { name: "Disolver sala" }).click();
  await expect(owner).toContainText("No se puede deshacer.");
  await owner.getByRole("button", { name: "Sí, disolver" }).click();
  await expect(page.getByTestId("room-ended")).toHaveAttribute("data-reason", "dissolved");
  expect((await log(page)).some((r) => r.op === "dissolve")).toBe(true);
});

test("a member (not the owner) gets no owner settings and can't remove anyone", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("chalito.dev.rooms", "1"));
  await ready(page, "/salas");
  await page.getByTestId("room-join-code").fill(await rooms<string>(page, "inviteCode"));
  await page.getByRole("button", { name: "Unirse" }).click();
  await expect(page.getByRole("heading", { name: "Proyecto" })).toBeVisible();
  await expect(page.getByTestId("room-owner")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Quitar de la sala" })).toHaveCount(0);
  // Any member can still invite.
  await expect(page.getByTestId("room-invite").getByRole("button", { name: "Invitar" })).toBeVisible();
});

test("English: /en/rooms has New room", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("chalito.dev.rooms", "1"));
  await ready(page, "/en/rooms");
  await expect(page.getByTestId("room-new").getByRole("button", { name: "Create room" })).toBeVisible();
});
