import { z } from "zod";
import { EfficiencyProfile } from "./common.js";

/**
 * Schema for packages/config/plans.yaml: the owner's Solo ladder (brief §12) plus
 * the Chalito access each Chalyb hub tier grants. Prices and allowances are
 * config, never code. `mirror_matching_tier` on a bundle means "use the mirrored
 * tier's inclusions"; anywhere else code treats it as UNSET and fails closed.
 */
export const MIRROR = "mirror_matching_tier" as const;
export const Mirror = z.literal(MIRROR);

export const TierId = z.enum(["bundle_8", "lite", "starter", "standard", "bundle_40", "plus", "heavy"]);
export type TierId = z.infer<typeof TierId>;
export const LadderTierId = z.enum(["lite", "starter", "standard", "plus", "heavy"]);

/** A count/allowance: a non-negative number once the owner sets it, else the mirror sentinel. */
export const InclusionValue = z.union([z.number().nonnegative(), Mirror]);

export const Inclusions = z.object({
  devices: InclusionValue,
  concurrentSessions: InclusionValue,
  /** Monthly safety caps. Usage still draws on the billable-token balance. */
  voiceMinutes: InclusionValue,
  calls: InclusionValue,
  whatsapp: InclusionValue,
  sms: InclusionValue,
  rooms: InclusionValue,
  membersPerRoom: InclusionValue,
  mesaBrains: InclusionValue,
  /** Most expensive efficiency profile this tier may use (progressive access). */
  maxProfile: EfficiencyProfile.exclude(["free_min"]),
  managedAllowance: z.union([z.object({ billableTokens: InclusionValue }), Mirror]),
});
export type Inclusions = z.infer<typeof Inclusions>;

const Tier = z.object({
  displayName: z.string().min(1).max(40),
  priceUsd: z.number().positive(),
  approx: z.boolean().default(false),
  line: z.enum(["solo", "bundle"]),
  /** Purchase paths. Ladder tiers are sold on the Solo site and through the Chalyb hub. */
  availableVia: z.array(z.enum(["solo", "chalyb"])).optional(),
  efficiencyDefault: EfficiencyProfile.exclude(["free_min"]),
  /** Bundles grant a ladder tier's entitlements. */
  mirrors: LadderTierId.optional(),
  creditBucket: z.union([
    z.literal("none"),
    z.object({ priceUsd: z.number().positive(), grants: z.literal("matching_tier_managed_allowance_once") }),
  ]),
  inclusions: z.union([Inclusions, Mirror]),
  sortOrder: z.number().int(),
});
export type Tier = z.infer<typeof Tier>;

/** Chalyb hub tiers. Their prices live in Chalyb; here only the Chalito access they grant. */
export const HubTierId = z.enum(["free", "pro", "vip"]);
// Values as the hub sends them (lowercase effective tier; "free" is Chalyb Gratis).
export type HubTierId = z.infer<typeof HubTierId>;

/** Numeric inclusions a hub tier may lower below its ladder tier's (e.g. Gratis: 1 device). */
export const LimitKey = z.enum([
  "devices",
  "concurrentSessions",
  "voiceMinutes",
  "calls",
  "whatsapp",
  "sms",
  "rooms",
  "membersPerRoom",
  "mesaBrains",
]);
export type LimitKey = z.infer<typeof LimitKey>;

const HubTier = z.object({
  access: z.union([LadderTierId, z.literal("none")]),
  /** Caps on top of the ladder tier's inclusions. Only lowers: a cap above the tier's value is invalid. */
  limits: z.partialRecord(LimitKey, z.number().int().nonnegative()).optional(),
});

const PROFILE_RANK = { low: 0, standard: 1, max: 2 } as const;

