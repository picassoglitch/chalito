import { expect, test, type Page } from "@playwright/test";
import { clientWrites, ready } from "./helpers";

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

const openRoom = async (page: Page) => {
  await page.addInitScript(() => window.localStorage.setItem("chalito.dev.rooms", "1"));
  await ready(page, "/salas");
  await page.getByTestId("room-link").filter({ hasText: "Familia" }).click();
  await expect(page.getByRole("heading", { name: "Familia" })).toBeVisible();
};

test("a room: decrypted messages as text, post a notice, members", async ({ page }) => {
  await openRoom(page);
  const text = page.getByTestId("room-event-text").first();
  await expect(text).toHaveText("Llego a las 7, ¿alguien pasa por pan? <b>no es HTML</b>");
  // Shown as text, never markup.
  await expect(page.getByTestId("room").locator("blockquote b")).toHaveCount(0);
  await expect(page.getByTestId("room-member")).toHaveCount(2);
  await expect(page.getByTestId("room-member").filter({ hasText: "Tú" })).toHaveCount(1);

  await page.getByTestId("room-composer").fill("Yo paso por el pan");
  await page.getByRole("button", { name: "Enviar" }).click();
  await expect(page.getByTestId("room-event-text").filter({ hasText: "Yo paso por el pan" })).toBeVisible();
  // What went to the server is ciphertext only.
  const post = (await clientWrites(page)).find((w) => w.op.endsWith("/events"))!;
  expect(JSON.stringify(post.row)).not.toContain("Yo paso por el pan");

  // New messages arrive on the feed's pointer.
  await rooms(page, "postAsAna", "Perfecto");
  await expect(page.getByTestId("room-event-text").filter({ hasText: "Perfecto" })).toBeVisible();
});

test("report: an event without its text unless the box is ticked, a member, duplicates", async ({ page }) => {
  await openRoom(page);
  const event = page.getByTestId("room-event").first();
  await event.getByRole("button", { name: "Reportar" }).click();
  await expect(page.getByTestId("room-report-attach")).not.toBeChecked();
  await page.getByLabel("Acoso o abuso").check();
  await page.getByRole("button", { name: "Enviar reporte" }).click();
  await expect(page.getByTestId("room-note")).toHaveText("Reporte enviado. Gracias.");
  let reports = await rooms<Row[]>(page, "reports");
  expect(reports[0]).toMatchObject({ reason: "abuse", plaintext: null, member: null });

  await page.getByTestId("room-member").filter({ hasNotText: "Tú" }).getByRole("button", { name: "Reportar" }).click();
  await expect(page.getByTestId("room-report-attach")).toHaveCount(0); // no text to attach for a member
  await page.getByRole("button", { name: "Enviar reporte" }).click();
  reports = await rooms<Row[]>(page, "reports");
  expect(reports[1]).toMatchObject({ eventId: null, reason: "spam", plaintext: null });

  // Opting in sends the reporter's own decrypted text (a repeat of the same target is a duplicate).
  await event.getByRole("button", { name: "Reportar" }).click();
  await page.getByTestId("room-report-attach").check();
  await page.getByRole("button", { name: "Enviar reporte" }).click();
  await expect(page.getByTestId("room-note")).toHaveText("Ya habías reportado esto.");
});

test("kicked, dissolved, left: the feed stops and the room says why", async ({ page }) => {
  await openRoom(page);
  await rooms(page, "kickMe");
  await expect(page.getByTestId("room-ended")).toHaveAttribute("data-reason", "kicked");
  await expect(page.getByTestId("room-composer")).toHaveCount(0);
  await rooms(page, "postAsAna", "ya no deberías ver esto");
  await expect(page.getByText("ya no deberías ver esto")).toHaveCount(0);

  await page.reload();
  await ready(page, "/salas");
  await page.getByTestId("room-link").filter({ hasText: "Familia" }).click();
  await expect(page.getByTestId("room-event-text").first()).toBeVisible(); // the feed is live
  await rooms(page, "dissolve");
  await expect(page.getByTestId("room-ended")).toHaveAttribute("data-reason", "dissolved");

  await page.reload();
  await ready(page, "/salas");
  await page.getByTestId("room-link").filter({ hasText: "Familia" }).click();
  await page.getByRole("button", { name: "Salir de la sala" }).click();
  await page.getByRole("button", { name: "Sí, salir" }).click();
  await expect(page.getByTestId("room-ended")).toHaveAttribute("data-reason", "left");
});

