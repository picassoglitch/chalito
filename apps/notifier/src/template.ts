import { readFileSync } from "node:fs";
import { NotificationSource, OutboundTemplateVars, Urgency, type Locale } from "@chalito/protocol";
import { z } from "zod";

const labels = (keys: z.ZodEnum) => z.record(z.enum(["es", "en"]), z.record(keys, z.string().min(1)));
const TemplateFile = z.object({
  name: z.string(),
  languages: z.record(z.string(), z.object({ body: z.string(), buttons: z.array(z.unknown()) })),
  sms: z.object({ es: z.string(), en: z.string() }),
  labels: z.object({ source: labels(NotificationSource), urgency: labels(Urgency) }),
  quickReplyPayload: z.string(),
});

/** templates/chalito_pendientes_v1.json, validated: every enum value has a fixed label. */
export const TEMPLATE = TemplateFile.parse(
  JSON.parse(readFileSync(new URL("../templates/chalito_pendientes_v1.json", import.meta.url), "utf8")),
);

/** The three body values, all derived from integers and enums. */
export const templateValues = (vars: OutboundTemplateVars) => {
  const v = OutboundTemplateVars.parse(vars);
  return {
    total: String(v.total),
    source: TEMPLATE.labels.source[v.locale]![v.source]!,
    urgency: TEMPLATE.labels.urgency[v.locale]![v.urgency]!,
    linkId: v.linkId,
  };
};

/** The SMS text: the same fixed sentence as the WhatsApp template, plus the app link. */
export const smsBody = (vars: OutboundTemplateVars, appUrl: string) => {
  const t = templateValues(vars);
  return TEMPLATE.sms[vars.locale as Locale]
    .replace("{total}", t.total)
    .replace("{source}", t.source)
    .replace("{urgency}", t.urgency)
    .replace("{link}", `${appUrl.replace(/\/$/, "")}/n/${t.linkId}`);
};
