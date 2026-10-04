import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresAccountStore } from "../src/account/store.js";

/** chalito_private.export_account / delete_account and account_deletions (migration 003030), as CHALITO_DB_ROLE. */
const url = process.env.DATABASE_URL;
const role = process.env.CHALITO_DB_ROLE;

if (!url) {
  describe("PostgresAccountStore", () => it.skip("needs DATABASE_URL", () => {}));
} else {
  const admin = postgres(url, { onnotice: () => {} });
  const sql = postgres(url, { max: 2, onnotice: () => {}, ...(role ? { connection: { role } } : {}) });
  afterAll(async () => {
    await sql.end();
    await admin.end();
  });
  const store = new PostgresAccountStore(sql);

  const user = async () => {
    const u = `acct-${randomUUID()}`;
    const dev = `dv_${randomUUID().slice(0, 8)}`;
    await admin`insert into chalito.tenants (id) values (${u})`;
    await admin`insert into chalito.users (id, tenant_id) values (${u}, ${u})`;
    await admin`insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id)
                values (${u}, ${dev}, 'client', 'phone', 'ios', 'Phone', 'p', 'p', 'f', 'first_client', ${randomUUID()})`;
    await admin`insert into chalito_private.private_recovery (owner, code_hash) values (${u}, ${admin.json({ secret: "hash-must-not-leak" })})`;
    await admin`insert into chalito.companions (owner, companion_id, name) values (${u}, ${"chl_" + "a".repeat(26)}, 'Chalito')`;
    for (const [sid, status] of [
      ["p", "pending"],
      ["s", "sent"],
    ] as const)
      await admin`insert into chalito_private.usage_outbox (owner, source_id, event, status)
                  values (${u}, ${`${sid}:${u}`}, ${admin.json({ source_id: `${sid}:${u}`, kind: "sms.segments", amount: 1, cost_usd_micros: 1 })}, ${status})`;
    return { u, dev };
  };

  describe("PostgresAccountStore", () => {
    it("exports the owner's rows, never secrets, and nobody else's", async () => {
      const a = await user();
      const b = await user();
      const x = (await store.export(a.u)) as { owner: string; tables: Record<string, unknown[]> };
      expect(x.owner).toBe(a.u);
      expect(x.tables.devices).toHaveLength(1);
      expect(x.tables.companions).toHaveLength(1);
      expect(x.tables.users).toHaveLength(1);
      expect(x.tables.usage).toHaveLength(2);
      const text = JSON.stringify(x);
      expect(text).not.toContain("hash-must-not-leak");
      expect(text).not.toContain(b.u);
    });

    it("schedules, cancels and reschedules; due lists only scheduled, due rows", async () => {
      const { u, dev } = await user();
      const t = Date.now();
      expect(await store.schedule(u, dev, t, t + 1000, `exports/${u}/1.json`)).toBe("scheduled");
      expect(await store.schedule(u, dev, t, t + 1000, `exports/${u}/2.json`)).toBe("exists");
      expect(await store.due(t + 2000)).toContain(u);
      expect(await store.cancel(u, t)).toBe(true);
      expect(await store.due(t + 2000)).not.toContain(u);
      expect(await store.schedule(u, dev, t, t + 1000, `exports/${u}/3.json`)).toBe("scheduled");
      expect((await store.status(u))!.exportPath).toBe(`exports/${u}/3.json`);
    });

    it("deletes the account's data (cascade + the rest), keeps unsent usage, leaves others alone", async () => {
      const a = await user();
      const b = await user();
      expect(await store.deviceIds(a.u)).toEqual([a.dev]);
      await store.deleteAccount(a.u);
      const [counts] = await admin`
        select (select count(*)::int from chalito.users where id = ${a.u}) as users,
               (select count(*)::int from chalito.tenants where id = ${a.u}) as tenants,
               (select count(*)::int from chalito.devices where owner = ${a.u}) as devices,
               (select count(*)::int from chalito.companions where owner = ${a.u}) as companions,
               (select count(*)::int from chalito_private.private_recovery where owner = ${a.u}) as recovery,
               (select array_agg(status) from chalito_private.usage_outbox where owner = ${a.u}) as usage,
               (select count(*)::int from chalito.devices where owner = ${b.u}) as other`;
      expect(counts).toEqual({
        users: 0,
        tenants: 0,
        devices: 0,
        companions: 0,
        recovery: 0,
        usage: ["pending"],
        other: 1,
      });
    });

    it("only chalito_server may run the functions", async () => {
      const [r] = await admin`
        select has_function_privilege('authenticated', 'chalito_private.delete_account(text)', 'execute') as auth,
               has_function_privilege('anon', 'chalito_private.export_account(text)', 'execute') as anon,
               has_function_privilege('chalito_server', 'chalito_private.delete_account(text)', 'execute') as server`;
      expect(r).toEqual({ auth: false, anon: false, server: true });
    });
  });
}
