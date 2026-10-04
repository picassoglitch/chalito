import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresPhoneStore } from "../src/phone/postgres.js";

/** PostgresPhoneStore against chalito.users (migration 20261004001100), as CHALITO_DB_ROLE. */
const url = process.env.DATABASE_URL;
const role = process.env.CHALITO_DB_ROLE;

if (!url) {
  describe("PostgresPhoneStore", () => it.skip("needs DATABASE_URL", () => {}));
} else {
  const admin = postgres(url, { onnotice: () => {} });
  const sql = postgres(url, { max: 3, onnotice: () => {}, ...(role ? { connection: { role } } : {}) });
  const store = new PostgresPhoneStore(sql);
  afterAll(async () => {
    await sql.end();
    await admin.end();
  });
  const user = async () => {
    const id = `phone-${randomUUID()}`;
    await admin`insert into chalito.tenants (id) values (${id})`;
    await admin`insert into chalito.users (id, tenant_id) values (${id}, ${id})`;
    return id;
  };

  describe("PostgresPhoneStore", () => {
    it("verifies, sets channels, refuses a number another account verified, and clears in one write", async () => {
      const a = await user();
      const b = await user();
      const e164 = `+5255${String(Date.now()).slice(-8)}`;
      expect(await store.setVerified(a, { e164, country: "MX", at: 1_790_000_000_000 })).toBe("ok");
      await store.setChannels(a, { whatsapp: true, calls: true });
      expect(await store.get(a)).toMatchObject({
        e164,
        country: "MX",
        verifiedAt: 1_790_000_000_000,
        whatsapp: true,
        calls: true,
        sms: null,
      });
      expect(await store.setVerified(b, { e164, country: "MX", at: 1 })).toBe("in_use");
      await store.clear(a);
      expect(await store.get(a)).toMatchObject({
        e164: null,
        verifiedAt: null,
        whatsapp: false,
        calls: false,
        sms: null,
      });
    });

    it("the database also refuses opt-ins without a verified number (defence in depth)", async () => {
      const u = await user();
      await expect(store.setChannels(u, { calls: true })).rejects.toMatchObject({ code: "23514" });
    });
  });
}
