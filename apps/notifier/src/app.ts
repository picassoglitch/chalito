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
import { handleEvent, type NotifierDeps } from "./executor.js";
import type { OidcExpectation, OidcVerifier } from "./oidc.js";
import { metaSignatureValid, twilioSignatureValid } from "./signatures.js";
import { TEMPLATE } from "./template.js";
import { connectTwiml, emptyTwiml, menuChoice, sayAndHangup } from "./twiml.js";

export interface AppConfig {
  pubsub: OidcExpectation & { notificationsAudience: string; roomEventsAudience: string };
  tasks: OidcExpectation & { queueName: string };
  twilioAuthToken: string;
  metaAppSecret: string;
  metaVerifyToken: string;
  /** sip:<project>@sip.api.openai.com;transport=tls;secure=true, or unset until Realtime is wired. */
  realtimeSipUri?: string;
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

export const createApp = (deps: NotifierDeps, cfg: AppConfig, verifyOidc: OidcVerifier) => {
  const app = new Hono();
  const voice = (locale: "es" | "en") => deps.config.voices[locale];

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
      return twiml(
        cfg.realtimeSipUri
          ? connectTwiml(cfg.realtimeSipUri)
          : sayAndHangup(
              locale === "es" ? "Abre tu app para responder. Hasta luego." : "Open your app to answer. Goodbye.",
              voice(locale),
              locale,
            ),
      );
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
    return c.body(null, 204);
  });

  // ---- WhatsApp Cloud API (X-Hub-Signature-256 over the raw body) -------------------
  app.get("/webhooks/whatsapp", (c) =>
    c.req.query("hub.mode") === "subscribe" && c.req.query("hub.verify_token") === cfg.metaVerifyToken
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
