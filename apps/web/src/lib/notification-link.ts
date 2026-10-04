import { safeNextPath } from "@chalito/ui";

/** Where a notification may send someone: an approval, a mesa, a room, or credits. Nothing else. */
const TARGET = /^\/(a|m|r)\/[A-Za-z0-9_-]{1,128}$|^\/creditos$/;

/** The notification's deepLink, localized, or null when it isn't one of ours. */
export const notificationTarget = (deepLink: string, locale: "es" | "en"): string | null => {
  const p = safeNextPath(deepLink);
  if (!TARGET.test(p)) return null;
  return locale === "en" ? `/en${p}` : p;
};

/**
 * How the person arrived, for acked_via: WhatsApp's link wrapper shows up as the referrer; the
 * notifier may also say it explicitly with ?via=. SMS apps send no referrer, so without ?via=sms
 * it counts as "app".
 */
export const ackVia = (referrer: string, via: string | null): "whatsapp" | "sms" | "app" => {
  if (via === "whatsapp" || via === "sms") return via;
  return /(^|\.)whatsapp\.com|(^|\/\/)wa\.me|l\.wl\.co/.test(referrer) ? "whatsapp" : "app";
};
