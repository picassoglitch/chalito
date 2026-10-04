import { createECDH, randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWK } from "jose";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import webpush from "web-push";
import { openaiRealtime } from "@chalito/adapters/voice";
import { HubClient, MemoryOutbox, MemoryVoiceSessions } from "@chalito/billing";
import { loadEscalation, loadModels, loadPlans, loadPrices } from "@chalito/config";
import { hubCommsBilling } from "../src/billing.js";
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
/** Standard Webhooks secret format: whsec_ + base64. */
export const OPENAI_WEBHOOK_SECRET = `whsec_${Buffer.from("openai-webhook-secret-test").toString("base64")}`;

/** A scripted call WebSocket: the test plays OpenAI's side. */
export class FakeSocket {
  sent: Record<string, unknown>[] = [];
  #open?: () => void;
  #message?: (d: string) => void;
  #close?: () => void;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  send(d: string) {
    this.sent.push(JSON.parse(d) as Record<string, unknown>);
  }
  close() {
    this.#close?.();
  }
  onOpen(cb: () => void) {
    this.#open = cb;
  }
  onMessage(cb: (d: string) => void) {
    this.#message = cb;
  }
  onClose(cb: () => void) {
    this.#close = cb;
  }
  open() {
    this.#open?.();
  }
  /** OpenAI calls a function; resolves after the agent has answered. */
  async functionCall(name: string, args: unknown, callId = `call_${this.sent.length}`) {
    const before = this.sent.length;
    this.#message?.(
      JSON.stringify({
        type: "response.function_call_arguments.done",
        call_id: callId,
        name,
        arguments: JSON.stringify(args),
      }),
    );
    for (let i = 0; i < 200 && this.sent.length < before + 2; i++) await new Promise((r) => setTimeout(r, 5));
    const out = this.sent[before] as { item: { output: string } };
    return JSON.parse(out.item.output) as Record<string, unknown>;
  }
}
/** 2026-10-05 12:00 in Mexico City. */
export const NOON_MX = Date.UTC(2026, 9, 5, 18, 0, 0);

/** Every provider request the notifier made, as the mocks saw it. */
export const SCHEDULER_SA = "scheduler@chalito-dev.iam.gserviceaccount.com";
export const RID = "44444444-4444-4444-8444-444444444444";

/** What the mocked Chalyb hub answers to /usage/admit. */
export const hubState = { admit: "allowed" as "allowed" | "no_tokens" | "down", remaining: 10_000 };

