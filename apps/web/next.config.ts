import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const config: NextConfig = {
  // Workspace packages ship TypeScript sources.
  transpilePackages: ["@chalito/ui", "@chalito/brand", "@chalito/protocol"],
  // providers.yaml is read at build/render time from packages/config.
  outputFileTracingIncludes: { "/**": ["../../packages/config/*.yaml"] },
  poweredByHeader: false,
  // Workspace packages use NodeNext-style `./x.js` specifiers for TypeScript files. Turbopack
  // can't map those yet, so the web app builds with webpack (`next build --webpack`).
  webpack: (cfg) => {
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
        ],
      },
      // The launch token is in this URL: never send it on as a referrer.
      { source: "/:locale(en)?/auth/sso", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    ];
  },
};

export default withNextIntl(config);
