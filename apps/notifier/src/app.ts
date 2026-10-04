import { processOutbox, verifyPoke, type NotifyOutboxStore, type OutboxMessage } from "./notify-outbox.js";
import { guard } from "@chalito/guard";
import { NOTIFIER_ROUTES } from "./limits.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  Channel,
  Counts,
  DeepLink,
  EpochMs,
  Id,
  Level,
  NotificationId,
  NotificationSource,
  Urgency,
} from "@chalito/protocol";
import type { EscalationEvent } from "@chalito/escalation";
import { capNote, voiceSecondsLeft } from "./caps.js";
import { handleEvent, type NotifierDeps } from "./executor.js";
import type { OidcExpectation, OidcVerifier } from "./oidc.js";
import { metaSignatureValid, twilioSignatureValid } from "./signatures.js";
import { TEMPLATE } from "./template.js";
import { connectTwiml, emptyTwiml, menuChoice, sayAndHangup } from "./twiml.js";
import { runCallAgent, type CallSocketFactory } from "./voice/call-agent.js";
import { signCallRef, verifyCallRef } from "./voice/call-ref.js";
import { callSession, type CallContext } from "./voice/call-session.js";
import { verifyStandardWebhook, type VoiceProvider } from "@chalito/adapters/voice";

export interface AppConfig {
  /** Proxies in front of Cloud Run that append to X-Forwarded-For (default 0). */
  trustedProxies?: number;
  pubsub: OidcExpectation & { notificationsAudience: string; roomEventsAudience: string };
  tasks: OidcExpectation & { queueName: string };
  twilioAuthToken: string;
  metaAppSecret: string;
  metaVerifyToken: string;
  /** Cloud Scheduler → POST /tasks/drain-usage (Google OIDC). */
  drain?: OidcExpectation;
  /**
   * The database's notify outbox (migration 20261004003050): pg_net pokes on
   * POST /internal/notify-poke (HMAC with NOTIFY_POKE_SECRET) and Cloud Scheduler's
   * POST /tasks/drain-notify (Google OIDC). Unset: both routes are 404.
   */
  notify?: { store: NotifyOutboxStore; pokeSecret: string; drain: OidcExpectation };
  /** OpenAI Realtime calls (ADR 0005/0011). Unset: DTMF 1 tells the user to open the app. */
  voice?: VoiceConfig;
}

export interface VoiceConfig {
  provider: VoiceProvider;
  /** OpenAI project webhook secret (whsec_…), for realtime.call.incoming. */
  webhookSecret: string;
  /** Signs the X-Chalito-Ref that ties a SIP call to its Twilio call. */
  refSecret: string;
  /** sip:<proj>@sip.api.openai.com;transport=tls;secure=true */
  sipUri: string;
  /** models.yaml voice.call.model */
  model: string;
  /** OpenAI voice name. */
  voiceName: string;
  openSocket: CallSocketFactory;
}

/** An escalation item as published on `notifications`. Unknown fields are dropped. */
const Item = z.object({
  nid: NotificationId,
  source: NotificationSource,
  urgency: Urgency,
  level: Level,
  counts: Counts,
  coalesceKey: z.string().min(1).max(128),
  deepLink: DeepLink,
  createdAt: EpochMs,
  approvalExpiresAt: EpochMs.optional(),
  mesaStartsAt: EpochMs.optional(),
});

export const NotifierMessage = z.discriminatedUnion("type", [
  z.object({ v: z.literal(1), type: z.literal("notify"), uid: Id, item: Item }),
  z.object({
    v: z.literal(1),
    type: z.literal("ack"),
    uid: Id,
    via: Channel.or(z.literal("app")),
    nid: NotificationId.optional(),
    coalesceKey: z.string().max(128).optional(),
    all: z.boolean().optional(),
  }),
  z.object({ v: z.literal(1), type: z.literal("approval_expired"), uid: Id, nid: NotificationId }),
]);

/** A room event on `room-events`: a metadata nudge only (rooms are end-to-end encrypted). */
export const RoomEventMessage = z.object({ v: z.literal(1), uid: Id, roomId: Id, eid: Id, createdAt: EpochMs });

const PushEnvelope = z.object({ message: z.object({ data: z.string(), messageId: z.string() }) });
const Tick = z.object({ uid: Id, nid: NotificationId });

const decodePush = (body: unknown): unknown => {
  const env = PushEnvelope.safeParse(body);
  if (!env.success) return null;
  try {
    return JSON.parse(Buffer.from(env.data.message.data, "base64").toString("utf8"));
  } catch {
    return null;
  }
};

