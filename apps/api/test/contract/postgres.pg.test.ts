import postgres from "postgres";
import { afterAll, describe, it } from "vitest";
import { PostgresRepo } from "../../src/postgres/repo.js";
import { runApiRepoContract } from "./api-repo.contract.js";

/**
 * Runs the ApiRepo contract against a Chalito database (the local Supabase stack in CI:
 * DATABASE_URL from `supabase status`). Writes test rows, so only `pnpm test:pg` runs it,
 * never `pnpm test`.
 */
const url = process.env.DATABASE_URL;

if (url) {
  // Room for the 10-racer transaction tests plus the lock holder.
  const sql = postgres(url, { max: 20, onnotice: () => {} });
  afterAll(() => sql.end());
  runApiRepoContract("PostgresRepo", () => new PostgresRepo(sql), { strictRevoke: true });
} else {
  describe("ApiRepo contract: PostgresRepo", () => {
    it.skip("needs DATABASE_URL (supabase start; supabase status)", () => {});
  });
}
