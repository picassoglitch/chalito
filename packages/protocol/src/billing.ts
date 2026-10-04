import { z } from "zod";
import { EfficiencyProfile, EpochMs, Uid } from "./common.js";
import { HubTierId, TierId } from "./plans.js";

/**
 * Chalito is a Chalyb engine (ADR 0016). The hub owns payments (Mercado Pago),
 * the trial, the billable-token balance and the ledger. Chalito keeps no payment
 * records of its own. These schemas mirror the hub's engine contract
 * (Chalyb docs/engines/consumption-contract.md + src/lib/engines/integrations/factory.ts,
 * read 2026-10-03 at 4ed57c9). If the hub contract changes, these change with it.
 */

// ---- SSO + provisioning (hub → Chalito) -------------------------------------

/** Payload of the hub's launch token: base64url(JSON) + "." + HMAC-SHA256(base64url). TTL 300 s. */
export const HubSsoPayload = z.object({
  user_id: z.string().min(1),
  email: z.string().email(),
  tenant_id: z.string().min(1),
  tier: z.string().min(1),
  exp: z.number().int().positive(),
});
export type HubSsoPayload = z.infer<typeof HubSsoPayload>;

/** `POST {admin_api_base}/tenants` (Bearer CHALITO_ADMIN_TOKEN). A 409 duplicate is success. */
export const HubTenantCreate = z.object({
  external_user_id: z.string().min(1),
  email: z.string().email(),
  display_name: z.string().max(200).nullable().optional(),
  tier: z.string().min(1),
});
export const HubTenantCreated = z.object({ tenant_id: z.string().min(1), api_token: z.string().min(1) });
export const HubTenantStatus = z.object({ status: z.enum(["active", "paused"]) });

// ---- Consumption (Chalito → hub) ----------------------------------------------

// Field rules mirror the hub's parseAdmitBody (chalyb a5733df src/lib/usage/admission-core.ts).
export const HubAdmitRequest = z.object({
  external_user_id: z.string().min(1),
  /** Re-admitting the same id returns (and updates) the same reservation. */
  external_job_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  class: z.enum(["job", "stream"]),
  /** e.g. `companion.turn`, `mesa.turn`, `voice.session`, `call.briefing`, `room.notify`. */
  operation: z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/),
  est_tokens: z.number().int().nonnegative().max(1e11),
  upload_mb: z.number().nonnegative().max(1e7).default(0),
  source_minutes: z.number().nonnegative().max(1e6).default(0),
  storage_mb_after: z.number().nonnegative().max(1e9).nullable().optional(),
  boost: z.boolean().nullable().default(null),
  /** Hub default 3 h; 60 s to 24 h. */
  ttl_seconds: z.number().int().min(60).max(86_400).optional(),
});
export type HubAdmitRequest = z.infer<typeof HubAdmitRequest>;

export const HubRefusalReason = z.enum([
  "upload_too_large",
  "video_too_long",
  "storage_full",
  "minutes_cap",
  "jobs_cap",
  "concurrency",
  "streams_cap",
  "no_tokens",
  "boost_unavailable",
  "already_settled",
]);

/**
 * The hub's TokenBalance (chalyb src/lib/usage/tokens.ts). `unlimited` users (hub admins) skip
 * out-of-tokens checks but are still metered; their `remaining` is MAX_SAFE_INTEGER. `reserved`
 * is new on the consumption-caps branch, so it defaults to 0 for hubs without it.
 */
export const HubBalance = z.object({
  remaining: z.number(),
  unlimited: z.boolean(),
  monthlyAllocation: z.number(),
  bonus: z.number(),
  monthlyUsed: z.number(),
  reserved: z.number().default(0),
  periodStart: z.string(),
});
export type HubBalance = z.infer<typeof HubBalance>;

/** GET /usage/balance → {ok: true, balance}; 404 {error: "unknown user_id"}. */
export const HubBalanceResponse = z.object({ ok: z.literal(true), balance: HubBalance });

export const HubAdmitResponse = z.discriminatedUnion("allowed", [
  z.object({
    ok: z.literal(true),
    allowed: z.literal(true),
    reservation_id: z.string().uuid(),
    lane: z.enum(["standard", "boost"]),
    boost_fee_tokens: z.number().int().nonnegative(),
    limits: z.record(z.string(), z.unknown()),
    balance: HubBalance,
  }),
  z.object({
    ok: z.literal(true),
    allowed: z.literal(false),
    reason: HubRefusalReason,
    detail: z.record(z.string(), z.unknown()).optional(),
    limits: z.record(z.string(), z.unknown()).optional(),
  }),
]);
export type HubAdmitResponse = z.infer<typeof HubAdmitResponse>;

/** Meter kinds Chalito sends. The hub adds `transcription.seconds` etc. for other engines. */
export const HubUsageKind = z.enum([
  "llm.tokens",
  "voice.seconds",
  "call.seconds",
  "whatsapp.messages",
  "sms.segments",
  "compute.seconds",
  "storage.gb_month",
  "store.purchase",
]);

