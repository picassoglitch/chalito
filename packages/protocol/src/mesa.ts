import { z } from "zod";
import { CompanionId, Emotion, EpochMs, Id, MesaId, SessionId } from "./common.js";
import { SealedEnvelope } from "./crypto.js";
import { CARD_MAX_TOKENS, estimateTokens } from "./sessionCard.js";

export const BrainProvider = z.enum(["anthropic", "openai", "xai", "google"]);

export const ParticipantRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), uid: Id }),
  z.object({ kind: z.literal("companion"), companionId: CompanionId }),
  /** `modelRef` is a key in packages/config/models.yaml, never a raw model id from a client. */
  z.object({ kind: z.literal("brain"), pid: Id, provider: BrainProvider, modelRef: z.string().max(64) }),
  z.object({ kind: z.literal("session"), sid: SessionId }),
]);
export type ParticipantRef = z.infer<typeof ParticipantRef>;

/** Structured output every brain participant must return (validated before use). */
export const ParticipantOutput = z.object({
  say: z.string().max(2000),
  proposals: z.array(z.string().max(300)).max(5).default([]),
  objections: z.array(z.string().max(300)).max(5).default([]),
  decision_needed: z
    .object({ question: z.string().max(300), options: z.array(z.string().max(120)).min(2).max(6) })
    .optional(),
  emotion: Emotion,
});
export type ParticipantOutput = z.infer<typeof ParticipantOutput>;

/** Mesa Card: the shared ≤300-token state of a meeting. */
export const MesaCard = z
  .object({
    v: z.literal(1),
    mid: MesaId,
    goal: z.string().max(240),
    agreed: z.array(z.string().max(160)).max(6).default([]),
    open: z.array(z.string().max(160)).max(6).default([]),
    nextSpeaker: z.array(Id).max(4).default([]),
  })
  .refine((c) => estimateTokens(c) <= CARD_MAX_TOKENS, { message: "mesa card too large" });
export type MesaCard = z.infer<typeof MesaCard>;

/** `users/{uid}/mesas/{mid}/turns/{tid}` */
export const MesaTurn = z.object({
  v: z.literal(1),
  mid: MesaId,
  tid: Id,
  speaker: ParticipantRef,
  /** Only addressed participants are called (token efficiency). Empty = moderator decides. */
  addressed: z.array(ParticipantRef).max(8),
  outCt: SealedEnvelope,
  usage: z.object({
    in: z.number().int().nonnegative(),
    out: z.number().int().nonnegative(),
    cached: z.number().int().nonnegative(),
  }),
  emotion: Emotion,
  t: EpochMs,
});
export type MesaTurn = z.infer<typeof MesaTurn>;
