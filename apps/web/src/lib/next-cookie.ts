import { safeNextPath } from "@chalito/ui";
import { hubLaunchUrl } from "./hub";

/**
 * The hub's launch route doesn't forward `next` (sign-in remembers only /auth/launch/chalito and
 * SSO lands on the default page). So before sending a signed-out person to the hub, Chalito keeps
 * where they were going in a short-lived first-party cookie (it survives a sign-in in a new tab)
 * and returns there after /auth/sso.
 */
export const NEXT_COOKIE = "chalito_next";
const MAX_AGE_S = 600;

/** A same-origin app path to come back to; never the api, Next internals or the SSO page itself. */
export const allowedNext = (raw: string | null | undefined): string => {
  const p = safeNextPath(raw);
  return /^\/(api|_next|_vercel)(\/|$)|^\/(en\/)?auth\/sso(\/|$|\?)/.test(p) ? "/" : p;
};

export const rememberNext = (path: string): void => {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${NEXT_COOKIE}=${encodeURIComponent(allowedNext(path))}; Max-Age=${MAX_AGE_S}; Path=/; SameSite=Lax${secure}`;
};

/** Reads and clears the remembered path (validated again: the cookie is client-controlled). */
export const takeNext = (): string | null => {
  const m = document.cookie.match(new RegExp(`(?:^|; )${NEXT_COOKIE}=([^;]*)`));
  document.cookie = `${NEXT_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
  if (!m) return null;
  let raw: string;
  try {
    raw = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  return allowedNext(raw);
};

/** One hub launch per page: effects that re-run (or a double tap) must not start a second one. */
let launching = false;

/** "Entrar con Chalyb" that comes back to `path` afterwards. */
export const signInAndReturn = (path: string): void => {
  const launch = hubLaunchUrl();
  if (!launch || launching) return;
  launching = true;
  rememberNext(path);
  window.location.assign(launch);
};
