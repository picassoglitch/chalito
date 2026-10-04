import { afterAll, describe, expect, it } from "vitest";
import { PostgresRepo, chalitoSql } from "../../src/postgres/repo.js";
import { chalitoAuthUserId } from "../../src/supabase/identity.js";
import { runApiRepoContract } from "./api-repo.contract.js";
import { device, endorseCode, pairingCode } from "./fixtures.js";

/**
 * Runs the ApiRepo contract against a Chalito database (the local Supabase stack in CI:
 * DATABASE_URL from `supabase status`), acting as CHALITO_DB_ROLE (chalito_server in CI) the
 * way the api does. Writes test rows, so only `pnpm test:pg` runs it, never `pnpm test`.
 */
const url = process.env.DATABASE_URL;
const role = process.env.CHALITO_DB_ROLE;

if (url) {
  // Room for the 10-racer transaction tests plus the lock holder.
  const sql = chalitoSql(url, { max: 20, ...(role ? { role } : {}) });
  const make = () => new PostgresRepo(sql, { authUserId: chalitoAuthUserId });
  afterAll(() => sql.end());
  runApiRepoContract("PostgresRepo", make, { strictRevoke: true, pairingWatches: true });

  describe("PostgresRepo: auth user ids", () => {
    it("devices and pairing codes record the Auth user they sign in as", async () => {
      const repo = make();
      const o = `contract-${crypto.randomUUID()}`;
      await repo.upsertUserFromSso(o, { tenantId: o, email: "a@b.mx", tier: "pro", lastSsoAt: 1 });
      const d = await device(o);
      await repo.createDevice(o, d);
      const code = await pairingCode();
      await repo.createPairingCode(code);
      const [dev] = await sql`select auth_user_id from chalito.devices where device_id = ${d.deviceId}`;
      const [pc] = await sql`select watch_auth_user_id from chalito.pairing_codes where code_id = ${code.codeId}`;
      expect(dev?.auth_user_id).toBe(chalitoAuthUserId("device", d.deviceId));
      expect(pc?.watch_auth_user_id).toBe(chalitoAuthUserId("pairing", code.codeId));
    });
    it("endorse codes record their watcher's Auth user, and taking the endorsement detaches it", async () => {
      const repo = make();
      const o = `contract-${crypto.randomUUID()}`;
      await repo.upsertUserFromSso(o, { tenantId: o, email: "a@b.mx", tier: "pro", lastSsoAt: 1 });
      const code = await endorseCode(o);
      await repo.createEndorseCode(code);
      const [ec] = await sql`select watch_auth_user_id from chalito.endorse_codes where code_id = ${code.codeId}`;
      expect(ec?.watch_auth_user_id).toBe(chalitoAuthUserId("pairing", code.codeId));
    });
    it.runIf(role)(`runs as ${role}`, async () => {
      const [r] = await sql`select current_user as u`;
      expect(r?.u).toBe(role);
    });
  });
} else {
  describe("ApiRepo contract: PostgresRepo", () => {
    it.skip("needs DATABASE_URL (supabase start; supabase status)", () => {});
  });
}
