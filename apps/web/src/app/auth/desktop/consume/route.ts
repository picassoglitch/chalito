import { NextResponse, type NextRequest } from "next/server";
import { DESKTOP_COOKIE, parseHandoff } from "@/lib/desktop-sso";

/**
 * POST /auth/desktop/consume (same-origin, from /auth/sso): reads and clears the desktop handoff
 * cookie. {handoff: null} means a normal web sign-in.
 */
export function POST(req: NextRequest) {
  if (req.headers.get("sec-fetch-site") && req.headers.get("sec-fetch-site") !== "same-origin")
    return NextResponse.json({ handoff: null }, { status: 403 });
  const handoff = parseHandoff(req.cookies.get(DESKTOP_COOKIE)?.value);
  const res = NextResponse.json({ handoff }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set(DESKTOP_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
