import { NextResponse, type NextRequest } from "next/server";
import { hubLaunchUrl } from "@/lib/hub";
import { DESKTOP_COOKIE, DESKTOP_MAX_AGE_S, validDesktopRedirect, validDesktopState } from "@/lib/desktop-sso";

const PRIVATE = { "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" };

/**
 * GET /auth/desktop?state=<43 b64url>&redirect_uri=<chalito://auth/sso | http://127.0.0.1:<port>/auth/sso>
 * Remembers the desktop app's state and redirect (10-minute HttpOnly cookie), then signs in on the hub.
 * Anything malformed goes home.
 */
export function GET(req: NextRequest) {
  const state = validDesktopState(req.nextUrl.searchParams.get("state"));
  const redirect = validDesktopRedirect(req.nextUrl.searchParams.get("redirect_uri"));
  const launch = hubLaunchUrl();
  // Relative Location: Next may report another host for req.url than the one the browser used.
  if (!state || !redirect || !launch)
    return new NextResponse(null, { status: 303, headers: { ...PRIVATE, Location: "/" } });
  const res = NextResponse.redirect(launch, { status: 303, headers: PRIVATE });
  res.cookies.set(DESKTOP_COOKIE, JSON.stringify({ state, redirect }), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/",
    maxAge: DESKTOP_MAX_AGE_S,
  });
  return res;
}
