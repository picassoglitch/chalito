import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import type { HubUsageEvent } from "@chalito/protocol";
import { PostgresStoreRepo } from "../src/store/repo.js";

/** PostgresStoreRepo against purchases, inventory, companions and the usage outbox (migration 002100), as CHALITO_DB_ROLE. */
const url = process.env.DATABASE_URL;
const role = process.env.CHALITO_DB_ROLE;

if (!url) {
  describe("PostgresStoreRepo", () => it.skip("needs DATABASE_URL", () => {}));
} else {
  const admin = postgres(url, { onnotice: () => {} });
  const sql = postgres(url, { max: 4, onnotice: () => {}, ...(role ? { connection: { role } } : {}) });
  afterAll(async () => {
    await sql.end();
    await admin.end();
  });
  const repo = new PostgresStoreRepo(sql);
  const CID = "chl_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  const RID = "44444444-4444-4444-8444-444444444444";

  const user = async () => {
    const u = `store-${randomUUID()}`;
    await admin`insert into chalito.tenants (id) values (${u})`;
    await admin`insert into chalito.users (id, tenant_id, tier, tz) values (${u}, ${u}, 'pro', 'America/Mexico_City')`;
    await admin`insert into chalito.companions (owner, companion_id, name) values (${u}, ${CID}, 'Chalito')`;
    return u;
  };
  const pid = () => `pur_${randomUUID().replace(/-/g, "")}`;
  const event = (owner: string, purchaseId: string): HubUsageEvent => ({
    source_id: `store:${purchaseId}`,
    kind: "store.purchase",
    provider: "chalito",
    external_user_id: owner,
    amount: 1,
    cost_usd_micros: 1_000_000,
    occurred_at: new Date().toISOString(),
    reservation_id: RID,
  });
  const commit = (owner: string, purchaseId: string, cosmeticId = "star_cape") =>
    repo.commitPurchase({
      purchaseId,
      owner,
      cosmeticId,
      priceTokens: 250_000,
      reservationId: RID,
      event: event(owner, purchaseId),
    });

  describe("PostgresStoreRepo", () => {
    it("a purchase writes the purchase, the inventory row and the outbox event together", async () => {
      const u = await user();
      const p = pid();
      expect(await commit(u, p)).toBe("committed");
      expect(await repo.findPurchase(p)).toEqual({
        purchaseId: p,
        owner: u,
        cosmeticId: "star_cape",
        priceTokens: 250_000,
      });
      expect([...(await repo.owned(u))]).toEqual(["star_cape"]);
      const [row] = await admin<{ event: HubUsageEvent }[]>`
        select event from chalito_private.usage_outbox where source_id = ${`store:${p}`}`;
      expect(row!.event).toMatchObject({ kind: "store.purchase", cost_usd_micros: 1_000_000 });
      expect(await commit(u, p)).toBe("duplicate_purchase");
    });

    it("two concurrent purchases of one item: exactly one commits and queues an event", async () => {
      const u = await user();
      const [a, b] = [pid(), pid()];
      const results = await Promise.all([commit(u, a), commit(u, b)]);
      expect(results.sort()).toEqual(["already_owned", "committed"]);
      const [r_n] = await admin<{ n: number }[]>`
        select count(*)::int as n from chalito_private.usage_outbox where owner = ${u}`;
      expect(r_n!.n).toBe(1);
      const [r_m] = await admin<{ m: number }[]>`select count(*)::int as m from chalito.purchases where owner = ${u}`;
      expect(r_m!.m).toBe(1);
    });

    it("equips and unequips on the owner's companion only", async () => {
      const u = await user();
      expect(await repo.equip(u, CID, "head", "viking_hat")).toBe(true);
      expect(await repo.equip(u, CID, "back", "star_cape")).toBe(true);
      expect(await repo.equip(u, CID, "head", null)).toBe(true);
      const [c] = await admin`select equipped from chalito.companions where owner = ${u}`;
      expect(c!.equipped).toEqual({ back: "star_cape" });
      expect(await repo.equip("someone-else", CID, "head", "viking_hat")).toBe(false);
      await repo.grantFree(u, "viking_hat");
      await repo.grantFree(u, "viking_hat");
      expect([...(await repo.owned(u))]).toEqual(["viking_hat"]);
    });

    it("dropUnownedSkins takes off a lapsed included skin but keeps a bought one", async () => {
      const u = await user();
      expect(await repo.equip(u, CID, "skin", "skin_galaxy")).toBe(true);
      expect(await repo.equip(u, CID, "head", "viking_hat")).toBe(true);
      expect(await repo.dropUnownedSkins(u, ["skin_galaxy", "skin_holo"])).toBe(1);
      const [c] = await admin`select equipped from chalito.companions where owner = ${u}`;
      expect(c!.equipped).toEqual({ head: "viking_hat" });
      expect(await commit(u, pid(), "skin_holo")).toBe("committed");
      expect(await repo.equip(u, CID, "skin", "skin_holo")).toBe(true);
      expect(await repo.dropUnownedSkins(u, ["skin_galaxy", "skin_holo"])).toBe(0);
      const [d] = await admin`select equipped from chalito.companions where owner = ${u}`;
      expect(d!.equipped).toEqual({ head: "viking_hat", skin: "skin_holo" });
    });

    it("clients can read their purchases but never write them", async () => {
      const [r_ins] = await admin<{ ins: boolean }[]>`
        select has_table_privilege('authenticated', 'chalito.purchases', 'insert') as ins`;
      expect(r_ins!.ins).toBe(false);
      const [r_upd] = await admin<{ upd: boolean }[]>`
        select has_column_privilege('authenticated', 'chalito.companions', 'equipped', 'update') as upd`;
      expect(r_upd!.upd).toBe(false);
    });
  });
}
