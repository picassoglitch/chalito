import { defineConfig } from "vitest/config";

// Runs inside `firebase emulators:exec` (see root package.json `test:emulator`).
export default defineConfig({
  test: { include: ["test/**/*.emu.test.ts"], testTimeout: 30_000, hookTimeout: 30_000, fileParallelism: false },
});