const toEvent = (m: z.infer<typeof NotifierMessage>): EscalationEvent => {
  switch (m.type) {
    case "notify":
      return { type: "notify", item: m.item };
    case "ack":
      return {
        type: "ack",
        via: m.via,
        ...(m.nid ? { nid: m.nid } : {}),
        ...(m.coalesceKey ? { coalesceKey: m.coalesceKey } : {}),
        ...(m.all ? { all: true } : {}),
      };
    case "approval_expired":
      return { type: "approval_expired", nid: m.nid };
  }
};

/** WhatsApp sends `from` without "+", and MX mobiles as 521 + 10 digits; ours are +52 + 10. */
export const waToE164 = (from: string) => {
  const digits = from.replace(/\D/g, "");
  return digits.length === 13 && digits.startsWith("521") ? `+52${digits.slice(3)}` : `+${digits}`;
};

/** The longest a call's voice leg may run (Twilio Dial timeLimit), whatever minutes are left. */
export const MAX_CALL_VOICE_SEC = 20 * 60;

/** Constant-time comparison of a presented secret with the configured one (R-L10). */
const sameSecret = (got: string | undefined, want: string) => {
  if (!got || !want) return false;
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
};

/**
 * Desktop and call voice share the month's minutes, and a call's own seconds are billed only when
 * it closes: each drain (every minute) ends the calls that have used what was left. Twilio's
 * timeLimit (minutes left at DTMF 1) still bounds a call when nothing else is talking.
 */
export const endCallsAtCap = async (deps: NotifierDeps) => {
  if (!deps.billing || !deps.caps) return 0;
  let ended = 0;
  for (const s of await deps.billing.openCallVoices()) {
    const elapsed = Math.floor((deps.now() - s.startedAt) / 1000);
    if (elapsed < (await voiceSecondsLeft(deps, s.owner))) continue;
    await deps.billing.hangUpCallVoice(s);
    await capNote(deps, s.owner, "voice").catch(() => undefined);
    deps.log.info("voice.call_capped", { sourceId: s.sourceId });
    ended++;
  }
  return ended;
};

