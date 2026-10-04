import { createECDH, randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWK } from "jose";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import webpush from "web-push";
import { loadEscalation } from "@chalito/config";
import type { UserPrefs } from "@chalito/escalation";
import { createApp, type AppConfig } from "../src/app.js";
import type { NotifierDeps } from "../src/executor.js";
import { googleOidcVerifier } from "../src/oidc.js";
import { cloudTasksScheduler } from "../src/scheduler.js";
import { webPushSender } from "../src/senders/push.js";
import { twilioClient } from "../src/senders/twilio.js";
import { whatsappSender } from "../src/senders/whatsapp.js";
import { MemoryStore } from "../src/store.js";

export const BASE = "https://notifier.chalito.test";
export const PUSH_SA = "pubsub-push@chalito-dev.iam.gserviceaccount.com";
export const TASKS_SA = "tasks@chalito-dev.iam.gserviceaccount.com";
export const QUEUE = "ladder-ticks";
export const TWILIO_TOKEN = "twilio-auth-token-test";
export const META_SECRET = "meta-app-secret-test";
export const MIN = 60_000;
/** 2026-10-05 12:00 in Mexico City. */
export const NOON_MX = Date.UTC(2026, 9, 5, 18, 0, 0);

/** Every provider request the notifier made, as the mocks saw it. */
export interface Captured {
  whatsapp: { url: string; body: Record<string, unknown> }[];
  calls: Record<string, string>[];
  sms: Record<string, string>[];
  tasks: { method: string; url: string; body?: Record<string, unknown> }[];
  push: { endpoint: string; headers: Record<string, string>; bytes: number }[];
}

/** The fake Google signing key Pub/Sub and Cloud Tasks tokens are checked against. */
const googleKey = await generateKeyPair("RS256");
const googleJwk: JWK = { ...(await exportJWK(googleKey.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
export const otherKey = await generateKeyPair("RS256");

export const googleToken = async (
  claims: { aud: string; email: string; email_verified?: boolean; iss?: string },
  key = googleKey.privateKey,
) =>
  new SignJWT({ email: claims.email, email_verified: claims.email_verified ?? true })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(claims.iss ?? "https://accounts.google.com")
    .setAudience(claims.aud)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);

/** A browser-like push subscription (real P-256 keys, so web-push can encrypt to it). */
export const pushSubscription = (endpoint: string) => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint,
    keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  };
};

export const prefs = (over: Partial<UserPrefs> = {}): UserPrefs => ({
  tz: "America/Mexico_City",
  locale: "es",
  phone: { e164: "+525512345678", country: "MX", verified: true, chargesNoticeAckAt: 1 },
  whatsapp: { optIn: true },
  calls: { enabled: true },
  sms: { enabled: true },
  ...over,
});

export const mockServer = () => {
  const cap: Captured = { whatsapp: [], calls: [], sms: [], tasks: [], push: [] };
  const goneEndpoints = new Set<string>();
  const server = setupServer(
    http.post("https://graph.facebook.com/:version/:phoneId/messages", async ({ request }) => {
      cap.whatsapp.push({ url: request.url, body: (await request.json()) as Record<string, unknown> });
      return HttpResponse.json({ messages: [{ id: `wamid.${cap.whatsapp.length}` }] });
    }),
    http.post("https://api.twilio.com/2010-04-01/Accounts/:sid/Calls.json", async ({ request }) => {
      cap.calls.push(Object.fromEntries(new URLSearchParams(await request.text())));
      return HttpResponse.json({ sid: `CA${"0".repeat(31)}${cap.calls.length}` }, { status: 201 });
    }),
    http.post("https://api.twilio.com/2010-04-01/Accounts/:sid/Messages.json", async ({ request }) => {
      cap.sms.push(Object.fromEntries(new URLSearchParams(await request.text())));
      return HttpResponse.json({ sid: `SM${cap.sms.length}` }, { status: 201 });
    }),
    http.post("https://cloudtasks.googleapis.com/v2/*", async ({ request }) => {
      cap.tasks.push({ method: "POST", url: request.url, body: (await request.json()) as Record<string, unknown> });
      return HttpResponse.json({});
    }),
    http.delete("https://cloudtasks.googleapis.com/v2/*", ({ request }) => {
      cap.tasks.push({ method: "DELETE", url: request.url });
      return HttpResponse.json({});
    }),
    http.post("https://push.example.test/*", async ({ request }) => {
      cap.push.push({
        endpoint: request.url,
        headers: Object.fromEntries(request.headers.entries()),
        bytes: (await request.arrayBuffer()).byteLength,
      });
      return goneEndpoints.has(request.url)
        ? new HttpResponse(null, { status: 410 })
        : new HttpResponse(null, { status: 201 });
    }),
  );
  return { server, cap, goneEndpoints };
};

export const setup = (opts: { now?: () => number } = {}) => {
  const store = new MemoryStore();
  const logs: { msg: string; meta?: Record<string, unknown> }[] = [];
  let clock = NOON_MX;
  const config = loadEscalation();
  const vapid = webpush.generateVAPIDKeys();
  const deps: NotifierDeps = {
    store,
    push: webPushSender({ subject: "mailto:ops@chalito.test", ...vapid }),
    whatsapp: whatsappSender({ token: "wa-token", phoneNumberId: "1234567890", config }),
    twilio: twilioClient({ accountSid: "ACtest", authToken: TWILIO_TOKEN, from: "+14155550100" }),
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
    now: opts.now ?? (() => clock),
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
    twilioAuthToken: TWILIO_TOKEN,
    metaAppSecret: META_SECRET,
    metaVerifyToken: "meta-verify",
    realtimeSipUri: "sip:proj_test@sip.api.openai.com;transport=tls;secure=true",
  };
  const app = createApp(deps, cfg, googleOidcVerifier(createLocalJWKSet({ keys: [googleJwk] })));
  return {
    app,
    store,
    deps,
    logs,
    setClock: (t: number) => void (clock = t),
    /** POST a Pub/Sub push to the notifications endpoint, signed like Pub/Sub would. */
    publish: async (message: unknown, path = "/pubsub/notifications") =>
      app.request(path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await googleToken({ aud: `${BASE}${path}`, email: PUSH_SA })}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: { data: Buffer.from(JSON.stringify(message)).toString("base64"), messageId: "1" },
          subscription: "projects/chalito-dev/subscriptions/notifier",
        }),
      }),
    /** Deliver a ladder tick like Cloud Tasks would. */
    tick: async (uid: string, nid: string) =>
      app.request("/tasks/tick", {
        method: "POST",
        headers: {
          authorization: `Bearer ${await googleToken({ aud: `${BASE}/tasks/tick`, email: TASKS_SA })}`,
          "x-cloudtasks-queuename": QUEUE,
          "content-type": "application/json",
        },
        body: JSON.stringify({ uid, nid }),
      }),
  };
};
