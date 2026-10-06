import { z } from "zod";
import { AccessorySlot, EfficiencyProfile, SkinEffect, EphemeralTtl, RenderQuality } from "@chalito/protocol";

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

const CosmeticName = z.object({ es: z.string().min(1), en: z.string().min(1) });
/** Price in billable tokens, paid from the hub balance (D-030). Required when not free. */
const PriceTokens = z.number().int().positive().optional();
const priced = <T extends { free: boolean; priceTokens?: number }>(s: z.ZodType<T>) =>
  s
    .refine((c) => c.free || c.priceTokens !== undefined, "paid cosmetics need priceTokens")
    .refine((c) => !(c.free && c.priceTokens !== undefined), "free cosmetics have no price");

/** A drawn item placed on the card (hat, glasses, cape, aura, portal). */
export const AccessoryItem = z.object({
  name: CosmeticName,
  slot: AccessorySlot,
  free: z.boolean(),
  priceTokens: PriceTokens,
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
});
export type AccessoryItem = z.infer<typeof AccessoryItem>;

/**
 * A skin: a material effect over the whole companion, drawn by the card renderer's shader
 * (@chalito/avatar-three `setSkin`). No art, no placement, so it fits every roster character.
 */
export const SkinItem = z.object({
  name: CosmeticName,
  slot: z.literal("skin"),
  free: z.boolean(),
  priceTokens: PriceTokens,
  skin: SkinEffect,
});
export type SkinItem = z.infer<typeof SkinItem>;

export const CosmeticItem = priced(z.discriminatedUnion("slot", [AccessoryItem, SkinItem]));
export type CosmeticItem = z.infer<typeof CosmeticItem>;

export const isSkinItem = (c: CosmeticItem): c is SkinItem => c.slot === "skin";

export const CatalogConfig = z
  .object({
    schemaVersion: z.literal(1),
    cosmetics: z.record(z.string().regex(/^[a-z0-9_]+$/), CosmeticItem),
    drops: z.record(z.string(), z.unknown()),
  })
  .refine(
    (c) => {
      const effects = Object.values(c.cosmetics).flatMap((x) => (x.slot === "skin" ? [x.skin] : []));
      return new Set(effects).size === effects.length;
    },
    { message: "each skin effect is sold once", path: ["cosmetics"] },
  );
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
