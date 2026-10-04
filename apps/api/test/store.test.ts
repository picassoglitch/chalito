import { describe, expect, it } from "vitest";
import { HubUsageEvent } from "@chalito/protocol";
import { CID, PID, RID, catalog, hubCalls, hubState, storeSetup } from "./store-harness.js";

describe("catalog", () => {
  it("lists every cosmetic with its slot and price in tokens, and what the user owns", async () => {
    const { call } = storeSetup();
    const res = await call("GET", "/catalog");
    expect(res.status).toBe(200);
    const items = res.json.items as { id: string; free: boolean; priceTokens?: number; owned: boolean }[];
    expect(items.map((i) => i.id).sort()).toEqual(Object.keys(catalog.cosmetics).sort());
    for (const i of items) {
      expect(i.owned).toBe(i.free);
      expect(i.free ? i.priceTokens : typeof i.priceTokens).toBe(i.free ? undefined : "number");
    }
  });

  it("agents can't use the store", async () => {
    const { call } = storeSetup();
    expect((await call("GET", "/catalog", undefined, "agent:dev_agent")).status).toBe(403);
  });
});

describe("purchase", () => {
  it("a paid item: admit, then purchase + inventory + a store.purchase event priced at tokens × 4, then settle", async () => {
    const { call, store } = storeSetup();
    const res = await call("POST", "/purchase", { cosmeticId: "star_cape", purchaseId: PID });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "owned", charged: 250_000 });
    expect(hubCalls.map((c) => c.path)).toEqual(["admit", "settle"]);
    expect(hubCalls[0]!.body).toMatchObject({
      external_user_id: "hub-user-1",
      external_job_id: `store:${PID}`,
      class: "job",
      operation: "store.purchase",
      est_tokens: 250_000,
    });
    expect(hubCalls[1]!.body).toEqual({ reservation_id: RID, outcome: "succeeded" });
    expect(store.outbox).toHaveLength(1);
    const e = HubUsageEvent.parse(store.outbox[0]);
    expect(e).toMatchObject({
      source_id: `store:${PID}`,
      kind: "store.purchase",
      external_user_id: "hub-user-1",
      cost_usd_micros: 1_000_000,
      reservation_id: RID,
    });
    // The hub bills a store.purchase as ceil(cost / 4): exactly the catalog price.
    expect(Math.ceil(e.cost_usd_micros / 4)).toBe(catalog.cosmetics.star_cape!.priceTokens);
    expect((await store.owned("hub-user-1")).has("star_cape")).toBe(true);
  });

  it("is refused when admit says no_tokens: nothing owned, nothing queued, an inline why-chip", async () => {
    const { call, store } = storeSetup();
    hubState.mode = "no_tokens";
    const res = await call("POST", "/purchase", { cosmeticId: "star_cape", purchaseId: PID });
    expect(res.status).toBe(402);
    expect(res.json).toMatchObject({ error: "no_tokens", chips: [{ href: "/creditos" }] });
    expect(store.outbox).toHaveLength(0);
    expect((await store.owned("hub-user-1")).has("star_cape")).toBe(false);
    expect(hubCalls.map((c) => c.path)).toEqual(["admit"]);
  });

  it("fails closed when the hub is unreachable", async () => {
    const { call, store } = storeSetup();
    hubState.mode = "down";
    expect((await call("POST", "/purchase", { cosmeticId: "star_cape", purchaseId: PID })).status).toBe(503);
    expect(store.outbox).toHaveLength(0);
  });

  it("retrying the same purchase id never charges twice", async () => {
    const { call, store } = storeSetup();
    await call("POST", "/purchase", { cosmeticId: "star_cape", purchaseId: PID });
    const again = await call("POST", "/purchase", { cosmeticId: "star_cape", purchaseId: PID });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ status: "owned", replay: true });
    expect(store.outbox).toHaveLength(1);
    expect(hubCalls.filter((c) => c.path === "admit")).toHaveLength(1);
  });

  it("a purchase id can't be reused for another item or by another user", async () => {
    const { call } = storeSetup();
    await call("POST", "/purchase", { cosmeticId: "star_cape", purchaseId: PID });
    expect((await call("POST", "/purchase", { cosmeticId: "sparkle_aura", purchaseId: PID })).status).toBe(409);
    expect(
      (await call("POST", "/purchase", { cosmeticId: "star_cape", purchaseId: PID }, "user:dev_x:hub-user-2")).status,
    ).toBe(409);
  });

  it("an owned item under a new purchase id isn't charged again", async () => {
    const { call, store } = storeSetup();
    await call("POST", "/purchase", { cosmeticId: "star_cape", purchaseId: PID });
    const res = await call("POST", "/purchase", { cosmeticId: "star_cape", purchaseId: "pur_fedcba9876543210" });
    expect(res.json).toMatchObject({ status: "owned", charged: 0 });
    expect(store.outbox).toHaveLength(1);
  });

  it("a race on the same item under two ids: the loser's reservation is cancelled, nothing charged", async () => {
    const { call, store } = storeSetup();
    // The other purchase commits between this one's admit and its transaction.
    const commit = store.commitPurchase.bind(store);
    store.commitPurchase = async (p) => {
      await store.grantFree(p.owner, p.cosmeticId);
      return commit(p);
    };
    const res = await call("POST", "/purchase", { cosmeticId: "star_cape", purchaseId: PID });
    expect(res.json).toMatchObject({ status: "owned", charged: 0 });
    expect(store.outbox).toHaveLength(0);
    expect(hubCalls.at(-1)!.body).toEqual({ reservation_id: RID, outcome: "cancelled" });
  });

  it("free items never touch the hub", async () => {
    const { call, store } = storeSetup();
    const res = await call("POST", "/purchase", { cosmeticId: "viking_hat", purchaseId: PID });
    expect(res.json).toMatchObject({ status: "owned", charged: 0 });
    expect(hubCalls).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });

  it("rejects unknown items and malformed ids", async () => {
    const { call } = storeSetup();
    expect((await call("POST", "/purchase", { cosmeticId: "golden_brain", purchaseId: PID })).status).toBe(404);
    expect((await call("POST", "/purchase", { cosmeticId: "star_cape", purchaseId: "short" })).status).toBe(400);
  });
});

