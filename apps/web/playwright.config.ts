import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
// No live backends: these point at nothing, and the specs intercept every call.
export const E2E_ENV = {
  NEXT_TELEMETRY_DISABLED: "1",
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54399",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-anon",
  NEXT_PUBLIC_CHALITO_API_BASE: "http://127.0.0.1:8799",
  NEXT_PUBLIC_HUB_URL: "https://hub.example",
};

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  // Cold production routes render on first hit; parallel workers make that slower.
  expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    // No -H: binding 127.0.0.1 makes next-intl's rewrite (to localhost) look external to Next, which loops.
    command: `pnpm build && pnpm start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/manifest.webmanifest`,
    env: E2E_ENV,
    timeout: 300_000,
    reuseExistingServer: !process.env.CI,
  },
});
