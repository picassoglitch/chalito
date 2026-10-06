import { z } from "zod";
import { CosmeticSlot, EfficiencyProfile, EphemeralTtl, RenderQuality } from "@chalito/protocol";

const Provider = z.enum(["anthropic", "openai", "xai", "google"]);
const ModelRef = z.object({ provider: Provider, model: z.string().min(1) });

export const ModelsConfig = z.object({
  schemaVersion: z.literal(1),
  vertex: z.object({ location: z.literal("global") }),
  roles: z.record(z.enum(["router", "moderator", "summarizer"]), ModelRef.extend({ fallback: ModelRef })),
  profiles: z.record(
    EfficiencyProfile,
    z.object({ companion: ModelRef.optional(), mesa: z.partialRecord(Provider, z.string()).optional() }),
  ),
  voice: z.object({ desktop: ModelRef, call: ModelRef }),
  images: z.object({ avatar: ModelRef }),
});
export type ModelsConfig = z.infer<typeof ModelsConfig>;

const usd = z.number().nonnegative();
const TokenPrice = z.object({
  input: usd,
  output: usd,
  cacheRead: usd.optional(),
  cacheWrite: usd.optional(),
  cacheWrite5m: usd.optional(),
  cacheWrite1h: usd.optional(),
});

export const PricesConfig = z.object({
  schemaVersion: z.literal(1),
  llm: z.record(Provider, z.record(z.string(), TokenPrice)),
  realtime: z.record(z.string(), z.record(z.string(), usd)),
  twilio: z.object({
    numberMonthly: z.record(z.string(), usd),
    perMinute: z.record(z.string(), usd),
    gatherSpeech: usd,
    tts: z.record(z.string(), usd),
    verify: z.record(z.string(), usd),
    smsSegment: z.record(z.string(), usd),
  }),
  whatsapp: z.object({ utility: z.record(z.string(), usd) }),
  compute: z.object({ cloudRunMicrosPerSecond: z.object({ standard: usd, boost: usd }) }),
  /** Per generated image (USD), by provider and model. */
  images: z.record(z.string(), z.record(z.string(), z.object({ perImage: usd }))),
});
export type PricesConfig = z.infer<typeof PricesConfig>;

export const ProvidersConfig = z.object({
  schemaVersion: z.literal(1),
  providers: z.record(
    Provider,
    z.object({
      byoApiKey: z.boolean(),
      subscriptionLocal: z.enum(["off", "owner_only", "approved", "on"]),
      mcpConnector: z.enum(["claude", "chatgpt", "none"]),
      managed: z.boolean(),
    }),
  ),
  codingAgents: z.record(
    z.enum(["claude-code", "codex", "grok-build"]),
    z.object({ provider: Provider, auth: z.array(z.enum(["api_key", "chatgpt_plan", "grok_login"])).min(1) }),
  ),
});
export type ProvidersConfig = z.infer<typeof ProvidersConfig>;

export const RoomsConfig = z
  .object({
    schemaVersion: z.literal(1),
    defaults: z.object({ ephemeralTtl: EphemeralTtl, keepPromoted: z.boolean() }),
    allowedEphemeralTtl: z.array(EphemeralTtl).min(1),
    invites: z.object({ ttl: z.string().regex(/^P(T\d+H|\d+D)$/), maxUses: z.number().int().positive() }),
    shareUrgencyDefault: z.boolean(),
    scheduleTarget: z.enum(["internal_ics", "google_calendar"]),
  })
  .refine((r) => r.allowedEphemeralTtl.includes(r.defaults.ephemeralTtl), "default TTL must be an allowed value");
export type RoomsConfig = z.infer<typeof RoomsConfig>;

const Level = z.object({
  fpsCap: z.number().int().positive(),
  shadows: z.boolean(),
  impostors: z.boolean(),
  pixelRatioMax: z.number().positive(),
});
export const RenderConfig = z.object({
  schemaVersion: z.literal(1),
  default: RenderQuality,
  levels: z.object({ bajo: Level, medio: Level, alto: Level }),
  auto: z.object({ probeSeconds: z.number().positive(), downgradeBelowFps: z.number().positive() }),
});
export type RenderConfig = z.infer<typeof RenderConfig>;

export const CatalogConfig = z.object({
  schemaVersion: z.literal(1),
  cosmetics: z.record(
    z.string().regex(/^[a-z0-9_]+$/),
    z
      .object({
        name: z.object({ es: z.string().min(1), en: z.string().min(1) }),
        slot: CosmeticSlot,
        free: z.boolean(),
        /** Price in billable tokens, paid from the hub balance (D-030). Required when not free. */
        priceTokens: z.number().int().positive().optional(),
        /** Art inside @chalito/roster (cosmetics/<id>.webp). */
        art: z.string().regex(/^cosmetics\/[a-z0-9_]+\.webp$/),
        /** On a 2.5D card: width as a fraction of the card, and the item's own pivot (0..1). */
        card: z.object({
          width: z.number().positive().max(2),
          pivot: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
        }),
        /** On a VRM: offset from the slot's bone, in metres. */
        vrm: z.object({ offset: z.tuple([z.number(), z.number(), z.number()]) }),
        provenance: z.string().min(1),
      })
      .refine((c) => c.free || c.priceTokens !== undefined, "paid cosmetics need priceTokens")
      .refine((c) => !(c.free && c.priceTokens !== undefined), "free cosmetics have no price"),
  ),
  drops: z.record(z.string(), z.unknown()),
});
export type CatalogConfig = z.infer<typeof CatalogConfig>;

/** escalation.yaml: the escalation engine's limits and the notifier's channel settings. */
export const EscalationConfig = z.object({
  schemaVersion: z.literal(1),
  caps: z.object({
    call: z.number().int().nonnegative(),
    whatsapp: z.number().int().nonnegative(),
    sms: z.number().int().nonnegative(),
  }),
  quietHoursDefault: z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }),
  presenceHoldMs: z.number().int().nonnegative(),
  approvalTtlMs: z.number().int().positive(),
  snoozeMs: z.number().int().positive(),
  mesaRecallLeadMs: z.number().int().nonnegative(),
  sms: z.object({ defaultOffCountries: z.array(z.string().regex(/^[A-Z]{2}$/)) }),
  voices: z.object({ es: z.string().min(1), en: z.string().min(1) }),
  whatsapp: z.object({
    graphVersion: z.string().regex(/^v\d+\.\d+$/),
    template: z.string().min(1),
    languages: z.object({ es: z.string(), en: z.string() }),
  }),
});
export type EscalationConfig = z.infer<typeof EscalationConfig>;

/** copy/recharge.{es,en}.yaml: the companion's in-character out-of-energy lines. */
export const RechargeCopy = z.object({
  schemaVersion: z.literal(1),
  chip: z.string().min(1).max(20),
  lines: z.array(z.string().min(1).max(200)).min(3),
});
export type RechargeCopy = z.infer<typeof RechargeCopy>;
