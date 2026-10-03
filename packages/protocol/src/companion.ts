import { z } from "zod";
import { CompanionId, Emotion, Id } from "./common.js";

export const CosmeticSlot = z.enum(["head", "face", "body", "back", "aura", "portal_fx"]);
export type CosmeticSlot = z.infer<typeof CosmeticSlot>;

export const RenderQuality = z.enum(["auto", "bajo", "medio", "alto"]);

export const Gesture = z.enum(["wave", "nod", "think", "shrug", "celebrate", "yawn", "talk", "none"]);

/** `users/{uid}/companions/{cid}` */
export const Companion = z.object({
  v: z.literal(1),
  companionId: CompanionId,
  name: z.string().min(1).max(40),
  isRenamed: z.boolean(),
  persona: z.string().max(64),
  voice: z.object({ provider: z.enum(["openai"]), id: z.string().max(64) }),
  assetId: Id,
  equipped: z.partialRecord(CosmeticSlot, Id),
  style: z.string().max(64).optional(),
  renderQuality: RenderQuality.default("auto"),
});
export type Companion = z.infer<typeof Companion>;

/**
 * Every companion reply. `emotion` is mandatory: replies without it are rejected,
 * so expressions never need a second LLM call.
 */
export const CompanionReply = z.object({
  v: z.literal(1),
  say: z.string().min(1).max(1200),
  emotion: Emotion,
  gesture: Gesture.default("none"),
  /** Inline chips such as "¿Por qué?" → /creditos. Never a modal. */
  chips: z.array(z.object({ label: z.string().max(30), href: z.string().max(64) })).max(3).default([]),
});
export type CompanionReply = z.infer<typeof CompanionReply>;
