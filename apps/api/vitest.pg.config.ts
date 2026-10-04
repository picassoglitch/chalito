import { defineConfig } from "vitest/config";

// `pnpm test:pg`: contract tests against Postgres (DATABASE_URL). Kept out of `pnpm test`.
export default defineConfig({
  test: { include: ["test/**/*.pg.test.ts"], testTimeout: 30_000, hookTimeout: 30_000, fileParallelism: false },
});
