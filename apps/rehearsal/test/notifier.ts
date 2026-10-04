/**
 * The real notifier for the rehearsal: createApp with its Postgres store and the notify outbox
 * (migration 20261004003050), real senders (web push, WhatsApp Cloud API, Twilio, Cloud Tasks)
 * whose HTTP is mocked by msw (the notifier harness's mockServer), and Google OIDC checked against
 * a local test key. The clock is the notifier's own, so a ladder tick can be moved forward.
 */
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from "jose";
import webpush from "web-push";
import { loadEscalation } from "@chalito/config";
import type { Sql } from "postgres";
import { createApp, type AppConfig } from "../../notifier/src/app.js";
import type { NotifierDeps } from "../../notifier/src/executor.js";
import { PostgresNotifyOutbox, signPoke } from "../../notifier/src/notify-outbox.js";
import { googleOidcVerifier } from "../../notifier/src/oidc.js";
import { PostgresStore } from "../../notifier/src/postgres-store.js";
import { cloudTasksScheduler } from "../../notifier/src/scheduler.js";
import { webPushSender } from "../../notifier/src/senders/push.js";
import { twilioClient } from "../../notifier/src/senders/twilio.js";
import { whatsappSender } from "../../notifier/src/senders/whatsapp.js";

export const BASE = "https://notifier.chalito.test";
const PUSH_SA = "pubsub-push@chalito-dev.iam.gserviceaccount.com";
const TASKS_SA = "tasks@chalito-dev.iam.gserviceaccount.com";
const SCHEDULER_SA = "scheduler@chalito-dev.iam.gserviceaccount.com";
const QUEUE = "ladder-ticks";
const POKE_SECRET = "rehearsal-notify-poke-secret";

const googleKey = await generateKeyPair("RS256");
const googleJwk: JWK = { ...(await exportJWK(googleKey.publicKey)), kid: "rehearsal-key", alg: "RS256", use: "sig" };
const googleToken = (aud: string, email: string) =>
  new SignJWT({ email, email_verified: true })
    .setProtectedHeader({ alg: "RS256", kid: "rehearsal-key" })
    .setIssuer("https://accounts.google.com")
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(googleKey.privateKey);

export const createNotifier = (sql: Sql) => {
  let clock = Date.now();
  const logs: { msg: string; meta?: Record<string, unknown> }[] = [];
  const config = loadEscalation();
  const vapid = webpush.generateVAPIDKeys();
  const deps: NotifierDeps = {
    store: new PostgresStore(sql),
    push: webPushSender({ subject: "mailto:ops@chalito.test", ...vapid }),
    whatsapp: whatsappSender({ token: "wa-token", phoneNumberId: "1234567890", config }),
    twilio: twilioClient({ accountSid: "ACtest", authToken: "twilio-auth-token-test", from: "+14155550100" }),
    scheduler: cloudTasksScheduler({
      project: "chalito-dev",
      location: "us-central1",
      queue: QUEUE,
      tickUrl: `${BASE}/tasks/tick`,
      serviceAccountEmail: TASKS_SA,
      getAccessToken: async () => "gcp-token",
    }),
    config,
    publicBaseUrl: BASE,
    appUrl: "https://chalito.chalyb.com",
    now: () => clock,
    log: { info: (msg, meta) => logs.push({ msg, meta }), error: (msg, meta) => logs.push({ msg, meta }) },
  };
  const cfg: AppConfig = {
    pubsub: {
      email: PUSH_SA,
      audience: `${BASE}/pubsub/notifications`,
      notificationsAudience: `${BASE}/pubsub/notifications`,
      roomEventsAudience: `${BASE}/pubsub/room-events`,
    },
    tasks: { email: TASKS_SA, audience: `${BASE}/tasks/tick`, queueName: QUEUE },
    drain: { email: SCHEDULER_SA, audience: `${BASE}/tasks/drain-usage` },
    notify: {
      store: new PostgresNotifyOutbox(sql),
      pokeSecret: POKE_SECRET,
      drain: { email: SCHEDULER_SA, audience: `${BASE}/tasks/drain-notify` },
    },
    twilioAuthToken: "twilio-auth-token-test",
    metaAppSecret: "meta-app-secret-test",
    metaVerifyToken: "meta-verify",
  } as AppConfig;
  const app = createApp(deps, cfg, googleOidcVerifier(createLocalJWKSet({ keys: [googleJwk] })));

  return {
    app,
    logs,
    advance: (ms: number) => void (clock += ms),
    /** What the database's pg_net poke sends for one outbox row (signed like it). */
    poke: (id: number) => {
      const ts = clock;
      return app.request("/internal/notify-poke", {
        method: "POST",
        headers: { "content-type": "application/json", "x-chalito-poke-signature": signPoke(POKE_SECRET, id, ts) },
        body: JSON.stringify({ id, ts }),
      });
    },
    /** Cloud Scheduler's every-minute fallback over every due outbox row. */
    drainNotify: async () =>
      app.request("/tasks/drain-notify", {
        method: "POST",
        headers: { authorization: `Bearer ${await googleToken(`${BASE}/tasks/drain-notify`, SCHEDULER_SA)}` },
      }),
    /** A ladder tick as Cloud Tasks delivers it. */
    tick: async (uid: string, nid: string) =>
      app.request("/tasks/tick", {
        method: "POST",
        headers: {
          authorization: `Bearer ${await googleToken(`${BASE}/tasks/tick`, TASKS_SA)}`,
          "x-cloudtasks-queuename": QUEUE,
          "content-type": "application/json",
        },
        body: JSON.stringify({ uid, nid }),
      }),
  };
};

/** An IANA zone where it's around midday right now (fixed offset): no quiet hours in the way. */
export const middayZone = (now = new Date()) => {
  let offset = 12 - now.getUTCHours();
  if (offset > 12) offset -= 24;
  if (offset < -12) offset += 24;
  return offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
};
