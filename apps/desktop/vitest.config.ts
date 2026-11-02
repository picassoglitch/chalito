import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The GitHub Windows runner sometimes takes ~30 s for a first panel render that takes <1 s elsewhere.
const slowHost = process.platform === "win32";

export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", ...(slowHost ? { testTimeout: 60_000, hookTimeout: 90_000 } : {}) },
});
