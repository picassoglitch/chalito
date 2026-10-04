// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { PlansConfig } from "@chalito/protocol";
import { landingPlans } from "@/lib/landing-plans";

const raw = parse(readFileSync(join(__dirname, "../../../packages/config/plans.yaml"), "utf8"));
const cfg = PlansConfig.parse(raw);

describe("landing plans come from plans.yaml", () => {
  it("the Solo ladder: every solo tier, in sortOrder, with its own name and inclusions", () => {
    const p = landingPlans(cfg);
    const expected = Object.entries(cfg.tiers)
      .filter(([, t]) => t.line === "solo")
      .sort(([, a], [, b]) => a.sortOrder - b.sortOrder);
    expect(p.solo.map((s) => s.id)).toEqual(expected.map(([id]) => id));
    for (const [id, t] of expected) {
      const s = p.solo.find((x) => x.id === id)!;
      expect(s.name).toBe(t.displayName);
      if (t.inclusions !== "mirror_matching_tier") {
        expect(s.devices).toBe(t.inclusions.devices);
        expect(s.rooms).toBe(t.inclusions.rooms);
      }
    }
    expect(p.solo.some((s) => s.id.startsWith("bundle"))).toBe(false);
  });

  it("no MXN amount set → no price (the page says coming soon)", () => {
    const unset = PlansConfig.parse({ ...raw, billing: { ...raw.billing, soloMxnAmounts: "unset" } });
    expect(landingPlans(unset).solo.every((s) => s.mxn === null)).toBe(true);
  });

  it("an MXN amount set on the hub shows for that tier only", () => {
    const amounts = Object.fromEntries(Object.keys(cfg.tiers).map((id, i) => [id, 100 + i]));
    const set = PlansConfig.parse({ ...raw, billing: { ...raw.billing, soloMxnAmounts: amounts } });
    for (const s of landingPlans(set).solo) expect(s.mxn).toBe(amounts[s.id]);
  });

  it("hub tiers: what each includes, by the tier's display name", () => {
    const hub = landingPlans(cfg).hub;
    expect(hub.map((h) => h.id)).toEqual(["free", "pro", "vip"]);
    for (const h of hub) {
      const access = cfg.hubTiers[h.id]!.access;
      expect(h.includes).toBe(access === "none" ? null : cfg.tiers[access]!.displayName);
    }
  });
});
