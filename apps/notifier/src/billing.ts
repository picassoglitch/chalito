import { createHash } from "node:crypto";
import type { PricesConfig } from "@chalito/config";
import {
  callCostMicros,
  drainOutbox,
  reserveTokens,
  smsCostMicros,
  usageEvent,
  voiceSecondsCostMicros,
  whatsappCostMicros,
  type DrainResult,
  type HubClient,
  type OutboxStore,
  type ReserveBasis,
  sweepVoiceSessions,
  type VoiceEventFor,
  type VoiceSession,
  type VoiceSessionStore,
} from "@chalito/billing";
import type { HubUsageEvent } from "@chalito/protocol";

/**
 * Managed comms spend (ADR 0016): WhatsApp, SMS, calls and the voice on calls are Chalito's
 * own providers, so each is admitted by the hub before it goes out and reported (priced from
 * prices.yaml) through the outbox. Push and the desktop are free and never gated.
 */
export interface CommsBilling {
  /**
   * `sendKey` identifies the send (the ladder rung): re-admitting the same send, e.g. on a Cloud
   * Tasks retry, gets the same reservation, so recordSend's source_id is the same too (R-L9).
   */
  admit(
    uid: string,
    channel: "whatsapp" | "sms" | "call",
    nid: string,
    country: string,
    sendKey?: string,
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
  /**
   * Before a call's voice starts: admit it on the hub (fail closed) and open a server-side session
   * bounded by `maxSeconds` (Twilio's timeLimit). Without a session store, nothing is metered here.
   */
  openCallVoice(
    uid: string,
    p: { callSid: string; maxSeconds: number },
  ): Promise<{ ok: true; sourceId: string } | { ok: false; reason: string }>;
  /** The call's voice ended: bill the elapsed seconds (voice + SIP interface minutes) and settle. */
  closeCallVoice(uid: string, sourceId: string): Promise<void>;
  /** OpenAI accepted the call: remember its call id so the call can be hung up server-side. */
  connectedCallVoice(uid: string, sourceId: string, callId: string): Promise<void>;
  /** Open phone-call voice sessions (all owners, or one). */
  openCallVoices(uid?: string): Promise<VoiceSession[]>;
  /**
   * Ends a phone call's voice now: hangs up the Twilio call and the OpenAI call. Billing follows
   * when the call agent's socket closes (closeCallVoice), or the sweep if that instance is gone.
   */
  hangUpCallVoice(s: VoiceSession): Promise<void>;
  /** Bills desktop voice sessions that were never ended (R-H6), then drains the outbox. */
  drain(): Promise<DrainResult & { voiceSessionsSwept?: number }>;
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
  /** What est_tokens means at this hub (HUB_RESERVE_BASIS). */
  reserveBasis: ReserveBasis;
  now: () => number;
  alert: (msg: string, meta: Record<string, unknown>) => void;
  /** Server-side voice sessions (migration 003010): call voice here, desktop voice in apps/api. */
  voiceSessions?: VoiceSessionStore;
  /** Prices a desktop session's increment, for the sweep (apps/api's HubStreamUsage.event). */
  desktopVoiceEvent?: VoiceEventFor;
  /** Hangs up an OpenAI Realtime call by id (desktop WebRTC via apps/api, or a phone call's SIP leg). */
  hangupCall?: (callId: string) => Promise<unknown>;
  /** Hangs up a Twilio call by CallSid (Status=completed). */
  endPhoneCall?: (callSid: string) => Promise<unknown>;
}): CommsBilling => {
  /** Best effort, each leg on its own: a phone call's Twilio call and any OpenAI call. */
  const hangUp = async (s: VoiceSession) => {
    const legs: Promise<unknown>[] = [];
    if (s.channel === "call" && p.endPhoneCall) legs.push(p.endPhoneCall(s.deviceId));
    if (s.callId && p.hangupCall) legs.push(p.hangupCall(s.callId));
    await Promise.allSettled(legs);
  };
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
  /** Voice on a call: OpenAI voice seconds plus Twilio's SIP interface minutes. */
  const callVoiceCost = (seconds: number) =>
    voiceSecondsCostMicros(p.prices, p.voiceModel, seconds) +
    Math.ceil(Math.ceil(seconds / 60) * (p.prices.twilio.perMinute.sipInterface ?? 0) * 1e6);
  const callVoiceEvent: VoiceEventFor = (s, seconds, total) =>
    usageEvent(ctx(s.owner, "voice.call"), {
      kind: "voice.seconds",
      provider: "openai",
      amount: seconds,
      costUsdMicros: callVoiceCost(seconds),
      occurredAt: p.now(),
      sourceId: `${s.sourceId}:${total}`,
      reservationId: s.reservationId,
      metadata: { model: s.model },
    });
  return {
    async admit(uid, channel, nid, country, sendKey) {
      try {
        const res = await p.hub.admit({
          external_user_id: uid,
          external_job_id: `${channel}:${nid}:${sendKey ?? "0"}`.slice(0, 128),
          class: channel === "call" ? "stream" : "job",
          operation: channel === "call" ? "call.briefing" : `${channel}.message`,
          est_tokens: reserveTokens(estimate(channel, country), p.reserveBasis),
          ttl_seconds: channel === "call" ? 1800 : 300,
        });
        if (!res.allowed) return { ok: false, reason: res.reason };
        // An admit is not a balance check: refuse an empty balance too (R-L9).
        if (!res.balance.unlimited && res.balance.remaining <= 0) {
          await p.hub.settle({ reservation_id: res.reservation_id, outcome: "cancelled" }).catch(() => undefined);
          return { ok: false, reason: "no_tokens" };
        }
        return { ok: true, reservationId: res.reservation_id };
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
      // The send happened and its usage is queued: a failed settle must not fail (and retry) the send.
      await p.hub
        .settle({ reservation_id: s.reservationId, outcome: "succeeded" })
        .catch((err: unknown) =>
          p.alert("billing.settle_failed", { reservationId: s.reservationId, error: String(err).slice(0, 200) }),
        );
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
    async openCallVoice(uid, c) {
      if (!p.voiceSessions) return { ok: true, sourceId: "" };
      const sourceId = `voice_${createHash("sha256").update(c.callSid).digest("hex").slice(0, 32)}`;
      let res;
      try {
        res = await p.hub.admit({
          external_user_id: uid,
          external_job_id: sourceId,
          class: "stream",
          operation: "voice.call",
          est_tokens: reserveTokens(callVoiceCost(c.maxSeconds), p.reserveBasis),
          ttl_seconds: Math.min(86_400, Math.max(60, c.maxSeconds + 300)),
        });
      } catch {
        return { ok: false, reason: "hub_unavailable" };
      }
      if (!res.allowed) return { ok: false, reason: res.reason };
      if (!res.balance.unlimited && res.balance.remaining <= 0) {
        await p.hub.settle({ reservation_id: res.reservation_id, outcome: "cancelled" }).catch(() => undefined);
        return { ok: false, reason: "no_tokens" };
      }
      const opened = await p.voiceSessions.open({
        sourceId,
        owner: uid,
        channel: "call",
        deviceId: c.callSid,
        reservationId: res.reservation_id,
        model: p.voiceModel,
        startedAt: p.now(),
        maxSeconds: c.maxSeconds,
      });
      if (opened === "busy") {
        await p.hub.settle({ reservation_id: res.reservation_id, outcome: "cancelled" }).catch(() => undefined);
        return { ok: false, reason: "call_voice_open" };
      }
      return { ok: true, sourceId };
    },
    async closeCallVoice(uid, sourceId) {
      if (!p.voiceSessions || !sourceId) return;
      const r = await p.voiceSessions.advance({ owner: uid, sourceId, now: p.now(), end: true, event: callVoiceEvent });
      if (r.reservationId)
        await p.hub.settle({ reservation_id: r.reservationId, outcome: "succeeded" }).catch(() => undefined);
    },
    async connectedCallVoice(uid, sourceId, callId) {
      if (p.voiceSessions && sourceId) await p.voiceSessions.setCallId(uid, sourceId, callId);
    },
    openCallVoices: async (uid) => (p.voiceSessions ? p.voiceSessions.openOn("call", uid) : []),
    hangUpCallVoice: (s) => hangUp(s),
    drain: async () => {
      const voiceSessionsSwept = p.voiceSessions
        ? await sweepVoiceSessions({
            store: p.voiceSessions,
            now: p.now(),
            event: (s, seconds, total) =>
              s.channel === "call"
                ? callVoiceEvent(s, seconds, total)
                : (p.desktopVoiceEvent?.(s, seconds, total) ?? null),
            settle: (rid) => p.hub.settle({ reservation_id: rid, outcome: "succeeded" }),
            hangup: hangUp,
          })
        : undefined;
      const r = await drainOutbox({ store: p.outbox, hub: p.hub, now: p.now, alert: p.alert });
      return voiceSessionsSwept === undefined ? r : { ...r, voiceSessionsSwept };
    },
  };
};
