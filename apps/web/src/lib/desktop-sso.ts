/**
 * Desktop SSO bridge: the desktop app opens /auth/desktop?state=…&redirect_uri=…, the person signs
 * in on the hub, and /auth/sso hands the launch token to the app instead of exchanging it here.
 */
export const DESKTOP_COOKIE = "chalito_desktop";
export const DESKTOP_MAX_AGE_S = 600;

/** 32 random bytes, base64url without padding. */
const STATE = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/auth\/sso$/;

/** Exactly `chalito://auth/sso`, or `http://127.0.0.1:<1024–65535>/auth/sso`. Anything else is refused. */
export const validDesktopRedirect = (r: string | null): string | null => {
  if (r === "chalito://auth/sso") return r;
  const m = r ? LOOPBACK.exec(r) : null;
  if (!m) return null;
  const port = Number(m[1]);
  return port >= 1024 && port <= 65535 ? r : null;
};

export const validDesktopState = (s: string | null): string | null => (s && STATE.test(s) ? s : null);

export interface DesktopHandoff {
  state: string;
  redirect: string;
}

export const parseHandoff = (raw: string | undefined): DesktopHandoff | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { state?: unknown; redirect?: unknown };
    const state = validDesktopState(typeof v.state === "string" ? v.state : null);
    const redirect = validDesktopRedirect(typeof v.redirect === "string" ? v.redirect : null);
    return state && redirect ? { state, redirect } : null;
  } catch {
    return null;
  }
};

/** Where "Abrir Chalito" goes: the app's redirect with the hub's launch token, the state and next. */
export const handoffUrl = (h: DesktopHandoff, token: string, next: string | null): string => {
  const u = new URL(h.redirect);
  u.searchParams.set("token", token);
  u.searchParams.set("state", h.state);
  if (next) u.searchParams.set("next", next);
  return u.toString();
};
