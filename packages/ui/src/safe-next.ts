const BASE = "https://chalito.invalid";

/**
 * Validates a post-SSO redirect: a same-origin relative path only (no open redirect). The checks
 * run on the NORMALISED url too, because dot segments and encodings collapse after parsing
 * (`/.//evil.com`, `/%2e//evil.com` and `/a/..//evil.com` all become `//evil.com`, review R-M1).
 * Shared by the web app's /auth/sso; apps/api/src/hub/sso.ts keeps a copy.
 */
export const safeNextPath = (next: string | null | undefined): string => {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.length > 2048) return "/";
  // Backslashes (browsers read them as slashes), encoded slashes/backslashes, and any control,
  // whitespace or format character: nothing a real app path needs.
  if (/[\\\s\p{C}]/u.test(next) || /%(2f|5c)/i.test(next)) return "/";
  let u: URL;
  try {
    u = new URL(next, BASE);
  } catch {
    return "/";
  }
  if (u.origin !== BASE || !u.pathname.startsWith("/") || u.pathname.startsWith("//")) return "/";
  return `${u.pathname}${u.search}${u.hash}`;
};
