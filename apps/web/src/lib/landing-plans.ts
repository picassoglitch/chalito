import { isSet, type HubTierId, type PlansConfig, type TierId } from "@chalito/protocol";

export interface SoloPlan {
  id: TierId;
  name: string;
  /** The hub's MXN charge for this tier; null until the owner sets it ("Disponible pronto"). */
  mxn: number | null;
  devices: number | null;
  sessions: number | null;
  voiceMinutes: number | null;
  rooms: number | null;
}

export interface HubPlan {
  id: HubTierId;
  /** The Solo tier whose features it includes; null for BYO keys only. */
  includes: string | null;
}

export interface LandingPlans {
  solo: SoloPlan[];
  hub: HubPlan[];
}

const num = (v: number | "mirror_matching_tier"): number | null => (isSet(v) ? v : null);

/** The Solo ladder (in plans.yaml order) and the Chalyb tiers that include Chalito. No prices but the hub's MXN ones. */
export const landingPlans = (cfg: PlansConfig): LandingPlans => {
  const amounts = cfg.billing.soloMxnAmounts;
  const solo = (Object.entries(cfg.tiers) as [TierId, PlansConfig["tiers"][TierId]][])
    .filter(([, t]) => t.line === "solo" && (t.availableVia ?? ["solo"]).includes("solo"))
    .sort(([, a], [, b]) => a.sortOrder - b.sortOrder)
    .map(([id, t]): SoloPlan => {
      const inc = t.inclusions === "mirror_matching_tier" ? null : t.inclusions;
      return {
        id,
        name: t.displayName,
        mxn: amounts === "unset" ? null : (amounts[id] ?? null),
        devices: inc ? num(inc.devices) : null,
        sessions: inc ? num(inc.concurrentSessions) : null,
        voiceMinutes: inc ? num(inc.voiceMinutes) : null,
        rooms: inc ? num(inc.rooms) : null,
      };
    });
  const hub = (["free", "pro", "vip"] as const).map((id): HubPlan => {
    const access = cfg.hubTiers[id]?.access ?? "none";
    return { id, includes: access === "none" ? null : (cfg.tiers[access]?.displayName ?? null) };
  });
  return { solo, hub };
};