export interface Captured {
  hub: { path: string; body: Record<string, unknown> }[];
  openai: { path: string; body: Record<string, unknown>; headers: Record<string, string> }[];
  whatsapp: { url: string; body: Record<string, unknown> }[];
  calls: Record<string, string>[];
  /** Twilio call updates (POST Calls/<CallSid>.json), e.g. Status=completed. */
  callUpdates: { callSid: string; form: Record<string, string> }[];
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
  const cap: Captured = { hub: [], openai: [], whatsapp: [], calls: [], callUpdates: [], sms: [], tasks: [], push: [] };
  const goneEndpoints = new Set<string>();
  const hubBase = "https://www.chalyb.com/api/engines/chalito";
  const server = setupServer(
    http.post(`${hubBase}/usage/admit`, async ({ request }) => {
      cap.hub.push({ path: "admit", body: (await request.json()) as Record<string, unknown> });
      if (hubState.admit === "down") return HttpResponse.json({ error: "x" }, { status: 503 });
      return HttpResponse.json(
        hubState.admit === "allowed"
          ? {
              ok: true,
              allowed: true,
              reservation_id: RID,
              lane: "standard",
              boost_fee_tokens: 0,
              limits: {},
              balance: {
                remaining: hubState.remaining,
                reserved: 0,
                unlimited: false,
                monthlyAllocation: 100_000,
                bonus: 0,
                monthlyUsed: 0,
                periodStart: "2026-10-01T00:00:00.000Z",
              },
            }
          : { ok: true, allowed: false, reason: "no_tokens" },
      );
    }),
    http.post(`${hubBase}/usage/settle`, async ({ request }) => {
      cap.hub.push({ path: "settle", body: (await request.json()) as Record<string, unknown> });
      return HttpResponse.json({ ok: true });
    }),
    http.post(`${hubBase}/usage`, async ({ request }) => {
      cap.hub.push({ path: "usage", body: (await request.json()) as Record<string, unknown> });
      return HttpResponse.json({ ok: true });
    }),
    http.post("https://api.openai.com/v1/*", async ({ request }) => {
      // Call controls like /hangup have no body.
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      cap.openai.push({
        path: new URL(request.url).pathname,
        body,
        headers: Object.fromEntries(request.headers.entries()),
      });
      if (request.url.endsWith("/client_secrets"))
        return HttpResponse.json({ value: "ek_test", expires_at: 1_790_000_060 });
      return HttpResponse.json({});
    }),
    http.post("https://graph.facebook.com/:version/:phoneId/messages", async ({ request }) => {
      cap.whatsapp.push({ url: request.url, body: (await request.json()) as Record<string, unknown> });
      return HttpResponse.json({ messages: [{ id: `wamid.${cap.whatsapp.length}` }] });
    }),
    http.post("https://api.twilio.com/2010-04-01/Accounts/:sid/Calls.json", async ({ request }) => {
      cap.calls.push(Object.fromEntries(new URLSearchParams(await request.text())));
      return HttpResponse.json({ sid: `CA${"0".repeat(31)}${cap.calls.length}` }, { status: 201 });
    }),
    http.post("https://api.twilio.com/2010-04-01/Accounts/:sid/Calls/:callSid", async ({ request, params }) => {
      cap.callUpdates.push({
        callSid: String(params.callSid).replace(/\.json$/, ""),
        form: Object.fromEntries(new URLSearchParams(await request.text())),
      });
      return HttpResponse.json({ sid: params.callSid, status: "completed" });
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

export const setup = (opts: { now?: () => number; billing?: boolean; caps?: boolean } = {}) => {
  const store = new MemoryStore();
  const sockets: FakeSocket[] = [];
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
  const outbox = new MemoryOutbox();
  const voiceSessions = new MemoryVoiceSessions();
  if (opts.caps) deps.caps = { plans: loadPlans(), isComped: (uid) => uid === "owner-1" };
  if (opts.billing)
    deps.billing = hubCommsBilling({
      hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "chalito-admin-token" }),
      outbox,
      enqueue: (owner, events) => outbox.enqueue(owner, events),
      prices: loadPrices(),
      voiceModel: loadModels().voice.call.model,
      now: () => deps.now(),
      alert: (msg, meta) => logs.push({ msg, meta }),
      voiceSessions,
      hangupCall: (callId) => openaiRealtime({ apiKey: "sk-test" }).hangupCall(callId),
      endPhoneCall: (callSid) => deps.twilio.endCall(callSid),
    });
  const cfg: AppConfig = {
    pubsub: {
      email: PUSH_SA,
      audience: `${BASE}/pubsub/notifications`,
      notificationsAudience: `${BASE}/pubsub/notifications`,
      roomEventsAudience: `${BASE}/pubsub/room-events`,
    },
    tasks: { email: TASKS_SA, audience: `${BASE}/tasks/tick`, queueName: QUEUE },
    drain: { email: SCHEDULER_SA, audience: `${BASE}/tasks/drain-usage` },
    twilioAuthToken: TWILIO_TOKEN,
    metaAppSecret: META_SECRET,
    metaVerifyToken: "meta-verify",
    voice: {
      provider: openaiRealtime({ apiKey: "sk-test" }),
      webhookSecret: OPENAI_WEBHOOK_SECRET,
      refSecret: "voice-ref-secret-test",
      sipUri: "sip:proj_test@sip.api.openai.com;transport=tls;secure=true",
      model: loadModels().voice.call.model,
      voiceName: "marin",
      openSocket: (url, headers) => {
        const s = new FakeSocket(url, headers);
        sockets.push(s);
        return s;
      },
    },
  };
  const app = createApp(deps, cfg, googleOidcVerifier(createLocalJWKSet({ keys: [googleJwk] })));
  return {
    app,
    store,
    outbox,
    voiceSessions,
    sockets,
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
