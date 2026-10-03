import { z } from "zod";
import { EfficiencyProfile, EpochMs, Id, Uid, Units } from "./common.js";
import { TierId } from "./plans.js";

export const BillingProviderId = z.enum(["stripe", "mercadopago", "chalyb_handoff"]);

/** `purchases/{purchaseId}`: server-written from verified provider webhooks only. */
export const Purchase = z.object({
  v: z.literal(1),
  purchaseId: Id,
  uid: Uid,
  kind: z.enum(["subscription", "credits", "cosmetic"]),
  /** SKU from plans.yaml / catalog.yaml; never a client-supplied price. */
  sku: z.string().max(64),
  /** Minor units as reported by the provider (e.g. cents). */
  amount: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  provider: BillingProviderId,
  providerRef: z.string().max(255),
  status: z.enum(["pending", "paid", "refunded", "failed"]),
  createdAt: EpochMs,
});
export type Purchase = z.infer<typeof Purchase>;

export const LedgerType = z.enum(["trial", "purchase", "grant", "consume", "refund", "adjust"]);

/**
 * `users/{uid}/creditLedger/{entryId}`: append-only, server-only.
 * `idemKey` = provider event id (purchase/refund) or usage event id (consume); the
 * entry id is derived from it so a replay can never double-grant or double-charge.
 */
export const LedgerEntry = z
  .object({
    v: z.literal(1),
    entryId: Id,
    uid: Uid,
    type: LedgerType,
    tierId: TierId.nullable(),
    /** Signed deltas: grants positive, consumption negative. */
    units: Units,
    /** Provider cost estimate (from prices.yaml) for consume entries; amount paid for purchases. */
    costUsdEst: z.number().nonnegative(),
    balanceAfter: Units,
    idemKey: z.string().min(1).max(255),
    usageEventRef: z.string().max(255).optional(),
    t: EpochMs,
  })
  .refine((e) => Object.values(e.balanceAfter).every((n) => n >= 0), { message: "balance can never go negative" })
  .refine((e) => e.type !== "consume" || Object.values(e.units).every((n) => n <= 0), {
    message: "consume entries must not add units",
  });
export type LedgerEntry = z.infer<typeof LedgerEntry>;

export const ManagedAllowance = z.discriminatedUnion("status", [
  z.object({ status: z.literal("enabled"), monthly: Units }),
  /** Owner hasn't filled the tier's allowance (`mirror_matching_tier`): fail closed, UI shows "Disponible pronto". */
  z.object({ status: z.literal("disabled_unset") }),
  z.object({ status: z.literal("free_min") }),
]);

export const Limit = z.union([z.number().int().nonnegative(), z.literal("unset")]);

/**
 * Entitlements = f(subscription tier, trial, credit balance). Inventory/cosmetics are
 * deliberately NOT an input (pay-to-dress, never pay-to-win); the property test in M8/M12
 * asserts equality for users who differ only in inventory.
 */
export const Entitlements = z.object({
  v: z.literal(1),
  uid: Uid,
  source: z.enum(["subscription", "trial", "comped", "none"]),
  tierId: TierId.nullable(),
  /** The default profile for the tier; the user may pick a cheaper one. */
  efficiencyDefault: EfficiencyProfile,
  efficiencyCurrent: EfficiencyProfile,
  managedAllowance: ManagedAllowance,
  creditBalance: Units,
  limits: z.object({
    devices: Limit,
    concurrentSessions: Limit,
    voiceMinutes: Limit,
    calls: Limit,
    whatsapp: Limit,
    rooms: Limit,
    membersPerRoom: Limit,
  }),
  features: z.object({ mcpGateway: z.boolean() }),
  /** Always true regardless of plan state: sign-in, approvals, revocation, Developer-mode off, export. */
  safetyFeatures: z.literal(true),
  trialEndsAt: EpochMs.nullable(),
  computedAt: EpochMs,
});
export type Entitlements = z.infer<typeof Entitlements>;

/** Inputs allowed into the entitlements function: the type has no inventory field on purpose. */
export const EntitlementInputs = z
  .object({
    uid: Uid,
    subscription: z
      .object({
        tierId: TierId,
        status: z.enum(["trialing", "active", "past_due", "canceled"]),
        periodEnd: EpochMs,
        comped: z.boolean(),
      })
      .nullable(),
    trialEndsAt: EpochMs.nullable(),
    creditBalance: Units,
    chosenEfficiency: EfficiencyProfile.optional(),
    now: EpochMs,
  })
  .strict();
export type EntitlementInputs = z.infer<typeof EntitlementInputs>;
