import { randomUUID } from "node:crypto";
import { HubUsageEvent, type HubUsageKind } from "@chalito/protocol";
import type { z } from "zod";

/**
 * Who pays for a unit of work (ADR 0013/0016). Only `managed` work done by Chalito's own brains
 * and channels reaches the hub. BYO usage (the user's own keys, subscriptions or MCP connector)
 * and the user's Claude Code / Codex sessions are never billable: they don't produce events.
 */
export type BillingMode = "managed" | "byo_api_key" | "byo_subscription_local" | "byo_mcp_connector";

export type UsageOrigin =
  | "companion.turn"
  | "mesa.turn"
  | "voice.desktop"
  | "voice.call"
  | "call.pstn"
  | "whatsapp.message"
  | "sms.message"
  | "avatar.job"
  | "store.purchase"
  /** The user's coding agents, driven on their own machine and account. */
  | "session.claude-code"
  | "session.codex";

export interface UsageContext {
  owner: string;
  billingMode: BillingMode;
  origin: UsageOrigin;
}

export const isBillable = (ctx: UsageContext): boolean =>
  ctx.billingMode === "managed" && !ctx.origin.startsWith("session.");

export interface UsageInput {
  kind: z.infer<typeof HubUsageKind>;
  provider: string;
  amount: number;
  costUsdMicros: number;
  occurredAt: number;
  /** Idempotency key; generated when omitted. Reuse it for retries of the same unit of work. */
  sourceId?: string;
  reservationId?: string;
  metadata?: HubUsageEvent["metadata"];
}

/** The hub event for a unit of work, or null when it isn't billable (it is then never sent). */
export const usageEvent = (ctx: UsageContext, u: UsageInput): HubUsageEvent | null => {
  if (!isBillable(ctx)) return null;
  return HubUsageEvent.parse({
    source_id: u.sourceId ?? `${ctx.origin}:${randomUUID()}`,
    kind: u.kind,
    provider: u.provider,
    external_user_id: ctx.owner,
    amount: Math.max(0, Math.round(u.amount)),
    cost_usd_micros: Math.max(0, Math.ceil(u.costUsdMicros)),
    occurred_at: new Date(u.occurredAt).toISOString(),
    ...(u.reservationId ? { reservation_id: u.reservationId } : {}),
    metadata: {
      purpose: ctx.origin.startsWith("companion") || ctx.origin.startsWith("mesa") ? "work" : "comms",
      ...u.metadata,
    },
  });
};
