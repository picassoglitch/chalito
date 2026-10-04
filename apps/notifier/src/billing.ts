import type { PricesConfig } from "@chalito/config";
import {
  callCostMicros,
  drainOutbox,
  estimateBillable,
  smsCostMicros,
  usageEvent,
  voiceSecondsCostMicros,
  whatsappCostMicros,
  type DrainResult,
  type HubClient,
  type OutboxStore,
} from "@chalito/billing";
import type { HubUsageEvent } from "@chalito/protocol";

/**
 * Managed comms spend (ADR 0016): WhatsApp, SMS, calls and the voice on calls are Chalito's
 * own providers, so each is admitted by the hub before it goes out and reported (priced from
 * prices.yaml) through the outbox. Push and the desktop are free and never gated.
 */
export interface CommsBilling {
  admit(
    uid: string,
    channel: "whatsapp" | "sms" | "call",
    nid: string,
    country: string,
  ): Promise<{ ok: true; reservationId: string } | { ok: false; reason: string }>;
  /** After a WhatsApp/SMS send: report its cost and settle the reservation. */
  recordSend(
    uid: string,
    p: { channel: "whatsapp" | "sms"; nid: string; country: string; segments: number; reservationId: string },
  ): Promise<void>;
  /** The send failed: release the reservation. */
  release(reservationId: string): Promise<void>;
  /** Twilio call finished (status callback): PSTN minutes. */
  recordCall(
    uid: string,
    p: { callSid: string; seconds: number; country: string; reservationId?: string },
  ): Promise<void>;
  /** The Realtime voice on a call ended: voice seconds + the SIP interface minutes. */
  recordVoice(uid: string, p: { callId: string; seconds: number }): Promise<void>;
  drain(): Promise<DrainResult>;
}

export const twilioDestination = (country: string) => {
  const c = country.toUpperCase();
  return c === "MX" ? "MX_mobile" : c === "US" || c === "CA" ? "US" : `other:${c}`;
};

/** SMS segments: GSM-7 fits 160 (153 per part); anything else is UCS-2 at 70 (67 per part). */
export const smsSegments = (body: string) => {
  const gsm = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/.test(
    body,
  );
  const [single, part] = gsm ? [160, 153] : [70, 67];
  return body.length <= single ? 1 : Math.ceil(body.length / part);
};

export const hubCommsBilling = (p: {
  hub: Pick<HubClient, "admit" | "settle" | "usage">;
  outbox: OutboxStore;
  enqueue: (owner: string, events: (HubUsageEvent | null)[]) => Promise<void>;
  prices: PricesConfig;
  voiceModel: string;
  now: () => number;
  alert: (msg: string, meta: Record<string, unknown>) => void;
}): CommsBilling => {
  const ctx = (owner: string, origin: "whatsapp.message" | "sms.message" | "call.pstn" | "voice.call") => ({
    owner,
    billingMode: "managed" as const,
    origin,
  });
  const estimate = (channel: "whatsapp" | "sms" | "call", country: string) =>
    channel === "whatsapp"
      ? whatsappCostMicros(p.prices, country)
      : channel === "sms"
        ? smsCostMicros(p.prices, country, 2)
        : callCostMicros(p.prices, { seconds: 300, destination: twilioDestination(country), sip: true }) +
          voiceSecondsCostMicros(p.prices, p.voiceModel, 300);
  return {
    async admit(uid, channel, nid, country) {
      try {
        const res = await p.hub.admit({
          external_user_id: uid,
          external_job_id: `${channel}:${nid}:${p.now()}`,
          class: channel === "call" ? "stream" : "job",
          operation: channel === "call" ? "call.briefing" : `${channel}.message`,
          est_tokens: estimateBillable(estimate(channel, country)),
          ttl_seconds: channel === "call" ? 1800 : 300,
        });
        return res.allowed ? { ok: true, reservationId: res.reservation_id } : { ok: false, reason: res.reason };
      } catch {
        return { ok: false, reason: "hub_unavailable" }; // fail closed for paid channels
      }
    },
    async recordSend(uid, s) {
      const cost =
        s.channel === "whatsapp"
          ? whatsappCostMicros(p.prices, s.country)
          : smsCostMicros(p.prices, s.country, s.segments);
      await p.enqueue(uid, [
        usageEvent(ctx(uid, s.channel === "whatsapp" ? "whatsapp.message" : "sms.message"), {
          kind: s.channel === "whatsapp" ? "whatsapp.messages" : "sms.segments",
          provider: s.channel === "whatsapp" ? "meta" : "twilio",
          amount: s.channel === "whatsapp" ? 1 : s.segments,
          costUsdMicros: cost,
          occurredAt: p.now(),
          sourceId: `${s.channel}:${s.reservationId}`,
          reservationId: s.reservationId,
        }),
      ]);
      await p.hub.settle({ reservation_id: s.reservationId, outcome: "succeeded" });
    },
    async release(reservationId) {
      await p.hub.settle({ reservation_id: reservationId, outcome: "failed" }).catch(() => undefined);
    },
    async recordCall(uid, c) {
      await p.enqueue(uid, [
        usageEvent(ctx(uid, "call.pstn"), {
          kind: "call.seconds",
          provider: "twilio",
          amount: c.seconds,
          costUsdMicros: callCostMicros(p.prices, { seconds: c.seconds, destination: twilioDestination(c.country) }),
          occurredAt: p.now(),
          sourceId: `call:${c.callSid}`,
          ...(c.reservationId ? { reservationId: c.reservationId } : {}),
        }),
      ]);
      if (c.reservationId) await p.hub.settle({ reservation_id: c.reservationId, outcome: "succeeded" });
    },
    async recordVoice(uid, v) {
      const minutes = Math.ceil(v.seconds / 60);
      await p.enqueue(uid, [
        usageEvent(ctx(uid, "voice.call"), {
          kind: "voice.seconds",
          provider: "openai",
          amount: Math.round(v.seconds),
          costUsdMicros:
            voiceSecondsCostMicros(p.prices, p.voiceModel, v.seconds) +
            Math.ceil(minutes * (p.prices.twilio.perMinute.sipInterface ?? 0) * 1e6),
          occurredAt: p.now(),
          sourceId: `voice-call:${v.callId}`,
          metadata: { model: p.voiceModel },
        }),
      ]);
    },
    drain: () => drainOutbox({ store: p.outbox, hub: p.hub, now: p.now, alert: p.alert }),
  };
};
