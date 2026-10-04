import { installConsoleRedaction, redact, redactDeep } from "@chalito/redact";
import { serve } from "@hono/node-server";
import { GoogleAuth } from "google-auth-library";
import postgres from "postgres";
import { openaiRealtime } from "@chalito/adapters/voice";
import {
  HubClient,
  HubStreamUsage,
  PostgresOutbox,
  PostgresVoiceSessions,
  compedFrom,
  enqueueUsage,
} from "@chalito/billing";
import { loadEscalation, loadModels, loadPlans, loadPrices } from "@chalito/config";
import { createApp } from "./app.js";
import { hubCommsBilling } from "./billing.js";
import type { Logger } from "./executor.js";
import { googleOidcVerifier } from "./oidc.js";
import { PostgresStore } from "./postgres-store.js";
import { cloudTasksScheduler } from "./scheduler.js";
import { webPushSender } from "./senders/push.js";
import { twilioClient } from "./senders/twilio.js";
import { whatsappSender } from "./senders/whatsapp.js";
import { wsSocketFactory } from "./voice/ws-socket.js";

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

// Every log line and stray console call is redacted (R-M9).
installConsoleRedaction();
const line = (severity: string, msg: string, meta?: Record<string, unknown>) =>
  JSON.stringify({ severity, msg: redact(msg), ...(meta ? (redactDeep(meta) as object) : {}) });
const log: Logger = {
  info: (msg, meta) => process.stdout.write(`${line("INFO", msg, meta)}\n`),
  error: (msg, meta) => process.stderr.write(`${line("ERROR", msg, meta)}\n`),
};

const base = env("PUBLIC_BASE_URL").replace(/\/$/, "");
const config = loadEscalation();
const sql = postgres(env("DATABASE_URL"), {
  max: 10,
  onnotice: () => {},
  // Least privilege (security review S2): act as chalito_server when the login holds it with SET.
  ...(process.env.DATABASE_ROLE ? { connection: { role: process.env.DATABASE_ROLE } } : {}),
});
const hub = new HubClient({ baseUrl: env("CHALYB_BASE_URL"), token: env("CHALITO_ADMIN_TOKEN") });
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

const voiceSessions = new PostgresVoiceSessions(sql);
const desktopVoice = new HubStreamUsage({
  hub,
  prices: loadPrices(),
  model: loadModels().voice.desktop.model,
  now: Date.now,
});

const app = createApp(
  {
    store: new PostgresStore(sql),
    push: webPushSender({
      subject: env("VAPID_SUBJECT"),
      publicKey: env("VAPID_PUBLIC_KEY"),
      privateKey: env("VAPID_PRIVATE_KEY"),
    }),
    whatsapp: whatsappSender({ token: env("WHATSAPP_TOKEN"), phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"), config }),
    twilio: twilioClient({
      accountSid: env("TWILIO_ACCOUNT_SID"),
      authToken: env("TWILIO_AUTH_TOKEN"),
      from: env("TWILIO_FROM"),
    }),
    scheduler: cloudTasksScheduler({
      project: env("GOOGLE_CLOUD_PROJECT"),
      location: env("TASKS_LOCATION"),
      queue: env("TASKS_QUEUE"),
      tickUrl: `${base}/tasks/tick`,
      serviceAccountEmail: env("TASKS_SA_EMAIL"),
      getAccessToken: async () => (await auth.getAccessToken()) ?? "",
    }),
    config,
    publicBaseUrl: base,
    appUrl: env("APP_URL"),
    now: Date.now,
    log,
    // Monthly plan caps for paid channels (plans.yaml inclusions), then the hub admit.
    caps: { plans: loadPlans(), isComped: compedFrom(process.env.OWNER_UIDS) },
    // Paid channels are admitted and metered through the Chalyb hub (ADR 0016).
    billing: hubCommsBilling({
      hub,
      outbox: new PostgresOutbox(sql),
      enqueue: (owner, events) => enqueueUsage(sql, owner, events),
      prices: loadPrices(),
      voiceModel: loadModels().voice.call.model,
      now: Date.now,
      alert: (msg, meta) => log.error(msg, { ...meta, alert: true }),
      // Voice sessions (calls here, desktop in apps/api) are metered on the server; never-ended
      // ones are billed in full by the drain task (R-H6, R-M8).
      voiceSessions,
      desktopVoiceEvent: (sess, seconds, total) =>
        desktopVoice.event({
          owner: sess.owner,
          admissionId: sess.reservationId,
          kind: "voice.seconds",
          seconds,
          sourceId: `${sess.sourceId}:${total}`,
        }),
      // A desktop call that stopped heart-beating is hung up at OpenAI as well (needs only the key).
      ...(process.env.OPENAI_API_KEY
        ? { hangupCall: (callId: string) => openaiRealtime({ apiKey: env("OPENAI_API_KEY") }).hangupCall(callId) }
        : {}),
    }),
  },
  {
    pubsub: {
      email: env("PUBSUB_SA_EMAIL"),
      audience: `${base}/pubsub/notifications`,
      notificationsAudience: `${base}/pubsub/notifications`,
      roomEventsAudience: `${base}/pubsub/room-events`,
    },
    tasks: { email: env("TASKS_SA_EMAIL"), audience: `${base}/tasks/tick`, queueName: env("TASKS_QUEUE") },
    twilioAuthToken: env("TWILIO_AUTH_TOKEN"),
    drain: { audience: `${base}/tasks/drain-usage`, email: env("SCHEDULER_SA_EMAIL") },
    metaAppSecret: env("META_APP_SECRET"),
    metaVerifyToken: env("META_VERIFY_TOKEN"),
    ...(process.env.REALTIME_SIP_URI
      ? {
          voice: {
            provider: openaiRealtime({ apiKey: env("OPENAI_API_KEY") }),
            webhookSecret: env("OPENAI_WEBHOOK_SECRET"),
            refSecret: env("VOICE_REF_SECRET"),
            sipUri: process.env.REALTIME_SIP_URI,
            model: loadModels().voice.call.model,
            voiceName: process.env.REALTIME_VOICE ?? "marin",
            openSocket: wsSocketFactory,
          },
        }
      : {}),
  },
  googleOidcVerifier(),
);

const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8788) });
process.on("SIGTERM", () => server.close(() => process.exit(0)));
