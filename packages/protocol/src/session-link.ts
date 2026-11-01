import { Locale, SessionId } from "./common.js";

/** A navigation link, never a bearer credential. The phone must sign in as the session owner. */
export const sessionLink = (sid: string, locale: "es" | "en", origin = "https://www.chalyb.com"): string => {
  SessionId.parse(sid);
  Locale.parse(locale);
  const base = new URL(origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    (base.protocol !== "https:" && !(base.protocol === "http:" && loopback))
  ) {
    throw new Error("session links need an https origin, or localhost for development");
  }
  // Chalito lives inside the hub (owner decision 2026-10-05), not on its own subdomain.
  const path = `/app/chalito/sesiones/${encodeURIComponent(sid)}`;
  base.pathname = locale === "en" ? `/en${path}` : path;
  return base.href;
};
