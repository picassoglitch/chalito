import { serve } from "@hono/node-server";
import { GoogleAuth } from "google-auth-library";
import postgres from "postgres";
import { openaiRealtime } from "@chalito/adapters/voice";
import { loadEscalation, loadModels } from "@chalito/config";
import { createApp } from "./app.js";
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

const log: Logger = {
  info: (msg, meta) => process.stdout.write(`${JSON.stringify({ severity: "INFO", msg, ...meta })}\n`),
  error: (msg, meta) => process.stderr.write(`${JSON.stringify({ severity: "ERROR", msg, ...meta })}\n`),
};

const base = env("PUBLIC_BASE_URL").replace(/\/$/, "");
const config = loadEscalation();
const sql = postgres(env("DATABASE_URL"), {
  max: 10,
  onnotice: () => {},
  // Least privilege (security review S2): act as chalito_server when the login holds it with SET.
  ...(process.env.DATABASE_ROLE ? { connection: { role: process.env.DATABASE_ROLE } } : {}),
});
const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

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