export const HubUsageEvent = z
  .object({
    /** Idempotency: (engine, source_id) is unique on the hub. Written to a local outbox first. */
    source_id: z.string().min(1).max(200),
    kind: HubUsageKind,
    provider: z.string().min(1).max(40),
    external_user_id: z.string().min(1),
    amount: z.number().int().min(0).max(1e12),
    /** Exact provider cost from prices.yaml, incl. cache reads/writes, retries and failed attempts. */
    cost_usd_micros: z.number().int().min(0).max(1e9),
    occurred_at: z.string().datetime({ offset: true }),
    reservation_id: z.string().uuid().optional(),
    metadata: z
      .object({
        tokens: z
          .object({
            input: z.number().int().nonnegative(),
            output: z.number().int().nonnegative(),
            cache_read: z.number().int().nonnegative(),
            cache_write: z.number().int().nonnegative(),
          })
          .optional(),
        model: z.string().max(80).optional(),
        purpose: z.enum(["comms", "work"]).optional(),
      })
      .passthrough()
      .optional(),
  })
  .refine(
    (e) =>
      e.kind !== "llm.tokens" ||
      !e.metadata?.tokens ||
      e.metadata.tokens.input +
        e.metadata.tokens.output +
        e.metadata.tokens.cache_read +
        e.metadata.tokens.cache_write ===
        e.amount,
    { message: "llm.tokens amount must equal the sum of the token split" },
  );
export type HubUsageEvent = z.infer<typeof HubUsageEvent>;

/**
 * POST /usage: ONE user per request, at the top level, at most 100 events (chalyb
 * `src/app/api/engines/[slug]/usage/route.ts`, `body.external_user_id`; the same on main 3f27ef3
 * and a5733df). Events keep their own external_user_id for our outbox; it must match.
 */
export const HubUsageBatch = z
  .object({ external_user_id: z.string().min(1), events: z.array(HubUsageEvent).min(1).max(100) })
  .refine((b) => b.events.every((e) => e.external_user_id === b.external_user_id), {
    message: "every event in a usage batch belongs to the batch's external_user_id",
  });

export const HubSettle = z.object({
  reservation_id: z.string().uuid(),
  outcome: z.enum(["succeeded", "failed", "cancelled", "heartbeat"]),
});

// ---- Entitlements (computed in Chalito from hub state) -----------------------

export const ManagedAllowance = z.discriminatedUnion("status", [
  /** The hub balance can pay for managed brains. */
  z.object({ status: z.literal("enabled"), remainingBillable: z.number().nonnegative() }),
  /** Owner hasn't set the value (`mirror_matching_tier` / unset): fail closed, UI shows "Disponible pronto". */
  z.object({ status: z.literal("disabled_unset") }),
  /** Balance is 0 or no paid access: deterministic free_min + in-character recharge line. */
  z.object({ status: z.literal("free_min") }),
]);

export const Limit = z.union([z.number().int().nonnegative(), z.literal("unset")]);

/**
 * Entitlements = f(hub tier or Solo tier, hub trial, hub balance). Inventory and
 * cosmetics are deliberately NOT an input (pay-to-dress, never pay-to-win).
 */
export const Entitlements = z.object({
  v: z.literal(2),
  uid: Uid,
  source: z.enum(["hub_tier", "solo", "trial", "comped", "none"]),
  hubTier: HubTierId.nullable(),
  /** The ladder tier whose access applies (a hub tier maps to one via plans.yaml `hubTiers`). */
  accessTier: TierId.nullable(),
  efficiencyDefault: EfficiencyProfile,
  efficiencyCurrent: EfficiencyProfile,
  maxProfile: EfficiencyProfile,
  managedAllowance: ManagedAllowance,
  limits: z.object({
    devices: Limit,
    concurrentSessions: Limit,
    voiceMinutes: Limit,
    calls: Limit,
    whatsapp: Limit,
    sms: Limit,
    rooms: Limit,
    membersPerRoom: Limit,
    mesaBrains: Limit,
  }),
  features: z.object({ mcpGateway: z.boolean() }),
  /** Always true regardless of plan state: sign-in, approvals, revocation, Developer-mode off, export. */
  safetyFeatures: z.literal(true),
  computedAt: EpochMs,
});
export type Entitlements = z.infer<typeof Entitlements>;

/** Inputs allowed into the entitlements function: the type has no inventory field on purpose. */
export const EntitlementInputs = z
  .object({
    uid: Uid,
    hubTier: HubTierId.nullable(),
    soloTier: TierId.nullable(),
    hubTrialActive: z.boolean(),
    hubBalanceRemaining: z.number().nonnegative(),
    /** The hub's `unlimited` (hub admins): never out of tokens, still metered. */
    hubUnlimited: z.boolean().default(false),
    comped: z.boolean(),
    chosenEfficiency: EfficiencyProfile.optional(),
    now: EpochMs,
  })
  .strict();
export type EntitlementInputs = z.infer<typeof EntitlementInputs>;
