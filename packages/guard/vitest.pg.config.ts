import { defineConfig } from "vitest/config";

// `pnpm test:pg`: the Postgres outbox against a Chalito database (DATABASE_URL). Kept out of `pnpm test`.
export default defineConfig({
  test: { include: ["test/**/*.pg.test.ts"], testTimeout: 30_000, fileParallelism: false },
});
