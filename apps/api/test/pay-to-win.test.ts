import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeEntitlements, entitlementInputsFrom } from "@chalito/billing";
import { CatalogConfig, loadPlans } from "@chalito/config";
import { CosmeticSlot } from "@chalito/protocol";
import { CID, catalog, storeSetup } from "./store-harness.js";

const plans = loadPlans();
const ids = Object.keys(catalog.cosmetics);
const NOW = 1_790_000_000_000;

const userRecord = fc.record({
  uid: fc.constant("hub-user-1"),
  hubTier: fc.constantFrom(null, "free", "pro", "vip"),
  soloTier: fc.constant(null),
  hubTrialActive: fc.boolean(),
  hubBalanceRemaining: fc.integer({ min: 0, max: 10_000_000 }),
  comped: fc.boolean(),
  chosenEfficiency: fc.constantFrom(undefined, "free_min", "low", "standard", "max"),
});

const op = fc.oneof(
  fc.record({
    kind: fc.constant("purchase" as const),
    cosmeticId: fc.constantFrom(...ids),
    purchaseId: fc.stringMatching(/^pur_[a-z0-9]{16}$/),
  }),
  fc.record({
    kind: fc.constant("equip" as const),
    slot: fc.constantFrom(...CosmeticSlot.options),
    cosmeticId: fc.option(fc.constantFrom(...ids), { nil: null }),
  }),
);

/**
 * Pay-to-dress, never pay-to-win: whatever a user buys or equips through the real store routes,
 * their entitlements — access tier, limits, managed allowance, model profile (efficiency
 * default/current/max) and safety features — are exactly those of the same user with nothing.
 */
describe("cosmetics never change entitlements, the model profile or safety", () => {
  it("any sequence of purchases and equips leaves entitlements identical", async () => {
    await fc.assert(
      fc.asyncProperty(userRecord, fc.array(op, { maxLength: 12 }), async (u, ops) => {
        const user = Object.fromEntries(Object.entries(u).filter(([, v]) => v !== undefined)) as typeof u;
        const before = computeEntitlements(entitlementInputsFrom({ ...user }, NOW), plans);
        const { call, store } = storeSetup();
        for (const o of ops) {
          if (o.kind === "purchase")
            await call("POST", "/purchase", { cosmeticId: o.cosmeticId, purchaseId: o.purchaseId });
          else await call("POST", "/equip", { companionId: CID, slot: o.slot, cosmeticId: o.cosmeticId });
        }
        const dressed = {
          ...user,
          inventory: [...(await store.owned("hub-user-1"))],
          equipped: store.companions.get(`hub-user-1/${CID}`),
          purchases: [...store.purchases.values()],
        };
        const after = computeEntitlements(entitlementInputsFrom(dressed, NOW), plans);
        expect(after).toEqual(before);
        expect(after.safetyFeatures).toBe(true);
      }),
      { numRuns: 150 },
    );
  });

  it("the entitlement inputs refuse inventory outright (strict schema)", () => {
    expect(() =>
      computeEntitlements(
        {
          uid: "u",
          hubTier: "free",
          soloTier: null,
          hubTrialActive: false,
          hubBalanceRemaining: 0,
          comped: false,
          now: NOW,
          inventory: ["star_cape"],
        } as never,
        plans,
      ),
    ).toThrow();
  });

  it("a catalog item carries only looks and a price: capability-like keys never survive parsing", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("maxProfile", "efficiency", "model", "safety", "safetyFeatures", "limits", "tier", "boost"),
        fc.jsonValue(),
        (key, value) => {
          const raw = structuredClone(catalog) as Record<string, unknown> & { cosmetics: Record<string, object> };
          raw.cosmetics.star_cape = { ...raw.cosmetics.star_cape, [key]: value };
          const parsed = CatalogConfig.parse(raw);
          expect(Object.keys(parsed.cosmetics.star_cape!).sort()).toEqual(
            ["art", "card", "free", "name", "priceTokens", "provenance", "slot", "vrm"].sort(),
          );
        },
      ),
    );
  });
});
