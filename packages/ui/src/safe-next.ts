/**
 * Validates a post-SSO redirect: same-origin relative path only (no open redirect).
 * Shared by the web app's /auth/sso; same logic and tests as apps/api/src/hub/sso.ts.
 */
export const safeNextPath = (next: string | null | undefined): string => {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || /[\r\n]/.test(next))
    return "/";
  try {
    const u = new URL(next, "https://chalito.invalid");
    return u.origin === "https://chalito.invalid" ? `${u.pathname}${u.search}${u.hash}` : "/";
  } catch {
    return "/";
  }
};
