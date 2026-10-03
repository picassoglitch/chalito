import { z } from "zod";
import { EfficiencyProfile } from "./common.js";

/**
 * Schema for packages/config/plans.yaml (the owner's ladder, §12 of the brief).
 * Prices and allowances are config, never code. `mirror_matching_tier` means
 * "the owner fills this in from the matching tier on the reference ladder"; code
 * must treat it as UNSET and fail closed (e.g. managed allowance disabled in prod).
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
  voiceMinutes: InclusionValue,
  calls: InclusionValue,
  whatsapp: InclusionValue,
  rooms: InclusionValue,
  membersPerRoom: InclusionValue,
  managedAllowance: z.union([
    z.object({
      tokens: InclusionValue,
      voiceMin: InclusionValue,
      calls: InclusionValue,
      whatsapp: InclusionValue,
    }),
    Mirror,
  ]),
});
export type Inclusions = z.infer<typeof Inclusions>;

const Tier = z.object({
  displayName: z.string().min(1).max(40),
  priceUsd: z.number().positive(),
  approx: z.boolean().default(false),
  line: z.enum(["solo", "bundle"]),
  /** Purchase paths. Ladder tiers are sold on the Solo site and through the Chalyb hand-off. */
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

export const PlansConfig = z
  .object({
    schemaVersion: z.literal(1),
    currency: z.literal("USD"),
    interval: z.literal("month"),
    tiers: z.record(TierId, Tier),
    trial: z.object({
      length: z.literal("P1M"),
      mirrors: LadderTierId,
      managedAllowance: z.literal("free_min"),
    }),
    billing: z.object({
      provider: z.enum(["stripe", "mercadopago"]),
      stubs: z.array(z.enum(["stripe", "mercadopago"])).default([]),
      freeMin: z.object({ priceUsd: z.literal(0), mode: z.enum(["deterministic", "cheap_llm"]) }),
      byo: z.object({ capped: z.literal(false), charged: z.literal(false) }),
    }),
    credits: z.object({ expiry: z.union([z.literal("none"), z.string().regex(/^P\d+[DMY]$/)]) }),
    features: z.object({ mcpGateway: z.enum(["all_tiers", "paid_tiers"]) }),
    efficiency: z.object({ userMayPickCheaper: z.boolean() }),
  })
  .superRefine((cfg, ctx) => {
    const ids = TierId.options;
    for (const id of ids) {
      if (!cfg.tiers[id]) ctx.addIssue({ code: "custom", message: `missing tier ${id}`, path: ["tiers", id] });
    }
    for (const [id, t] of Object.entries(cfg.tiers)) {
      if (t.line === "bundle") {
        if (!t.mirrors) ctx.addIssue({ code: "custom", message: "bundle must declare mirrors", path: ["tiers", id] });
        if (t.creditBucket !== "none")
          ctx.addIssue({ code: "custom", message: "bundles have no credit bucket", path: ["tiers", id] });
      } else if (t.creditBucket !== "none" && t.creditBucket.priceUsd !== t.priceUsd) {
        ctx.addIssue({ code: "custom", message: "bucket price must equal the tier's ladder price", path: ["tiers", id] });
      }
    }
  });
export type PlansConfig = z.infer<typeof PlansConfig>;

/** True only when the owner has filled in a concrete number. */
export const isSet = (v: z.infer<typeof InclusionValue>): v is number => typeof v === "number";
