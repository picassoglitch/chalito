import { describe, expect, it } from "vitest";
import { CosmeticSlot, HubUsageEvent } from "@chalito/protocol";
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
    expect(res.json).toMatchObject({ status: "owned", charged: 1_000 });
    expect(hubCalls.map((c) => c.path)).toEqual(["admit", "settle"]);
    expect(hubCalls[0]!.body).toMatchObject({
      external_user_id: "hub-user-1",
      external_job_id: `store:${PID}`,
      class: "job",
      operation: "store.purchase",
      est_tokens: 1_000,
    });
    expect(hubCalls[1]!.body).toEqual({ reservation_id: RID, outcome: "succeeded" });
    expect(store.outbox).toHaveLength(1);
    const e = HubUsageEvent.parse(store.outbox[0]);
    expect(e).toMatchObject({
      source_id: `store:${PID}`,
      kind: "store.purchase",
      external_user_id: "hub-user-1",
      cost_usd_micros: 4_000,
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

describe("neck pieces (one per slot, next to everything else)", () => {
  it("wears one item in every slot at once, neck included; a second neck piece replaces the first", async () => {
    const { call, store } = storeSetup();
    const paid = ["bow_tie", "bow_tie_red", "star_cape", "sparkle_aura", "portal_swirl", "skin_gold"];
    for (const [n, id] of paid.entries())
      expect(
        (await call("POST", "/purchase", { cosmeticId: id, purchaseId: `pur_neck${String(n).padStart(12, "0")}` }))
          .status,
      ).toBe(200);
    const equip = (slot: string, cosmeticId: string | null) =>
      call("POST", "/equip", { companionId: CID, slot, cosmeticId });
    const wear = {
      head: "viking_hat",
      face: "round_glasses",
      neck: "bow_tie",
      back: "star_cape",
      aura: "sparkle_aura",
      portal_fx: "portal_swirl",
      skin: "skin_gold",
    };
    for (const [slot, id] of Object.entries(wear)) expect((await equip(slot, id)).status).toBe(200);
    expect(store.companions.get(`hub-user-1/${CID}`)).toEqual(wear);
    // Every slot but `body` (nothing is sold for it yet): eight slots, the directory's limit
    // (migration 20261006080000).
    expect(CosmeticSlot.options.filter((s) => !(s in wear))).toEqual(["body"]);
    expect(CosmeticSlot.options).toHaveLength(8);
    expect((await equip("neck", "bow_tie_red")).status).toBe(200);
    expect(store.companions.get(`hub-user-1/${CID}`)).toEqual({ ...wear, neck: "bow_tie_red" });
    // A neck piece only goes on the neck, and only once owned.
    expect((await equip("head", "bow_tie_red")).status).toBe(400);
    expect((await equip("neck", "viking_hat")).status).toBe(400);
    expect((await equip("neck", "pearl_necklace")).status).toBe(403);
  });
});

describe("skins (a material effect over the companion, one at a time)", () => {
  const buy = (call: ReturnType<typeof storeSetup>["call"], id: string, n: number) =>
    call("POST", "/purchase", { cosmeticId: id, purchaseId: `pur_skin${String(n).padStart(12, "0")}` });

  it("the catalog lists skins with their effect and price, and no art or placement", async () => {
    const { call } = storeSetup();
    const items = (await call("GET", "/catalog")).json.items as Record<string, unknown>[];
    const skins = items.filter((i) => i.slot === "skin");
    expect(skins.length).toBeGreaterThanOrEqual(7);
    for (const s of skins) {
      expect(s).toMatchObject({ free: false, owned: false, skin: expect.any(String) });
      expect(s.priceTokens).toBeGreaterThan(0);
      expect(s).not.toHaveProperty("art");
      expect(s).not.toHaveProperty("card");
    }
    for (const i of items.filter((i) => i.slot !== "skin")) expect(i).toHaveProperty("art");
  });

  it("is bought like any paid item, priced from the catalog", async () => {
    const { call, store } = storeSetup();
    const res = await buy(call, "skin_galaxy", 1);
    expect(res.json).toMatchObject({ status: "owned", charged: catalog.cosmetics.skin_galaxy!.priceTokens });
    expect(store.outbox[0]!.cost_usd_micros).toBe(catalog.cosmetics.skin_galaxy!.priceTokens! * 4);
  });

  it("equips only in the skin slot, only once owned, and a second skin replaces the first", async () => {
    const { call, store } = storeSetup();
    const equip = (slot: string, cosmeticId: string | null) =>
      call("POST", "/equip", { companionId: CID, slot, cosmeticId });
    expect((await equip("skin", "skin_gold")).status).toBe(403);
    await buy(call, "skin_gold", 1);
    await buy(call, "skin_neon", 2);
    expect((await equip("head", "skin_gold")).status).toBe(400);
    expect((await equip("skin", "viking_hat")).status).toBe(400);
    expect((await equip("head", "viking_hat")).status).toBe(200);
    expect((await equip("skin", "skin_gold")).status).toBe(200);
    expect(store.companions.get(`hub-user-1/${CID}`)).toEqual({ head: "viking_hat", skin: "skin_gold" });
    expect((await equip("skin", "skin_neon")).status).toBe(200);
    expect(store.companions.get(`hub-user-1/${CID}`)).toEqual({ head: "viking_hat", skin: "skin_neon" });
    expect((await equip("skin", null)).status).toBe(200);
    expect(store.companions.get(`hub-user-1/${CID}`)).toEqual({ head: "viking_hat" });
  });
});

describe("R-L9: store odds and ends", () => {
  it("an admit with a balance short of the price is refused (no_tokens), the reservation cancelled", async () => {
    const { call, store } = storeSetup();
    hubState.remaining = catalog.cosmetics.star_cape!.priceTokens! - 1;
    const res = await call("POST", "/purchase", { cosmeticId: "star_cape", purchaseId: PID });
    expect(res).toMatchObject({ status: 402, json: { error: "no_tokens" } });
    expect(store.outbox).toHaveLength(0);
    expect(hubCalls.at(-1)!.body).toMatchObject({ outcome: "cancelled" });
  });

  it("prototype keys are not catalog items", async () => {
    const { call } = storeSetup();
    for (const id of ["__proto__", "constructor", "tostring"]) {
      expect((await call("POST", "/purchase", { cosmeticId: id, purchaseId: PID })).status).toBe(404);
      expect((await call("POST", "/equip", { companionId: CID, slot: "head", cosmeticId: id })).status).toBe(404);
    }
  });
});
