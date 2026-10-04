import { z } from "zod";
import { BrainProvider, CompanionId, Id, SessionId } from "@chalito/protocol";

/**
 * Names appear in briefs outside the quoted-data blocks (persona, line prefixes), so they are
 * letters, digits, spaces and . _ ' - only (review R-L11).
 */
export const SafeName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u, "names: letters, digits, spaces and . _ ' -");

/**
 * A Mesa's stored metadata (chalito.mesas.doc, migration 001900). No goal, card or text: those
 * live sealed in the turns and with the clients, who send what a brief needs with each turn.
 */
export const Participant = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), pid: Id, name: SafeName, uid: Id }),
  z.object({
    kind: z.literal("companion"),
    pid: Id,
    name: SafeName,
    companionId: CompanionId,
  }),
  z.object({
    kind: z.literal("brain"),
    pid: Id,
    name: SafeName,
    provider: BrainProvider,
    /** "auto": the model comes from the person's efficiency profile (models.yaml), never from a client. */
    modelRef: z.literal("auto").default("auto"),
  }),
  /**
   * A live Claude Code / Codex session, by reference: its card (opened by the client) is quoted
   * as data in briefs. It never speaks and is never prompted from the Mesa; prompting it takes
   * the person's own signed command, as always.
   */
  z.object({ kind: z.literal("session"), pid: Id, name: SafeName, sid: SessionId }),
]);
export type Participant = z.infer<typeof Participant>;

export const MesaDoc = z.object({
  v: z.literal(1),
  kind: z.literal("mesa"),
  participants: z.array(Participant).min(2).max(8),
  budget: z.object({
    /** Managed tokens this Mesa may spend in total; null = no Mesa cap. */
    mesaTokens: z.number().int().positive().nullable(),
    /** Managed tokens per participant; null = no cap. */
    perParticipant: z.number().int().positive().nullable(),
  }),
  used: z.object({ total: z.number().int().nonnegative(), byParticipant: z.record(z.string(), z.number().int()) }),
  status: z.enum(["open", "budget_reached", "closed"]),
  createdAt: z.number().int(),
});
export type MesaDoc = z.infer<typeof MesaDoc>;

/** Who can be called: the companion and brains. Humans and session references never are. */
export type Speaker = Extract<Participant, { kind: "companion" | "brain" }>;
export const isSpeaker = (p: Participant): p is Speaker => p.kind === "companion" || p.kind === "brain";
