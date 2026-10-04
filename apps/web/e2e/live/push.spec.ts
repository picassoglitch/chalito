import { expect, test, type Page } from "@playwright/test";
import { clientWrites, ids, ready, rows } from "./helpers";

/**
 * The browser's side of Web Push is stubbed (headless Chromium has no push service): the
 * permission prompt answers `answer`, and PushManager hands out a fixed subscription. Everything
 * else is the app's real code: the service worker, the VAPID key, and the row it writes.
 */
const stubPush = (page: Page, answer: NotificationPermission) =>
  page.addInitScript((a) => {
    let permission: NotificationPermission = "default";
    let sub: unknown = null;
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => permission });
    Notification.requestPermission = async () => (permission = a);
    const w = window as unknown as { __pushKeyBytes?: number };
    PushManager.prototype.getSubscription = async () => sub as PushSubscription | null;
    PushManager.prototype.subscribe = async (o?: PushSubscriptionOptionsInit) => {
      w.__pushKeyBytes = (o?.applicationServerKey as Uint8Array | undefined)?.byteLength;
      const endpoint = "https://push.e2e.invalid/sub/1";
      sub = {
        endpoint,
        toJSON: () => ({ endpoint, keys: { p256dh: "BPub", auth: "authSecret" } }),
        unsubscribe: async () => ((sub = null), true),
      };
      return sub as PushSubscription;
    };
  }, answer);

test("Ajustes → Notificaciones: turning alerts on stores this device's subscription; off removes it", async ({
  page,
}) => {
  await stubPush(page, "granted");
  await ready(page, "/ajustes");
  const box = page.getByTestId("push-optin");
  await expect(box.getByRole("heading")).toHaveText("Notificaciones");
  await box.getByRole("button", { name: "Activar avisos en este dispositivo" }).click();
  await expect(box.getByTestId("push-on")).toHaveText("Los avisos están activos en este dispositivo.");

  // Subscribed with the configured VAPID public key (65 bytes), stored as THIS device's row.
  expect(await page.evaluate(() => (window as unknown as { __pushKeyBytes?: number }).__pushKeyBytes)).toBe(65);
  const { me } = await ids(page);
  expect(await rows(page, "push_subscriptions")).toEqual([
    expect.objectContaining({
      device_id: me,
      endpoint: "https://push.e2e.invalid/sub/1",
      p256dh: "BPub",
      auth: "authSecret",
    }),
  ]);
  expect((await clientWrites(page)).filter((w) => w.table === "push_subscriptions")).toHaveLength(1);

  await box.getByRole("button", { name: "Desactivar" }).click();
  await expect(box.getByRole("button", { name: "Activar avisos en este dispositivo" })).toBeVisible();
  await expect.poll(async () => (await rows(page, "push_subscriptions")).length).toBe(0);
});

test("a blocked prompt says how to undo it and stores nothing", async ({ page }) => {
  await stubPush(page, "denied");
  await ready(page, "/ajustes");
  await page.getByRole("button", { name: "Activar avisos en este dispositivo" }).click();
  await expect(page.getByTestId("push-optin")).toContainText("Actívalos en los ajustes de tu navegador.");
  expect(await rows(page, "push_subscriptions")).toEqual([]);
});

test("an unpaired browser is told to link first", async ({ page }) => {
  await stubPush(page, "granted");
  await page.addInitScript(() => window.localStorage.setItem("chalito.dev.paired", "0"));
  await page.goto("/ajustes");
  await expect(page.getByTestId("push-optin")).toContainText("Vincula este navegador para recibir avisos en él.");
  await expect(page.getByRole("button", { name: "Activar avisos en este dispositivo" })).toHaveCount(0);
});

test("the service worker's text is served from the catalogs", async ({ request }) => {
  const res = await request.get("/push-text.json");
  expect(res.ok()).toBe(true);
  expect(await res.json()).toMatchObject({
    es: { title: "Chalito", approval: "Hay una aprobación esperándote." },
    en: { title: "Chalito", approval: "An approval is waiting for you." },
  });
});

test("a push tap (/n/<nid>?via=push) acks the notification as push and opens its deep link", async ({ page }) => {
  await page.goto("/n/n1?via=push");
  await expect(page).toHaveURL(/\/a\/apr_med_1$/);
  const acks = (
    JSON.parse((await page.evaluate(() => sessionStorage.getItem("chalito.dev.clientWrites"))) ?? "[]") as {
      table: string;
      row: Record<string, unknown>;
    }[]
  ).filter((w) => w.table === "notifications");
  expect(acks.at(-1)?.row).toMatchObject({ state: "acked", acked_via: "push" });
});
