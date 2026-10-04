import { defineConfig } from "vitest/config";

// `pnpm test`: the rehearsal only runs against the local stack (vitest.rehearsal.config.ts).
export default defineConfig({ test: { include: ["test/**/*.unit.test.ts"], passWithNoTests: true } });
