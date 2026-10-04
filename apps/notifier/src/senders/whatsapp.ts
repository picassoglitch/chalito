import type { EscalationConfig } from "@chalito/config";
import type { OutboundTemplateVars } from "@chalito/protocol";
import { TEMPLATE, templateValues } from "../template.js";

export interface WhatsAppSender {
  sendTemplate(toE164: string, vars: OutboundTemplateVars): Promise<{ id: string | null }>;
}

/**
 * WhatsApp Cloud API template send (Graph v26.0, ADR 0011). Body values and the button suffix
 * come only from OutboundTemplateVars; the quick reply carries a fixed opt-out payload.
 */
export const whatsappSender = (opts: {
  token: string;
  phoneNumberId: string;
  config: EscalationConfig;
  fetch?: typeof fetch;
}): WhatsAppSender => ({
  async sendTemplate(toE164, vars) {
    const v = templateValues(vars);
    const res = await (opts.fetch ?? fetch)(
      `https://graph.facebook.com/${opts.config.whatsapp.graphVersion}/${opts.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: toE164,
          type: "template",
          template: {
            name: opts.config.whatsapp.template,
            language: { code: opts.config.whatsapp.languages[vars.locale] },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: v.total },
                  { type: "text", text: v.source },
                  { type: "text", text: v.urgency },
                ],
              },
              { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: v.linkId }] },
              {
                type: "button",
                sub_type: "quick_reply",
                index: "1",
                parameters: [{ type: "payload", payload: TEMPLATE.quickReplyPayload }],
              },
            ],
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`whatsapp send failed: ${res.status}`);
    const json = (await res.json()) as { messages?: { id?: string }[] };
    return { id: json.messages?.[0]?.id ?? null };
  },
});