test("revoked device: the room feed stops too", async ({ page }) => {
  await openRoom(page);
  await page.evaluate(() => (window as unknown as { __chalitoDev: { revokeMe(): void } }).__chalitoDev.revokeMe());
  await expect(page.getByTestId("gate-revoked")).toBeVisible();
});

test("join with a code (and a bad code says so); EN path /en/rooms", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("chalito.dev.rooms", "1"));
  await ready(page, "/salas");
  await page.getByTestId("room-join-code").fill("AAAA-BBBB");
  await page.getByRole("button", { name: "Unirse" }).click();
  await expect(page.getByTestId("room-join-error")).toHaveText("Ese código no es válido o ya se usó.");
  await page.getByTestId("room-join-code").fill(await rooms<string>(page, "inviteCode"));
  await page.getByRole("button", { name: "Unirse" }).click();
  await expect(page.getByRole("heading", { name: "Proyecto" })).toBeVisible();
  await expect(page.getByTestId("room-no-key")).toHaveCount(0);

  await page.goto("/en/rooms");
  await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();
});

test("Salas in the nav; the list shows members and a 'Nuevo' marker until the room is opened; the stage", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => window.localStorage.setItem("chalito.dev.rooms", "1"));
  await ready(page, "/bandeja");
  await page.getByRole("link", { name: "Salas" }).click();
  const familia = page.getByTestId("room-link").filter({ hasText: "Familia" });
  await expect(familia).toContainText("2 miembros");
  await expect(familia.getByTestId("room-unread")).toHaveText("Nuevo");

  await familia.click();
  await expect(page.getByTestId("room-event-text").first()).toBeVisible();
  // The 3D stage gets metadata only; it's there (or hidden without WebGL) and never errors.
  expect(await page.getByTestId("room-stage").count()).toBeLessThanOrEqual(1);

  await page.getByRole("link", { name: "Salas" }).click();
  await expect(page.getByTestId("room-link").filter({ hasText: "Familia" }).getByTestId("room-unread")).toHaveCount(0);
  // The room's feed has closed (its view is gone) before Ana writes again.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __chalitoDev: { db: { openTopics(): string[] } } }).__chalitoDev.db
          .openTopics()
          .filter((t) => t.startsWith("chalito:room:")),
      ),
    )
    .toEqual([]);
  // Client-side navigation only (a full load would restart the in-browser mock).
  await page.evaluate(() => ((window as unknown as { __sameDoc: boolean }).__sameDoc = true));
  await rooms(page, "postAsAna", "¿Cenamos juntos?");
  await page.getByRole("link", { name: "Bandeja" }).click();
  await expect(page).toHaveURL(/\/bandeja$/);
  await page.getByRole("link", { name: "Salas" }).click();
  await expect(page.getByTestId("rooms")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __sameDoc?: boolean }).__sameDoc)).toBe(true);
  await expect(page.getByTestId("room-link").filter({ hasText: "Familia" }).getByTestId("room-unread")).toBeVisible();
  expect(errors).toEqual([]);
});

test("prefetches of app routes resolve (the proxy's locale rewrite applies to them)", async ({ page }) => {
  const missing: string[] = [];
  page.on("response", (r) => {
    if (r.status() === 404 && r.url().includes("_rsc=")) missing.push(r.url());
  });
  await page.addInitScript(() => window.localStorage.setItem("chalito.dev.rooms", "1"));
  await ready(page, "/salas");
  await page.getByTestId("room-link").filter({ hasText: "Familia" }).hover();
  await page.getByTestId("room-link").filter({ hasText: "Familia" }).click();
  await expect(page.getByTestId("room-event-text").first()).toBeVisible();
  expect(missing).toEqual([]);
});
