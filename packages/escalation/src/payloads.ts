import { OutboundTemplateVars, type Counts, type Locale } from "@chalito/protocol";
import type { EscalationItem, PushPayload } from "./types.js";
import type { Level } from "@chalito/protocol";

export const totalOf = (c: Counts) => c.approvals + c.questions + c.messages + c.mesas;

/**
 * The only WhatsApp/SMS variables there are: integers and enums, parsed through the strict
 * protocol schema. Free text has no way in.
 */
export const buildTemplateVars = (item: EscalationItem, locale: Locale): OutboundTemplateVars =>
  OutboundTemplateVars.parse({
    template: "chalito_pendientes_v1",
    locale,
    total: Math.min(999, totalOf(item.counts)),
    source: item.source,
    urgency: item.urgency,
    linkId: item.nid,
  });

/** Push and desktop payloads: metadata only, built field by field (no spreading of inputs). */
export const buildPushPayload = (item: EscalationItem, level: Level, notice?: PushPayload["notice"]): PushPayload => ({
  nid: item.nid,
  level,
  source: item.source,
  urgency: item.urgency,
  counts: {
    approvals: item.counts.approvals,
    questions: item.counts.questions,
    messages: item.counts.messages,
    mesas: item.counts.mesas,
  },
  total: totalOf(item.counts),
  deepLink: item.deepLink,
  ...(notice ? { notice } : {}),
});
