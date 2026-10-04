import { defineConfig } from "vitest/config";

// The beta rehearsal: one sequential, cross-app run on the LOCAL Supabase stack (the supabase CI
// job). Every step is its own describe with its own setup, so one failure doesn't hide the rest.
export default defineConfig({
  test: {
    include: ["test/**/*.rehearsal.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
