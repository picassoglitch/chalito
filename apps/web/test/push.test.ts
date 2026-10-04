import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import es from "@chalito/ui/messages/es.json";
import en from "@chalito/ui/messages/en.json";
import { subscriptionRow, urlB64ToBytes, validVapidKey } from "@/lib/push";

/** A real P-256 public key (uncompressed), as `web-push generate-vapid-keys` prints one. */
const VAPID = "BJ_dEvLflg9M4OxwIAm5iyYlU9Q9JBwkjdFxdW_jLyNJP4W6ud2yS5HvQ-ZYZsrfoIIrXQyzU6wcneDWkdYsD1M";

describe("push (lib/push.ts)", () => {
  it("accepts only an uncompressed P-256 VAPID public key", () => {
    expect(urlB64ToBytes(VAPID)).toHaveLength(65);
    expect(validVapidKey(VAPID)).toBe(true);
    expect(validVapidKey("")).toBe(false);
    expect(validVapidKey(VAPID.slice(0, -4))).toBe(false);
    // A private key (32 bytes) pasted by mistake.
    expect(validVapidKey("q1Ld7FsEjkY6d6Zf3vUq3mK3b9lQ0eX9n5dQyVb7c8M")).toBe(false);
  });

  it("builds the row the notifier reads, and refuses anything the table would", () => {
    const sub = (endpoint: string, keys: Record<string, string>) => ({ endpoint, toJSON: () => ({ keys }) });
    expect(subscriptionRow(sub("https://push.example/abc", { p256dh: "pk", auth: "au" }), "o1", "d1", "UA")).toEqual({
      owner: "o1",
      device_id: "d1",
      endpoint: "https://push.example/abc",
      p256dh: "pk",
      auth: "au",
      user_agent: "UA",
    });
    expect(subscriptionRow(sub("http://push.example/abc", { p256dh: "pk", auth: "au" }), "o", "d", "")).toBeNull();
    expect(subscriptionRow(sub("https://push.example/abc", { p256dh: "pk" }), "o", "d", "")).toBeNull();
    expect(
      subscriptionRow(sub("https://push.example/abc", { p256dh: "pk", auth: "a" }), "o", "d", "x".repeat(900))!
        .user_agent,
    ).toHaveLength(512);
  });

  it("has the service worker's text in both languages", () => {
    for (const m of [es, en])
      for (const k of ["title", "body", "approval", "expired"] as const)
        expect(m.live.push.notification[k]).toEqual(expect.any(String));
  });
});

/** Runs public/sw.js against a fake worker scope and returns its listeners. */
const loadWorker = (language = "es-MX") => {
  const listeners: Record<string, (e: unknown) => void> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const text = { es: es.live.push.notification, en: en.live.push.notification };
  const self = {
    navigator: { language },
    location: { origin: "https://chalito.test" },
    addEventListener: (t: string, fn: (e: unknown) => void) => (listeners[t] = fn),
    skipWaiting: () => undefined,
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }),
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => [],
      openWindow: async (u: string) => void opened.push(u),
    },
  };
  const caches = {
    open: async () => ({ match: async () => undefined, put: async () => undefined, add: async () => undefined }),
  };
  const fetch = vi.fn(async () => ({ ok: true, clone: () => null, json: async () => text }));
  new Function("self", "caches", "fetch", readFileSync("public/sw.js", "utf8"))(self, caches, fetch);
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    let wait: Promise<unknown> = Promise.resolve();
    listeners[type]!({ ...event, waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  };
  return { dispatch, shown, opened };
};

const pushEvent = (payload: unknown) => ({ data: { json: () => payload } });

describe("service worker (public/sw.js)", () => {
  it("shows metadata only: what kind of thing is waiting, tagged by nid", async () => {
    const w = loadWorker();
    await w.dispatch("push", pushEvent({ nid: "n_1", source: "approval", urgency: "high", deepLink: "/a/x" }));
    await w.dispatch("push", pushEvent({ nid: "n_2", source: "budget", urgency: "low", deepLink: "/creditos" }));
    await w.dispatch(
      "push",
      pushEvent({ nid: "n_3", source: "approval", urgency: "normal", notice: "approval_expired" }),
    );
    expect(w.shown.map((s) => [s.title, s.options.body, s.options.tag, s.options.requireInteraction])).toEqual([
      ["Chalito", es.live.push.notification.approval, "n_1", true],
      ["Chalito", es.live.push.notification.body, "n_2", false],
      ["Chalito", es.live.push.notification.expired, "n_3", false],
    ]);
    expect(w.shown[0]!.options.data).toEqual({ nid: "n_1" });
  });

  it("uses the browser's language", async () => {
    const w = loadWorker("en-US");
    await w.dispatch("push", pushEvent({ nid: "n_1", source: "approval", urgency: "high" }));
    expect(w.shown[0]!.options.body).toBe(en.live.push.notification.approval);
  });

  it("ignores payloads without a valid nid", async () => {
    const w = loadWorker();
    await w.dispatch("push", pushEvent({ source: "approval" }));
    await w.dispatch("push", pushEvent({ nid: "../x" }));
    await w.dispatch("push", { data: { json: () => JSON.parse("not json") } });
    expect(w.shown).toEqual([]);
  });

  it("a tap opens /n/<nid> (which acks as push and follows the deep link)", async () => {
    const w = loadWorker();
    const close = vi.fn();
    await w.dispatch("notificationclick", { notification: { close, data: { nid: "n_1" } } });
    expect(close).toHaveBeenCalled();
    expect(w.opened).toEqual(["https://chalito.test/n/n_1?via=push"]);
    const en = loadWorker("en");
    await en.dispatch("notificationclick", { notification: { close, data: { nid: "n_1" } } });
    expect(en.opened).toEqual(["https://chalito.test/en/n/n_1?via=push"]);
    await en.dispatch("notificationclick", { notification: { close, data: { nid: "//evil" } } });
    expect(en.opened).toHaveLength(1);
  });
});