describe("equip (server-only: clients have no write on equipped)", () => {
  it("equips an owned item in its slot, and takes it off", async () => {
    const { call, store } = storeSetup();
    await call("POST", "/purchase", { cosmeticId: "star_cape", purchaseId: PID });
    expect((await call("POST", "/equip", { companionId: CID, slot: "back", cosmeticId: "star_cape" })).status).toBe(
      200,
    );
    expect(store.companions.get(`hub-user-1/${CID}`)).toEqual({ back: "star_cape" });
    await call("POST", "/equip", { companionId: CID, slot: "back", cosmeticId: null });
    expect(store.companions.get(`hub-user-1/${CID}`)).toEqual({});
  });

  it("free items equip without buying", async () => {
    const { call, store } = storeSetup();
    expect((await call("POST", "/equip", { companionId: CID, slot: "head", cosmeticId: "viking_hat" })).status).toBe(
      200,
    );
    expect(store.companions.get(`hub-user-1/${CID}`)).toEqual({ head: "viking_hat" });
  });

  it("refuses items not owned, the wrong slot, and someone else's companion", async () => {
    const { call } = storeSetup();
    expect((await call("POST", "/equip", { companionId: CID, slot: "back", cosmeticId: "star_cape" })).status).toBe(
      403,
    );
    expect((await call("POST", "/equip", { companionId: CID, slot: "face", cosmeticId: "viking_hat" })).status).toBe(
      400,
    );
    expect(
      (
        await call(
          "POST",
          "/equip",
          { companionId: CID, slot: "head", cosmeticId: "viking_hat" },
          "user:dev_x:hub-user-2",
        )
      ).status,
    ).toBe(404);
  });
});