export const createApp = (deps: NotifierDeps, cfg: AppConfig, verifyOidc: OidcVerifier) => {
  const app = new Hono();
  const voice = (locale: "es" | "en") => deps.config.voices[locale];
  // First: per-IP rate limits and body caps for every route (src/limits.ts).
  app.use("*", guard(NOTIFIER_ROUTES, { now: deps.now, trustedProxies: cfg.trustedProxies ?? 0 }));

  app.get("/healthz", (c) => c.json({ ok: true }));

  // ---- Pub/Sub push (OIDC) ----------------------------------------------------------
  // 2xx acks the message; malformed messages are acked too (retrying can't fix them).
  app.post("/pubsub/notifications", async (c) => {
    if (
      !(await verifyOidc(c.req.header("authorization"), {
        audience: cfg.pubsub.notificationsAudience,
        email: cfg.pubsub.email,
      }))
    )
      return c.json({ error: "unauthorized" }, 401);
    const msg = NotifierMessage.safeParse(decodePush(await c.req.json().catch(() => null)));
    if (!msg.success) {
      deps.log.error("notifier.bad_message", { topic: "notifications" });
      return c.body(null, 204);
    }
    await handleEvent(deps, msg.data.uid, toEvent(msg.data));
    return c.body(null, 204);
  });

  app.post("/pubsub/room-events", async (c) => {
    if (
      !(await verifyOidc(c.req.header("authorization"), {
        audience: cfg.pubsub.roomEventsAudience,
        email: cfg.pubsub.email,
      }))
    )
      return c.json({ error: "unauthorized" }, 401);
    const msg = RoomEventMessage.safeParse(decodePush(await c.req.json().catch(() => null)));
    if (!msg.success) return c.body(null, 204);
    const r = msg.data;
    await handleEvent(deps, r.uid, {
      type: "notify",
      item: {
        nid: `room_${r.roomId}_${r.eid}`.slice(0, 128),
        source: "room_event",
        urgency: "normal",
        level: "L1",
        counts: { approvals: 0, questions: 0, messages: 1, mesas: 0 },
        coalesceKey: `room:${r.roomId}`,
        deepLink: `/r/${r.roomId}`,
        createdAt: r.createdAt,
      },
    });
    return c.body(null, 204);
  });

  // ---- The database's notify outbox (pg_net poke + scheduled drain) -------------------
  /** One outbox row through the same path as Pub/Sub `notifications`. */
  const handleOutbox = async (row: OutboxMessage): Promise<"ok" | "invalid"> => {
    const msg = NotifierMessage.safeParse(row.message);
    if (!msg.success || msg.data.uid !== row.owner) return "invalid";
    await handleEvent(deps, msg.data.uid, toEvent(msg.data));
    return "ok";
  };
  const runOutbox = async (claim: { id?: number; limit: number }) => {
    const n = cfg.notify!;
    const rows = await n.store.claim({ ...claim, now: deps.now(), leaseMs: 60_000 });
    return processOutbox({
      store: n.store,
      rows,
      now: deps.now,
      handle: handleOutbox,
      alert: (msg, meta) => deps.log.error(msg, { ...meta, alert: true }),
    });
  };
  const PokeBody = z.object({ id: z.number().int().positive(), ts: z.number().int().positive() });

  /** pg_net, right after the source row commits: deliver that one row now. A replay is a no-op. */
  app.post("/internal/notify-poke", async (c) => {
    if (!cfg.notify) return c.text("not found", 404);
    const body = PokeBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    if (!verifyPoke(cfg.notify.pokeSecret, c.req.header("x-chalito-poke-signature"), body.data, deps.now()))
      return c.json({ error: "unauthorized" }, 401);
    return c.json(await runOutbox({ id: body.data.id, limit: 1 }));
  });

  /** Cloud Scheduler, every minute: whatever a poke missed. */
  app.post("/tasks/drain-notify", async (c) => {
    if (!cfg.notify) return c.text("not found", 404);
    if (!(await verifyOidc(c.req.header("authorization"), cfg.notify.drain)))
      return c.json({ error: "unauthorized" }, 401);
    return c.json(await runOutbox({ limit: 100 }));
  });

  // ---- Cloud Tasks ladder ticks (OIDC + queue header) --------------------------------
  app.post("/tasks/tick", async (c) => {
    const ok =
      c.req.header("x-cloudtasks-queuename") === cfg.tasks.queueName &&
      (await verifyOidc(c.req.header("authorization"), { audience: cfg.tasks.audience, email: cfg.tasks.email }));
    if (!ok) return c.json({ error: "unauthorized" }, 401);
    const tick = Tick.safeParse(await c.req.json().catch(() => null));
    if (!tick.success) return c.body(null, 204);
    await handleEvent(deps, tick.data.uid, { type: "tick", nid: tick.data.nid });
    return c.body(null, 204);
  });

  // ---- Twilio (X-Twilio-Signature over our public URL + POST params) -----------------
  const twilioParams = async (c: {
    req: { url: string; header(n: string): string | undefined; parseBody(): Promise<Record<string, unknown>> };
  }) => {
    const raw = await c.req.parseBody();
    const params = Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "string")) as Record<
      string,
      string
    >;
    const u = new URL(c.req.url);
    const url = `${deps.publicBaseUrl}${u.pathname}${u.search}`;
    return twilioSignatureValid(cfg.twilioAuthToken, url, params, c.req.header("x-twilio-signature")) ? params : null;
  };
  const twiml = (body: string) => new Response(body, { headers: { "content-type": "text/xml" } });

  /** The call menu: 1 connect, 2 snooze, 3 dismiss. Nothing here can approve anything. */
  app.post("/webhooks/twilio/gather", async (c) => {
    const p = await twilioParams(c);
    if (!p) return c.text("forbidden", 403);
    const uid = c.req.query("uid") ?? "";
    const nid = c.req.query("nid") ?? "";
    const locale = c.req.query("lang") === "en" ? "en" : "es";
    const choice = menuChoice(p.Digits, p.SpeechResult);
    if (choice === "connect") {
      await handleEvent(deps, uid, { type: "ack", via: "call", nid });
      const callSid = p.CallSid ?? "";
      const secondsLeft = await voiceSecondsLeft(deps, uid);
      const voiceLeft = secondsLeft > 0;
      if (!voiceLeft) await capNote(deps, uid, "voice");
      if (!cfg.voice || !voiceLeft || !/^CA[0-9a-f]{32}$/.test(callSid))
        return twiml(
          sayAndHangup(
            locale === "es" ? "Abre tu app para responder. Hasta luego." : "Open your app to answer. Goodbye.",
            voice(locale),
            locale,
          ),
        );
      // Freeze what the call is for: only these waiting items can be answered on it.
      const lids = (await deps.store.callItems(uid)).items.slice(0, 10).map((it) => it.lid);
      // Hard bound on the voice leg: this month's minutes left, at most MAX_CALL_VOICE_SEC.
      const maxSec = Math.floor(Math.min(MAX_CALL_VOICE_SEC, secondsLeft));
      const ref = signCallRef(cfg.voice.refSecret, {
        uid,
        nid,
        callSid,
        locale,
        exp: deps.now() + 2 * 60_000,
        lids,
        maxSec,
      });
      return twiml(connectTwiml(`${cfg.voice.sipUri}?X-Chalito-Ref=${ref}`, maxSec));
    }
    if (choice === "snooze") {
      await handleEvent(deps, uid, { type: "snooze", nid });
      return twiml(
        sayAndHangup(locale === "es" ? "Te llamo más tarde." : "I'll call you later.", voice(locale), locale),
      );
    }
    if (choice === "dismiss") {
      await handleEvent(deps, uid, { type: "ack", via: "call", nid });
      return twiml(sayAndHangup(locale === "es" ? "Listo. Hasta luego." : "Done. Goodbye.", voice(locale), locale));
    }
    return twiml(
      sayAndHangup(
        locale === "es" ? "No recibí respuesta. Hasta luego." : "No answer received. Goodbye.",
        voice(locale),
        locale,
      ),
    );
  });

  /** Inbound SMS: STOP-style replies opt out of SMS; anything else acknowledges (ack anywhere). */
  app.post("/webhooks/twilio/sms", async (c) => {
    const p = await twilioParams(c);
    if (!p) return c.text("forbidden", 403);
    const uid = await deps.store.findUserByPhone(p.From ?? "");
    if (uid) {
      if (p.OptOutType === "STOP" || /^\s*(stop|baja|alto|cancelar|unsubscribe)\s*$/i.test(p.Body ?? ""))
        await deps.store.optOut(uid, "sms");
      else await handleEvent(deps, uid, { type: "ack", via: "sms", all: true });
    }
    return twiml(emptyTwiml());
  });

  app.post("/webhooks/twilio/status", async (c) => {
    const p = await twilioParams(c);
    if (!p) return c.text("forbidden", 403);
    deps.log.info("notifier.twilio_status", {
      sid: p.CallSid ?? p.MessageSid,
      status: p.CallStatus ?? p.MessageStatus,
    });
    // Calls carry uid/country/reservation in their (signed) status URL: meter the minutes.
    const uid = c.req.query("uid");
    const rid = c.req.query("rid");
    if (deps.billing && uid && p.CallSid) {
      if (p.CallStatus === "completed")
        await deps.billing.recordCall(uid, {
          callSid: p.CallSid,
          seconds: Number(p.CallDuration ?? 0),
          country: c.req.query("c") ?? "",
          ...(rid ? { reservationId: rid } : {}),
        });
      else if (rid && ["busy", "failed", "no-answer", "canceled"].includes(p.CallStatus ?? ""))
        await deps.billing.release(rid);
    }
    return c.body(null, 204);
  });

  // ---- Usage outbox drain (Cloud Scheduler, OIDC) ------------------------------------
  app.post("/tasks/drain-usage", async (c) => {
    if (!deps.billing || !cfg.drain) return c.text("not found", 404);
    if (!(await verifyOidc(c.req.header("authorization"), cfg.drain))) return c.json({ error: "unauthorized" }, 401);
    const drained = await deps.billing.drain();
    return c.json({ ...drained, callsEndedAtCap: await endCallsAtCap(deps) });
  });

  // ---- OpenAI Realtime SIP (Standard Webhooks signature) -----------------------------
  /**
   * realtime.call.incoming: accept only calls carrying a valid X-Chalito-Ref (our own DTMF-1
   * bridge), with the briefing context and the two call tools; reject everything else.
   */
  app.post("/webhooks/openai", async (c) => {
    const raw = await c.req.text();
    const v = cfg.voice;
    if (!v) return c.text("not found", 404);
    const ok = verifyStandardWebhook({
      secret: v.webhookSecret,
      id: c.req.header("webhook-id"),
      timestamp: c.req.header("webhook-timestamp"),
      signature: c.req.header("webhook-signature"),
      body: raw,
      nowMs: deps.now(),
    });
    if (!ok) return c.text("forbidden", 401);
    const ev = JSON.parse(raw) as {
      type?: string;
      data?: { call_id?: string; sip_headers?: { name?: string; value?: string }[] };
    };
    if (ev.type !== "realtime.call.incoming" || !ev.data?.call_id) return c.body(null, 200);
    const callId = ev.data.call_id;
    const token = ev.data.sip_headers?.find((h) => h.name?.toLowerCase() === "x-chalito-ref")?.value;
    const ref = verifyCallRef(v.refSecret, token, deps.now());
    // Single use across every instance (chalito_private.voice_call_refs).
    if (!ref || !(await deps.store.claimCallRef(createHash("sha256").update(token!).digest("hex"), ref.exp))) {
      deps.log.info("voice.call_rejected", { callId, reason: ref ? "reused" : "unknown" });
      await v.provider.rejectCall(callId, 603);
      return c.body(null, 200);
    }
    const [{ callBriefingEnabled, items }, approvals, name] = await Promise.all([
      deps.store.callItems(ref.uid),
      deps.store.pendingApprovals(ref.uid),
      deps.store.companionName(ref.uid),
    ]);
    const ctx: CallContext = {
      uid: ref.uid,
      nid: ref.nid,
      callSid: ref.callSid,
      locale: ref.locale,
      companionName: name ?? "Chalito",
      callBriefingEnabled,
      // Server-side binding: only the items frozen into the signed ref at DTMF 1.
      items: items.filter((it) => ref.lids.includes(it.lid)).slice(0, 10),
      approvals,
    };
    // Admitted and metered on the server before the voice starts (R-M8): a session row bounded by
    // the call's maxSec, billed in one transaction on close, and swept in full if this instance dies.
    const metered = deps.billing
      ? await deps.billing.openCallVoice(ref.uid, { callSid: ref.callSid, maxSeconds: ref.maxSec })
      : null;
    if (metered && !metered.ok) {
      deps.log.info("voice.call_rejected", { callId, reason: metered.reason });
      await v.provider.rejectCall(callId, 603);
      return c.body(null, 200);
    }
    await v.provider.acceptCall(callId, callSession(ctx, v.model, v.voiceName));
    // With the call id on the session, the cap check, the sweep and a revoke can hang it up.
    if (metered?.ok)
      await deps
        .billing!.connectedCallVoice(ref.uid, metered.sourceId, callId)
        .catch((err: unknown) =>
          deps.log.error("voice.call_id_failed", { callId, error: err instanceof Error ? err.message : "error" }),
        );
    const { url, headers } = v.provider.callSocket(callId);
    // The call outlives this request: Cloud Run needs CPU always allocated for the notifier.
    void runCallAgent(deps, v.openSocket(url, headers), ctx)
      .catch((err: unknown) =>
        deps.log.error("voice.agent_failed", { callId, error: err instanceof Error ? err.message : "error" }),
      )
      .finally(() => {
        if (metered?.ok)
          void deps
            .billing!.closeCallVoice(ref.uid, metered.sourceId)
            .catch((err: unknown) =>
              deps.log.error("voice.meter_failed", { callId, error: err instanceof Error ? err.message : "error" }),
            );
      });
    return c.body(null, 200);
  });

  // ---- WhatsApp Cloud API (X-Hub-Signature-256 over the raw body) -------------------
  app.get("/webhooks/whatsapp", (c) =>
    c.req.query("hub.mode") === "subscribe" && sameSecret(c.req.query("hub.verify_token"), cfg.metaVerifyToken)
      ? c.text(c.req.query("hub.challenge") ?? "")
      : c.text("forbidden", 403),
  );

  /** Records acks and opt-outs only; statuses are logged. */
  app.post("/webhooks/whatsapp", async (c) => {
    const raw = await c.req.text();
    if (!metaSignatureValid(cfg.metaAppSecret, raw, c.req.header("x-hub-signature-256")))
      return c.text("forbidden", 403);
    const body = JSON.parse(raw) as {
      entry?: {
        changes?: { value?: { messages?: { from?: string; type?: string; button?: { payload?: string } }[] } }[];
      }[];
    };
    for (const entry of body.entry ?? [])
      for (const change of entry.changes ?? [])
        for (const m of change.value?.messages ?? []) {
          const uid = m.from ? await deps.store.findUserByPhone(waToE164(m.from)) : null;
          if (!uid) continue;
          if (m.type === "button" && m.button?.payload === TEMPLATE.quickReplyPayload)
            await deps.store.optOut(uid, "whatsapp");
          else await handleEvent(deps, uid, { type: "ack", via: "whatsapp", all: true });
        }
    return c.body(null, 200);
  });

  app.onError((err, c) => {
    deps.log.error("notifier.unhandled", { error: err instanceof Error ? err.message : "error" });
    return c.json({ error: "internal" }, 500);
  });
  return app;
};
