import type { NextRequest } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

const intl = createMiddleware(routing);

/** Locale routing (ADR 0015 / D-018). A named function: Next 16 expects `proxy` (or a default function). */
export default function proxy(request: NextRequest) {
  return intl(request);
}

export const config = {
  // Everything except API routes, Next internals and static files (sw.js, manifest, icons).
  matcher: "/((?!api|auth/desktop|_next|_vercel|.*\\..*).*)",
};
