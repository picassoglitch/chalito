import { z } from "zod";

/**
 * Escalation defaults (brief §5 M6, ADR 0011). Kept here so the engine stays pure and
 * self-contained; the notifier may load overrides (e.g. from packages/config) and pass them in.
 */
export const EscalationConfig = z.object({
  /** Per user per local day. */
  caps: z.object({
    call: z.number().int().nonnegative(),
    whatsapp: z.number().int().nonnegative(),
    sms: z.number().int().nonnegative(),
  }),
  /** "HH:MM" in the user's tz; the window may cross midnight. */
  quietHoursDefault: z.object({ start: z.string(), end: z.string() }),
  /** While the desktop is active, phone channels wait this long after the ladder starts. */
  presenceHoldMs: z.number().int().nonnegative(),
  /** Tool approvals expire 10 minutes after they're requested. */
  approvalTtlMs: z.number().int().positive(),
  /** DTMF 2 (snooze) re-calls this much later, or this long before a Mesa starts. */
  snoozeMs: z.number().int().positive(),
  mesaRecallLeadMs: z.number().int().nonnegative(),
});
export type EscalationConfig = z.infer<typeof EscalationConfig>;

export const DEFAULT_ESCALATION: EscalationConfig = {
  caps: { call: 3, whatsapp: 10, sms: 3 },
  quietHoursDefault: { start: "23:00", end: "07:00" },
  presenceHoldMs: 2 * 60_000,
  approvalTtlMs: 10 * 60_000,
  snoozeMs: 10 * 60_000,
  mesaRecallLeadMs: 60_000,
};
