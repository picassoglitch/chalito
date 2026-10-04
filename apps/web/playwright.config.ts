import { defineConfig, devices } from "@playwright/test";

/**
 * Two production builds, no live backends:
 * - :3100 the app as shipped; specs intercept every api/Supabase call (e2e/*.spec.ts).
 * - :3200 the same app with the DEV/TEST-ONLY in-browser mock backend (fake Supabase, simulated
 *   agent, stub keys), for the live screens (e2e/live/*.spec.ts).
 */
const BASE_ENV = {
  NEXT_TELEMETRY_DISABLED: "1",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54399",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-anon",
  NEXT_PUBLIC_CHALITO_API_BASE: "http://127.0.0.1:8799",
  NEXT_PUBLIC_HUB_URL: "https://hub.example",
  // A real P-256 public key (no private half anywhere): the push opt-in subscribes with it.
  NEXT_PUBLIC_VAPID_PUBLIC_KEY:
    "BJ_dEvLflg9M4OxwIAm5iyYlU9Q9JBwkjdFxdW_jLyNJP4W6ud2yS5HvQ-ZYZsrfoIIrXQyzU6wcneDWkdYsD1M",
};
export const E2E_ENV = BASE_ENV;

// No -H: binding 127.0.0.1 makes next-intl's rewrite (to localhost) look external to Next, which loops.
const server = (port: number, extra: Record<string, string>) => ({
  command: `pnpm build && pnpm start -p ${port}`,
  url: `http://127.0.0.1:${port}/manifest.webmanifest`,
  env: { ...BASE_ENV, ...extra },
  timeout: 300_000,
  reuseExistingServer: !process.env.CI,
});

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  // Cold production routes render on first hit; parallel workers make that slower.
  expect: { timeout: 15_000 },
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "desktop", testIgnore: "live/**", use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:3100" } },
    { name: "phone", testIgnore: "live/**", use: { ...devices["Pixel 7"], baseURL: "http://127.0.0.1:3100" } },
    {
      name: "live-desktop",
      testMatch: "live/**/*.spec.ts",
      use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:3200" },
    },
    {
      name: "live-phone",
      testMatch: "live/**/*.spec.ts",
      use: { ...devices["Pixel 7"], baseURL: "http://127.0.0.1:3200" },
    },
  ],
  webServer: [
    server(3100, { NEXT_DIST_DIR: ".next/e2e-shell" }),
    server(3200, { NEXT_DIST_DIR: ".next/e2e-live", NEXT_PUBLIC_CHALITO_DEV_BACKEND: "1" }),
  ],
});
