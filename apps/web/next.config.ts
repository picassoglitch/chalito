import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * The dev/test mock backend (src/dev, NEXT_PUBLIC_CHALITO_DEV_BACKEND=1) must never reach a
 * deployment: refuse to build with it anywhere on Vercel (production or preview).
 */
export const assertNoDevBackendOnVercel = (e: Record<string, string | undefined>) => {
  if (e.NEXT_PUBLIC_CHALITO_DEV_BACKEND === "1" && (e.VERCEL || e.VERCEL_ENV))
    throw new Error("NEXT_PUBLIC_CHALITO_DEV_BACKEND is a dev/test-only flag and can't be built on Vercel.");
};
assertNoDevBackendOnVercel(process.env);

const config: NextConfig = {
  // Workspace packages ship TypeScript sources.
  transpilePackages: [
    "@chalito/ui",
    "@chalito/brand",
    "@chalito/protocol",
    "@chalito/client",
    "@chalito/client-keys",
    "@chalito/crypto",
  ],
  // providers.yaml is read at build/render time from packages/config.
  outputFileTracingIncludes: { "/**": ["../../packages/config/*.yaml"] },
  poweredByHeader: false,
  // The e2e suite builds the plain app and the mock-backend app side by side.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Always defined, so `process.env.NEXT_PUBLIC_CHALITO_DEV_BACKEND === "1"` is a build-time
  // constant and webpack drops the dev backend (src/dev) from normal builds entirely.
  env: { NEXT_PUBLIC_CHALITO_DEV_BACKEND: process.env.NEXT_PUBLIC_CHALITO_DEV_BACKEND === "1" ? "1" : "0" },
  // Workspace packages use NodeNext-style `./x.js` specifiers for TypeScript files. Turbopack
  // can't map those yet, so the web app builds with webpack (`next build --webpack`).
  webpack: (cfg) => {
    // The legal texts and their status live in packages/config/legal: bundled as plain source.
    cfg.module.rules.push({ test: /[\\/]config[\\/]legal[\\/][^\\/]+\.(md|yaml)$/, type: "asset/source" });
    cfg.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] };
    return cfg;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          // HTTPS only from now on (browsers ignore this over plain http, e.g. local e2e).
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ],
      },
      // The launch token is in this URL: never send it on as a referrer.
      { source: "/:locale(en)?/auth/sso", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      {
        source: "/auth/desktop/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    ];
  },
};

export default withNextIntl(config);