export const PlansConfig = z
  .object({
    schemaVersion: z.literal(2),
    currency: z.literal("USD"),
    interval: z.literal("month"),
    billingUnit: z.object({ source: z.literal("chalyb_hub"), usdPerMillionBillable: z.number().positive() }),
    hubTiers: z.record(HubTierId, HubTier),
    tiers: z.record(TierId, Tier),
    trial: z.object({
      source: z.literal("chalyb_hub"),
      mirrors: LadderTierId,
      managedAllowance: z.literal("free_min"),
    }),
    billing: z.object({
      provider: z.literal("chalyb_hub"),
      checkoutCurrency: z.literal("MXN"),
      soloMxnAmounts: z.union([z.literal("unset"), z.record(TierId, z.number().int().positive())]),
      freeMin: z.object({ priceUsd: z.literal(0), mode: z.enum(["deterministic", "cheap_llm"]) }),
      byo: z.object({ capped: z.literal(false), charged: z.literal(false) }),
    }),
    credits: z.object({ expiry: z.union([z.literal("none"), z.string().regex(/^P\d+[DMY]$/)]) }),
    features: z.object({ mcpGateway: z.enum(["all_tiers", "paid_tiers"]) }),
    efficiency: z.object({ userMayPickCheaper: z.boolean() }),
  })
  .superRefine((cfg, ctx) => {
    for (const id of TierId.options) {
      if (!cfg.tiers[id]) ctx.addIssue({ code: "custom", message: `missing tier ${id}`, path: ["tiers", id] });
    }
    for (const id of HubTierId.options) {
      const hub = cfg.hubTiers[id];
      if (!hub) {
        ctx.addIssue({ code: "custom", message: `missing hub tier ${id}`, path: ["hubTiers", id] });
        continue;
      }
      if (!hub.limits) continue;
      const base = hub.access === "none" ? undefined : cfg.tiers[hub.access]?.inclusions;
      for (const [k, v] of Object.entries(hub.limits)) {
        const path = ["hubTiers", id, "limits", k];
        if (!base || base === MIRROR) {
          ctx.addIssue({ code: "custom", message: "limits need a ladder tier with set inclusions", path });
          continue;
        }
        const b = base[k as LimitKey];
        if (typeof b === "number" && (v as number) > b)
          ctx.addIssue({ code: "custom", message: `${k} cap ${v} is above the tier's ${b}`, path });
      }
    }
    for (const [id, t] of Object.entries(cfg.tiers)) {
      const path = ["tiers", id];
      if (t.line === "bundle") {
        if (!t.mirrors) ctx.addIssue({ code: "custom", message: "bundle must declare mirrors", path });
        if (t.creditBucket !== "none") ctx.addIssue({ code: "custom", message: "bundles have no credit bucket", path });
        continue;
      }
      if (t.creditBucket !== "none" && t.creditBucket.priceUsd !== t.priceUsd) {
        ctx.addIssue({ code: "custom", message: "bucket price must equal the tier's ladder price", path });
      }
      if (t.inclusions === MIRROR) continue;
      const inc = t.inclusions;
      // The default profile can't be pricier than the tier's ceiling.
      if (PROFILE_RANK[t.efficiencyDefault] > PROFILE_RANK[inc.maxProfile]) {
        ctx.addIssue({ code: "custom", message: "efficiencyDefault exceeds maxProfile", path });
      }
      // Hub sizing rule: a fully spent allowance at billed prices never exceeds the price.
      if (inc.managedAllowance !== MIRROR && isSet(inc.managedAllowance.billableTokens)) {
        const billedUsd = (inc.managedAllowance.billableTokens / 1_000_000) * cfg.billingUnit.usdPerMillionBillable;
        if (billedUsd > t.priceUsd) {
          ctx.addIssue({ code: "custom", message: `allowance bills $${billedUsd} > price $${t.priceUsd}`, path });
        }
      }
    }
    // Progressive: ordering by price never decreases any numeric inclusion.
    const ladder = Object.values(cfg.tiers)
      .filter((t) => t.line === "solo" && t.inclusions !== MIRROR)
      .sort((a, b) => a.priceUsd - b.priceUsd);
    for (let i = 1; i < ladder.length; i++) {
      const prev = ladder[i - 1]!.inclusions as Inclusions;
      const cur = ladder[i]!.inclusions as Inclusions;
      for (const k of Object.keys(cur) as (keyof Inclusions)[]) {
        const a = prev[k];
        const b = cur[k];
        if (typeof a === "number" && typeof b === "number" && b < a) {
          ctx.addIssue({
            code: "custom",
            message: `${k} decreases from a cheaper tier`,
            path: ["tiers", ladder[i]!.displayName],
          });
        }
      }
    }
  });
export type PlansConfig = z.infer<typeof PlansConfig>;

/** True only when the owner has filled in a concrete number. */
export const isSet = (v: z.infer<typeof InclusionValue>): v is number => typeof v === "number";

/**
 * The inclusions that apply to a tier id: a hub tier (free/pro/vip) maps to its ladder tier with
 * its `limits` caps applied; a bundle takes its mirrored tier's. null = no access or unset (fail closed).
 */
export const resolveInclusions = (cfg: PlansConfig, tier: string | null | undefined): Inclusions | null => {
  if (!tier) return null;
  let id: string = tier;
  let caps: Partial<Record<LimitKey, number>> | undefined;
  const hub = HubTierId.safeParse(tier);
  if (hub.success) {
    const h = cfg.hubTiers[hub.data];
    if (!h || h.access === "none") return null;
    id = h.access;
    caps = h.limits;
  }
  const parsed = TierId.safeParse(id);
  if (!parsed.success) return null;
  const def = cfg.tiers[parsed.data];
  if (!def) return null;
  let inc: Inclusions | null = def.inclusions !== MIRROR ? def.inclusions : null;
  if (!inc) {
    const mirrored = def.mirrors ? cfg.tiers[def.mirrors] : undefined;
    inc = mirrored && mirrored.inclusions !== MIRROR ? mirrored.inclusions : null;
  }
  if (!inc || !caps) return inc;
  const out: Inclusions = { ...inc };
  for (const [k, v] of Object.entries(caps) as [LimitKey, number][]) {
    const cur = out[k];
    out[k] = typeof cur === "number" ? Math.min(cur, v) : v;
  }
  return out;
};
