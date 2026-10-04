import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { loadPlans } from "@chalito/config";
import { EfficiencyProfile, HubTierId, TierId, type EntitlementInputs, type PlansConfig } from "@chalito/protocol";
import { compedFrom, computeEntitlements, entitlementInputsFrom } from "../src/entitlements.js";

const plans = loadPlans();
const NOW = 1_790_000_000_000;
const base: EntitlementInputs = {
  uid: "u1",
  hubTier: null,
  soloTier: null,
  hubTrialActive: false,
  hubBalanceRemaining: 0,
  comped: false,
  now: NOW,
};
const ent = (over: Partial<EntitlementInputs> = {}, p: PlansConfig = plans) =>
  computeEntitlements({ ...base, ...over }, p);

describe("entitlements", () => {
  it("hub tiers map through plans.yaml: free → none, pro → standard, vip → plus", () => {
    expect(ent({ hubTier: "free", hubBalanceRemaining: 1_000 })).toMatchObject({
      source: "none",
      accessTier: null,
      managedAllowance: { status: "free_min" },
      efficiencyCurrent: "free_min",
    });
    expect(ent({ hubTier: "pro", hubBalanceRemaining: 1_000 })).toMatchObject({
      source: "hub_tier",
      accessTier: "standard",
      managedAllowance: { status: "enabled", remainingBillable: 1_000 },
      maxProfile: "standard",
      limits: { calls: 30, voiceMinutes: 120 },
    });
    expect(ent({ hubTier: "vip", hubBalanceRemaining: 1 })).toMatchObject({
      accessTier: "plus",
      maxProfile: "max",
      limits: { sms: 30 },
    });
  });

  it("Solo tiers use their row; bundles their mirrored tier", () => {
    expect(ent({ soloTier: "lite", hubBalanceRemaining: 5 })).toMatchObject({
      source: "solo",
      accessTier: "lite",
      limits: { whatsapp: 100 },
    });
    expect(ent({ soloTier: "bundle_40", hubBalanceRemaining: 5 })).toMatchObject({
      accessTier: "standard",
      limits: { calls: 30 },
    });
  });

  it("trial mirrors its tier's access on free_min; comped owners get the top tier", () => {
    expect(ent({ hubTrialActive: true, hubBalanceRemaining: 1e6 })).toMatchObject({
      source: "trial",
      accessTier: "starter",
      managedAllowance: { status: "free_min" },
    });
    expect(ent({ comped: true })).toMatchObject({
      source: "comped",
      accessTier: "heavy",
      managedAllowance: { status: "enabled" },
    });
    const isComped = compedFrom(" owner-1, owner-2 ");
    expect([isComped("owner-2"), isComped("u1")]).toEqual([true, false]);
  });

  it("a zero balance drops managed brains to free_min", () => {
    expect(ent({ hubTier: "pro", hubBalanceRemaining: 0 })).toMatchObject({
      managedAllowance: { status: "free_min" },
      efficiencyCurrent: "free_min",
    });
  });

  it("fails closed on unset values", () => {
    const unset = structuredClone(plans) as PlansConfig;
    const lite = unset.tiers.lite!;
    if (lite.inclusions !== "mirror_matching_tier")
      lite.inclusions = { ...lite.inclusions, managedAllowance: "mirror_matching_tier", calls: "mirror_matching_tier" };
    expect(ent({ soloTier: "lite", hubBalanceRemaining: 1e6 }, unset)).toMatchObject({
      managedAllowance: { status: "disabled_unset" },
      limits: { calls: "unset" },
      efficiencyCurrent: "free_min",
    });
    unset.tiers.lite!.inclusions = "mirror_matching_tier";
    expect(ent({ soloTier: "bundle_8", hubBalanceRemaining: 1e6 }, unset)).toMatchObject({
      managedAllowance: { status: "disabled_unset" },
      limits: { devices: "unset" },
    });
  });

  it("a user may pick a cheaper profile, never a pricier one", () => {
    expect(ent({ hubTier: "pro", hubBalanceRemaining: 9, chosenEfficiency: "low" }).efficiencyCurrent).toBe("low");
    expect(ent({ hubTier: "pro", hubBalanceRemaining: 9, chosenEfficiency: "max" }).efficiencyCurrent).toBe("standard");
  });

  it("the input is strict: inventory can't even be passed in", () => {
    expect(() => computeEntitlements({ ...base, inventory: ["viking_hat"] } as never, plans)).toThrow();
  });

  it("property: users who differ only in inventory get identical entitlements (no pay-to-win)", () => {
    const user = fc.record({
      hubTier: fc.option(fc.constantFrom(...HubTierId.options), { nil: null }),
      soloTier: fc.option(fc.constantFrom(...TierId.options), { nil: null }),
      hubTrialActive: fc.boolean(),
      hubBalanceRemaining: fc.integer({ min: 0, max: 1e8 }),
      comped: fc.boolean(),
      chosenEfficiency: fc.option(fc.constantFrom(...EfficiencyProfile.options), { nil: undefined }),
    });
    const inventory = fc.array(fc.record({ cosmeticId: fc.string(), equipped: fc.boolean(), paidUsd: fc.nat() }), {
      maxLength: 8,
    });
    fc.assert(
      fc.property(user, inventory, inventory, (u, invA, invB) => {
        const a = computeEntitlements(
          entitlementInputsFrom({ uid: "u1", ...u, inventory: invA, equipped: invA[0] }, NOW),
          plans,
        );
        const b = computeEntitlements(
          entitlementInputsFrom({ uid: "u1", ...u, inventory: invB, equipped: invB[0] }, NOW),
          plans,
        );
        expect(a).toEqual(b);
      }),
      { numRuns: 300 },
    );
  });

  it("property: safety features are always on, and the current profile never exceeds the ceiling", () => {
    const RANK = { free_min: 0, low: 1, standard: 2, max: 3 } as const;
    fc.assert(
      fc.property(
        fc.record({
          hubTier: fc.option(fc.constantFrom(...HubTierId.options), { nil: null }),
          soloTier: fc.option(fc.constantFrom(...TierId.options), { nil: null }),
          hubTrialActive: fc.boolean(),
          hubBalanceRemaining: fc.integer({ min: 0, max: 1e8 }),
          comped: fc.boolean(),
          chosenEfficiency: fc.option(fc.constantFrom(...EfficiencyProfile.options), { nil: undefined }),
        }),
        (u) => {
          const e = computeEntitlements(
            { ...base, ...u, ...(u.chosenEfficiency ? {} : { chosenEfficiency: undefined }) } as EntitlementInputs,
            plans,
          );
          expect(e.safetyFeatures).toBe(true);
          expect(RANK[e.efficiencyCurrent]).toBeLessThanOrEqual(RANK[e.maxProfile]);
          if (!u.comped && u.hubBalanceRemaining === 0) expect(e.managedAllowance.status).not.toBe("enabled");
        },
      ),
      { numRuns: 300 },
    );
  });
});
