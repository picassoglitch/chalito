import type { z } from "zod";
import {
  EntitlementInputs,
  Entitlements,
  MIRROR,
  type EfficiencyProfile,
  type Inclusions,
  type PlansConfig,
  type TierId,
} from "@chalito/protocol";

const RANK: Record<EfficiencyProfile, number> = { free_min: 0, low: 1, standard: 2, max: 3 };
const LIMIT_KEYS = [
  "devices",
  "concurrentSessions",
  "voiceMinutes",
  "calls",
  "whatsapp",
  "sms",
  "rooms",
  "membersPerRoom",
  "mesaBrains",
] as const;

/** The top ladder tier, for comped owner accounts (the hub never refuses admins either). */
const COMPED_TIER: TierId = "heavy";

/** A tier's inclusions; a bundle takes its mirrored tier's. null = unset (fail closed). */
const inclusionsOf = (plans: PlansConfig, tier: TierId): Inclusions | null => {
  const t = plans.tiers[tier];
  if (!t) return null;
  if (t.inclusions !== MIRROR) return t.inclusions;
  const mirrored = t.mirrors ? plans.tiers[t.mirrors] : undefined;
  return mirrored && mirrored.inclusions !== MIRROR ? mirrored.inclusions : null;
};

/** The ladder tier whose access applies: bundles grant their mirrored tier. */
const accessTierOf = (plans: PlansConfig, tier: TierId): TierId => plans.tiers[tier]?.mirrors ?? tier;

/**
 * Entitlements = f(hub tier or Solo tier, hub trial, hub balance, comped, now) — ADR 0013. Pure.
 * The input type is strict and has no inventory: cosmetics can't buy capability (pay-to-dress,
 * never pay-to-win). Unset (`mirror_matching_tier`) values fail closed. Safety features are
 * always on, whatever the plan state.
 */
export const computeEntitlements = (raw: z.input<typeof EntitlementInputs>, plans: PlansConfig): Entitlements => {
  const i = EntitlementInputs.parse(raw);

  let source: Entitlements["source"];
  let tier: TierId | null;
  if (i.comped) {
    source = "comped";
    tier = COMPED_TIER;
  } else if (i.soloTier) {
    source = "solo";
    tier = i.soloTier;
  } else if (i.hubTier && plans.hubTiers[i.hubTier]?.access && plans.hubTiers[i.hubTier]!.access !== "none") {
    source = "hub_tier";
    tier = plans.hubTiers[i.hubTier]!.access as TierId;
  } else if (i.hubTrialActive) {
    source = "trial";
    tier = plans.trial.mirrors;
  } else {
    source = "none";
    tier = null;
  }

  const accessTier = tier ? accessTierOf(plans, tier) : null;
  const inc = tier ? inclusionsOf(plans, tier) : null;
  const tierRow = tier ? plans.tiers[tier] : undefined;

  // Managed brains: only with a set allowance and a positive hub balance (comped: never refused).
  let managedAllowance: Entitlements["managedAllowance"];
  if (!tier || source === "trial") managedAllowance = { status: "free_min" };
  else if (!inc || inc.managedAllowance === MIRROR || typeof inc.managedAllowance.billableTokens !== "number")
    managedAllowance = { status: "disabled_unset" };
  else if (source === "comped" || i.hubUnlimited)
    managedAllowance = { status: "enabled", remainingBillable: i.hubBalanceRemaining };
  else if (i.hubBalanceRemaining <= 0) managedAllowance = { status: "free_min" };
  else managedAllowance = { status: "enabled", remainingBillable: i.hubBalanceRemaining };

  const managed = managedAllowance.status === "enabled";
  const maxProfile: EfficiencyProfile = managed && inc ? inc.maxProfile : "free_min";
  const efficiencyDefault: EfficiencyProfile = managed && tierRow ? tierRow.efficiencyDefault : "free_min";
  const chosen = i.chosenEfficiency;
  const efficiencyCurrent: EfficiencyProfile =
    managed && chosen && plans.efficiency.userMayPickCheaper && RANK[chosen] <= RANK[maxProfile]
      ? chosen
      : efficiencyDefault;

  const limits = Object.fromEntries(
    LIMIT_KEYS.map((k) => [k, inc && typeof inc[k] === "number" ? (inc[k] as number) : ("unset" as const)]),
  ) as Entitlements["limits"];

  return Entitlements.parse({
    v: 2,
    uid: i.uid,
    source,
    hubTier: i.hubTier,
    accessTier,
    efficiencyDefault,
    efficiencyCurrent,
    maxProfile,
    managedAllowance,
    limits,
    features: { mcpGateway: plans.features.mcpGateway === "all_tiers" || source !== "none" },
    safetyFeatures: true,
    computedAt: i.now,
  });
};

/**
 * Picks the entitlement inputs out of a wider user record. Only whitelisted fields pass, so
 * whatever else the record holds (inventory, equipped cosmetics, …) can't reach the function.
 */
export const entitlementInputsFrom = (
  user: {
    uid: string;
    hubTier: EntitlementInputs["hubTier"];
    soloTier: EntitlementInputs["soloTier"];
    hubTrialActive: boolean;
    hubBalanceRemaining: number;
    hubUnlimited?: boolean;
    comped: boolean;
    chosenEfficiency?: EfficiencyProfile;
    [other: string]: unknown;
  },
  now: number,
): EntitlementInputs => ({
  uid: user.uid,
  hubTier: user.hubTier,
  soloTier: user.soloTier,
  hubTrialActive: user.hubTrialActive,
  hubBalanceRemaining: Math.max(0, user.hubBalanceRemaining),
  hubUnlimited: user.hubUnlimited === true,
  comped: user.comped,
  ...(user.chosenEfficiency ? { chosenEfficiency: user.chosenEfficiency } : {}),
  now,
});

/** OWNER_UIDS (comma-separated env) → comped check. */
export const compedFrom = (ownerUids: string | undefined) => {
  const set = new Set(
    (ownerUids ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return (uid: string) => set.has(uid);
};
