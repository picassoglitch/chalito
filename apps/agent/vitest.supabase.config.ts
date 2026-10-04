import { defineConfig } from "vitest/config";

// Integration tests against the local Supabase stack (`supabase start`); run by the `supabase` CI job.
export default defineConfig({
  test: { include: ["test/**/*.int.test.ts"], testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false },
});
