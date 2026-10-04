import { z } from "zod";
import { AdapterKind, EpochMs, SessionId } from "./common.js";
import { SessionState } from "./agentEvent.js";

/** Hard budget for a Session/Mesa card. */
export const CARD_MAX_TOKENS = 300;

/**
 * Cheap, deterministic token estimate (≈ 4 chars/token for mixed ES/EN JSON).
 * Used for schema-level guards; M9 cross-checks against a real tokenizer.
 */
export const estimateTokens = (value: unknown): number => Math.ceil(JSON.stringify(value).length / 4);

/**
 * Session Card: a ≤300-token summary built deterministically from AgentEvents
 * (no LLM). It is what the Mesa, the companion, MCP and call briefings read instead
 * of transcripts. Stored sealed (`card.ct`) unless the user opts into MCP sharing.
 */
export const SessionCard = z
  .object({
    v: z.literal(1),
    sid: SessionId,
    cardVersion: z.number().int().nonnegative(),
    adapter: AdapterKind,
    label: z.string().max(60),
    workspaceLabel: z.string().max(60),
    state: SessionState,
    goal: z.string().max(240),
    lastAction: z.string().max(160).optional(),
    openQuestion: z.string().max(200).optional(),
    pendingApprovals: z.number().int().nonnegative(),
    filesTouched: z.number().int().nonnegative(),
    tests: z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }).optional(),
    blockers: z.array(z.string().max(120)).max(3).default([]),
    updatedAt: EpochMs,
  })
  .refine((c) => estimateTokens(c) <= CARD_MAX_TOKENS, { message: `card exceeds ${CARD_MAX_TOKENS} tokens` });
export type SessionCard = z.infer<typeof SessionCard>;
