/**
 * Web Push on this browser (D-050): the permission prompt, the PushManager subscription with the
 * notifier's VAPID public key, and its row in chalito.push_subscriptions. The paired device writes
 * the row itself under RLS (insert/delete only for its own device_id; the notifier reads it). The
 * payloads that arrive are metadata only; public/sw.js turns them into a notification.
 */

export type PushState =
  /** No Push API, no service worker, or no VAPID key configured. */
  | "unsupported"
  /** The person blocked notifications for this site; only the browser's settings can undo it. */
  | "denied"
  | "off"
  | "on";

export type PushResult = "on" | "off" | "denied" | "failed";

/** The slice of the Supabase client this needs (the browser's device session, schema chalito). */
export type PushDb = {
  from(t: "push_subscriptions"): {
    insert(row: Record<string, unknown>): PromiseLike<{ error: { code?: string } | null }>;
    delete(): {
      eq(
        c: string,
        v: string,
      ): {
        eq(c: string, v: string): { eq(c: string, v: string): PromiseLike<{ error: unknown }> };
      };
    };
  };
};

/** base64url (the VAPID key as `web-push generate-vapid-keys` prints it) → bytes. */
export const urlB64ToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const b64 = (s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

/** A P-256 public key, uncompressed: 65 bytes starting with 0x04. Anything else is a config error. */
export const validVapidKey = (key: string): boolean => {
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(key)) return false;
  try {
    const b = urlB64ToBytes(key);
    return b.length === 65 && b[0] === 4;
  } catch {
    return false;
  }
};

/** The row the notifier reads (apps/notifier postgres-store), from the browser's subscription. */
export const subscriptionRow = (
  sub: { endpoint: string; toJSON(): { keys?: Record<string, string | undefined> } },
  owner: string,
  deviceId: string,
  userAgent: string,
): Record<string, string> | null => {
  const keys = sub.toJSON().keys ?? {};
  if (!sub.endpoint.startsWith("https://") || sub.endpoint.length > 2048) return null;
  if (!keys.p256dh || !keys.auth || keys.p256dh.length > 256 || keys.auth.length > 64) return null;
  return {
    owner,
    device_id: deviceId,
    endpoint: sub.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    user_agent: userAgent.slice(0, 512),
  };
};

const supported = (vapidKey: string) =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window &&
  validVapidKey(vapidKey);

/** This browser's current subscription, if the service worker is up. */
const current = async (): Promise<PushSubscription | null> => {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
};

export const pushState = async (vapidKey: string): Promise<PushState> => {
  if (!supported(vapidKey)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "off";
  return (await current().catch(() => null)) ? "on" : "off";
};

/**
 * Asks for permission (this must run from a tap), subscribes, and stores the row. A row that's
 * already there (the same endpoint) counts as on.
 */
export const enablePush = async (o: {
  vapidKey: string;
  db: PushDb;
  owner: string;
  deviceId: string;
}): Promise<PushResult> => {
  if (!supported(o.vapidKey)) return "failed";
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "denied";
  if (permission !== "granted") return "off";
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(o.vapidKey) }));
    const row = subscriptionRow(sub, o.owner, o.deviceId, navigator.userAgent);
    if (!row) return "failed";
    const { error } = await o.db.from("push_subscriptions").insert(row);
    if (error && error.code !== "23505") return "failed";
    return "on";
  } catch {
    return "failed";
  }
};

/** Removes the row first (no more sends to it), then the browser's subscription. */
export const disablePush = async (o: { db: PushDb; owner: string; deviceId: string }): Promise<PushResult> => {
  try {
    const sub = await current();
    if (!sub) return "off";
    const { error } = await o.db
      .from("push_subscriptions")
      .delete()
      .eq("owner", o.owner)
      .eq("device_id", o.deviceId)
      .eq("endpoint", sub.endpoint);
    if (error) return "failed";
    await sub.unsubscribe();
    return "off";
  } catch {
    return "failed";
  }
};
