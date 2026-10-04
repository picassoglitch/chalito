import { NextRequest } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
import { buildCsp, cspHeaderName } from "./lib/csp";
import { env } from "./lib/env";

const intl = createMiddleware(routing);

/**
 * Locale routing (ADR 0015 / D-018) and the per-request CSP nonce (review R-M12). Next applies the
 * nonce to its own scripts when it finds the policy on the request; next-intl forwards the request
 * headers into its rewrite. A named function: Next 16 expects `proxy` (or a default function).
 */
export default function proxy(request: NextRequest) {
  const dev = process.env.NODE_ENV === "development";
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, env, dev);
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  // Next reads the nonce from the enforced header name only, so the request always carries that one.
  headers.set("Content-Security-Policy", csp);
  const response = intl(new NextRequest(request, { headers }));
  response.headers.set(cspHeaderName(dev), csp);
  return response;
}

export const config = {
  // Everything except API routes, Next internals and static files (sw.js, manifest, icons).
  // Prefetches don't render HTML and don't need a nonce.
  matcher: [
    {
      source: "/((?!api|auth/desktop|_next|_vercel|.*\\..*).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
