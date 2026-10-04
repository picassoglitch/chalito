import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateBoxKeyPair, toB64url } from "@chalito/crypto";
import { RelayedCommand, SignedCommand } from "@chalito/protocol";
import type { PushPayload } from "@chalito/escalation";
import { relaySpokenAnswer } from "../src/relay.js";
import { metaSignature, twilioSignature } from "../src/signatures.js";
import {
  BASE,
  MIN,
  NOON_MX,
  PUSH_SA,
  QUEUE,
  TASKS_SA,
  googleToken,
  mockServer,
  otherKey,
  prefs,
  pushSubscription,
  setup,
} from "./harness.js";

const { server, cap, goneEndpoints } = mockServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  for (const list of Object.values(cap)) list.length = 0;
  goneEndpoints.clear();
});

const SECRET = "SECRET corre rm -rf ~/prod en staging";
const UID = "hub-user-1";

const item = (over: Record<string, unknown> = {}) => ({
  nid: "n1",
  source: "session_question",
  urgency: "high",
  level: "L4",
  counts: { approvals: 0, questions: 1, messages: 0, mesas: 0 },
  coalesceKey: "session:s1",
  deepLink: "/s/s1",
  createdAt: NOON_MX,
  ...over,
});

/** A user with two push subscriptions; payloads handed to the push sender are recorded. */
const withUser = (over = {}) => {
  const h = setup();
  h.store.prefs.set(UID, prefs(over));
  h.store.subs.set(UID, [
    pushSubscription("https://push.example.test/a"),
    pushSubscription("https://push.example.test/b"),
  ]);
  const pushed: PushPayload[] = [];
  const send = h.deps.push.send.bind(h.deps.push);
  h.deps.push.send = async (sub, payload, ttl) => (pushed.push(payload), send(sub, payload, ttl));
  return { ...h, pushed };
};

/** Fires every scheduled tick in order (the clock jumps to each ladder's nextAt). */
const drive = async (h: ReturnType<typeof withUser>, until = NOON_MX + 24 * 60 * MIN) => {
  for (let i = 0; i < 50; i++) {
    const next = (h.store.ladders.get(UID) ?? [])
      .filter((l) => (l.state === "pending" || l.state === "snoozed") && l.nextAt !== null && l.nextAt <= until)
      .sort((a, b) => a.nextAt! - b.nextAt!)[0];
    if (!next) return;
    h.setClock(next.nextAt!);
    expect((await h.tick(UID, next.item.nid)).status).toBe(204);
  }
};

describe("OIDC on Pub/Sub push and Cloud Tasks", () => {
  const body = JSON.stringify({ message: { data: Buffer.from("{}").toString("base64"), messageId: "1" } });
  const post = (h: ReturnType<typeof setup>, path: string, headers: Record<string, string>) =>
    h.app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  it("rejects missing, forged, mis-addressed and wrong-signer tokens", async () => {
    const h = setup();
    const aud = `${BASE}/pubsub/notifications`;
    expect((await post(h, "/pubsub/notifications", {})).status).toBe(401);
    for (const token of [
      await googleToken({ aud, email: PUSH_SA }, otherKey.privateKey),
      await googleToken({ aud: `${BASE}/elsewhere`, email: PUSH_SA }),
      await googleToken({ aud, email: "attacker@evil.iam.gserviceaccount.com" }),
      await googleToken({ aud, email: PUSH_SA, email_verified: false }),
      await googleToken({ aud, email: PUSH_SA, iss: "https://evil.example" }),
    ])
      expect((await post(h, "/pubsub/notifications", { authorization: `Bearer ${token}` })).status).toBe(401);
    // A valid push token is not a valid tick token.
    const pushToken = await googleToken({ aud, email: PUSH_SA });
    expect(
      (await post(h, "/tasks/tick", { authorization: `Bearer ${pushToken}`, "x-cloudtasks-queuename": QUEUE })).status,
    ).toBe(401);
  });

  it("ticks also need the queue header", async () => {
    const h = setup();
    const token = await googleToken({ aud: `${BASE}/tasks/tick`, email: TASKS_SA });
    expect((await post(h, "/tasks/tick", { authorization: `Bearer ${token}` })).status).toBe(401);
    expect(
      (await post(h, "/tasks/tick", { authorization: `Bearer ${token}`, "x-cloudtasks-queuename": "other" })).status,
    ).toBe(401);
    expect(
      (await post(h, "/tasks/tick", { authorization: `Bearer ${token}`, "x-cloudtasks-queuename": QUEUE })).status,
    ).toBe(204);
  });

  it("acks malformed messages and unknown users without sending anything", async () => {
    const h = withUser();
    expect((await h.publish({ v: 1, type: "nope" })).status).toBe(204);
    expect((await h.publish({ v: 1, type: "notify", uid: "someone-else", item: item() })).status).toBe(204);
    expect(cap.push.length + cap.whatsapp.length + cap.calls.length + cap.tasks.length).toBe(0);
  });
});

describe("a full L4 ladder, end to end", () => {
  it("push → re-push → WhatsApp → call → SMS, each through its provider", async () => {
    const h = withUser();
    expect((await h.publish({ v: 1, type: "notify", uid: UID, item: item() })).status).toBe(204);

    // Push at once, to every subscription, with VAPID auth.
    expect(cap.push.map((p) => p.endpoint)).toEqual(["https://push.example.test/a", "https://push.example.test/b"]);
    expect(cap.push[0]!.headers.authorization).toMatch(/^vapid t=.+, k=.+/);
    expect(cap.push[0]!.headers.ttl).toBe("3600");
    // The next rung is a Cloud Task with an OIDC token for the tick endpoint.
    const task = cap.tasks[0]!;
    expect(task.url).toBe(
      `https://cloudtasks.googleapis.com/v2/projects/chalito-dev/locations/us-central1/queues/${QUEUE}/tasks`,
    );
    expect(task.body).toMatchObject({
      task: {
        scheduleTime: new Date(NOON_MX + 5 * MIN).toISOString(),
        httpRequest: {
          url: `${BASE}/tasks/tick`,
          oidcToken: { serviceAccountEmail: TASKS_SA, audience: `${BASE}/tasks/tick` },
        },
      },
    });
    // The desktop sees it through the notification row.
    expect(h.store.notifications.get(`${UID}/n1`)).toMatchObject({
      level: "L1",
      state: "pending",
      source: "session_question",
    });

    await drive(h);

    expect(cap.push).toHaveLength(4); // 0 and +5, two subscriptions each
    expect(cap.whatsapp).toHaveLength(1);
    expect(cap.whatsapp[0]!.url).toBe("https://graph.facebook.com/v26.0/1234567890/messages");
    expect(cap.whatsapp[0]!.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+525512345678",
      type: "template",
      template: {
        name: "chalito_pendientes_v1",
        language: { code: "es_MX" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "1" },
              { type: "text", text: "preguntas de agentes" },
              { type: "text", text: "alta" },
            ],
          },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "n1" }] },
          {
            type: "button",
            sub_type: "quick_reply",
            index: "1",
            parameters: [{ type: "payload", payload: "chalito_optout" }],
          },
        ],
      },
    });

    expect(cap.calls).toHaveLength(1);
    const call = cap.calls[0]!;
    expect(call.To).toBe("+525512345678");
    expect(call.From).toBe("+14155550100");
    expect(call.StatusCallback).toBe(`${BASE}/webhooks/twilio/status`);
    expect(call.Twiml).toContain(
      `<Gather input="dtmf speech" language="es-MX" numDigits="1" speechTimeout="auto" actionOnEmptyResult="true" method="POST" action="${BASE}/webhooks/twilio/gather?uid=hub-user-1&amp;nid=n1&amp;lang=es">`,
    );
    expect(call.Twiml).toContain(
      '<Say voice="Polly.Mia-Neural" language="es-MX">Hola, habla Chalito. Tienes 1 agente en espera',
    );
    expect(call.Twiml).not.toContain("speechModel");

    expect(cap.sms).toHaveLength(1);
    expect(cap.sms[0]!.Body).toBe(
      "Chalito: tienes 1 pendientes en tu cuenta (preguntas de agentes). Urgencia: alta. Ábrelos en la app: https://chalito.chalyb.com/n/n1",
    );
    expect(h.store.ladders.get(UID)![0]!.state).toBe("done");
  });

  it("the call briefing XML-escapes labels and reads call lines only when call briefing is on", async () => {
    for (const enabled of [true, false]) {
      cap.calls.length = 0;
      const h = withUser();
      h.store.calls.set(UID, {
        callBriefingEnabled: enabled,
        items: [{ deviceLabel: "Lap <top> & co", sessionLabel: 'API "pagos"', line: "¿Corro las migraciones?" }],
      });
      await h.publish({ v: 1, type: "notify", uid: UID, item: item() });
      await drive(h);
      const twiml = cap.calls[0]!.Twiml!;
      expect(twiml).toContain("Lap &lt;top&gt; &amp; co");
      expect(twiml).toContain("API &quot;pagos&quot;");
      if (enabled) expect(twiml).toContain("¿Corro las migraciones?");
      else expect(twiml).not.toContain("migraciones");
    }
  });
});

describe("no content in outbound payloads", () => {
  it("smuggled text never reaches push, WhatsApp, SMS or the call", async () => {
    const h = withUser();
    await h.publish({
      v: 1,
      type: "notify",
      uid: UID,
      item: { ...item({ coalesceKey: `session:${SECRET}` }), title: SECRET, body: SECRET, line: SECRET },
    });
    await drive(h);
    const outbound = JSON.stringify([h.pushed, cap.whatsapp, cap.sms, cap.calls]);
    expect(cap.whatsapp.length * cap.sms.length * cap.calls.length * h.pushed.length).toBeGreaterThan(0);
    expect(outbound).not.toContain("SECRET");
    for (const p of h.pushed)
      expect(
        Object.keys(p).every((k) =>
          ["nid", "level", "source", "urgency", "counts", "total", "deepLink", "notice"].includes(k),
        ),
      ).toBe(true);
  });
});

describe("caps and quiet hours, end to end", () => {
  it("never more than 3 calls in a local day", async () => {
    const h = withUser();
    for (let i = 0; i < 4; i++) {
      h.setClock(NOON_MX + i * 60 * MIN);
      await h.publish({
        v: 1,
        type: "notify",
        uid: UID,
        item: item({ nid: `n${i}`, coalesceKey: `k${i}`, createdAt: NOON_MX + i * 60 * MIN }),
      });
      await drive(h, NOON_MX + (i + 1) * 60 * MIN - 1);
    }
    expect(cap.calls).toHaveLength(3);
    expect(
      h.logs.some((l) => l.msg === "notifier.suppressed" && l.meta?.channel === "call" && l.meta?.reason === "cap"),
    ).toBe(true);
  });

  it("nothing reaches the phone during quiet hours; the ladder resumes at 07:00", async () => {
    const h = withUser();
    const night = Date.UTC(2026, 9, 6, 5, 30); // 23:30 in Mexico City
    const seven = Date.UTC(2026, 9, 6, 13, 0);
    h.setClock(night);
    await h.publish({ v: 1, type: "notify", uid: UID, item: item({ level: "L3", createdAt: night }) });
    expect(cap.push).toHaveLength(0);
    expect(cap.tasks[0]!.body).toMatchObject({ task: { scheduleTime: new Date(seven).toISOString() } });
    await drive(h, seven + 60 * MIN);
    expect(cap.push.length).toBeGreaterThan(0);
    expect(cap.calls).toHaveLength(0);
    expect(cap.whatsapp).toHaveLength(1);
  });
});

describe("webhooks", () => {
  const twilioPost = async (
    h: ReturnType<typeof setup>,
    path: string,
    params: Record<string, string>,
    signWith = path,
  ) =>
    h.app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": twilioSignature("twilio-auth-token-test", `${BASE}${signWith}`, params),
      },
      body: new URLSearchParams(params).toString(),
    });
  const metaPost = (h: ReturnType<typeof setup>, payload: unknown, secret = "meta-app-secret-test") => {
    const raw = JSON.stringify(payload);
    return h.app.request("/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": metaSignature(secret, raw) },
      body: raw,
    });
  };
  const waMessage = (from: string, m: Record<string, unknown>) => ({
    entry: [{ changes: [{ value: { messages: [{ from, ...m }] } }] }],
  });

  it("Twilio: DTMF 2 snoozes, 1 connects over SIP, 3 dismisses; forged or tampered requests are refused", async () => {
    const h = withUser();
    await h.publish({ v: 1, type: "notify", uid: UID, item: item() });
    const path = "/webhooks/twilio/gather?uid=hub-user-1&nid=n1&lang=es";

    const snooze = await twilioPost(h, path, { CallSid: `CA${"a".repeat(32)}`, Digits: "2" });
    expect(snooze.status).toBe(200);
    expect(await snooze.text()).toContain("Te llamo más tarde.");
    expect(h.store.ladders.get(UID)![0]!.state).toBe("snoozed");

    const connect = await twilioPost(h, path, { CallSid: `CA${"a".repeat(32)}`, Digits: "1" });
    expect(await connect.text()).toMatch(
      /<Dial><Sip>sip:proj_test@sip\.api\.openai\.com;transport=tls;secure=true\?X-Chalito-Ref=[\w-]+\.[\w-]+<\/Sip><\/Dial>/,
    );
    expect(h.store.ladders.get(UID)![0]).toMatchObject({ state: "acked", ackedVia: "call" });

    const forged = await h.app.request(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": "AAAA" },
      body: "Digits=3",
    });
    expect(forged.status).toBe(403);
    // A valid signature for one URL doesn't carry over to another nid.
    const tampered = await twilioPost(
      h,
      "/webhooks/twilio/gather?uid=hub-user-1&nid=n2&lang=es",
      { Digits: "3" },
      path,
    );
    expect(tampered.status).toBe(403);
  });

  it("Twilio SMS: STOP opts out, any other reply acknowledges everything", async () => {
    const h = withUser();
    await h.publish({ v: 1, type: "notify", uid: UID, item: item() });
    expect((await twilioPost(h, "/webhooks/twilio/sms", { From: "+525512345678", Body: "ok" })).status).toBe(200);
    expect(h.store.ladders.get(UID)![0]!.state).toBe("acked");
    await twilioPost(h, "/webhooks/twilio/sms", { From: "+525512345678", Body: "STOP" });
    expect(h.store.optOuts).toEqual([{ uid: UID, channel: "sms" }]);
  });

  it("WhatsApp: a reply acknowledges (ack anywhere, MX 521 numbers mapped), the quick reply opts out, forgeries are refused", async () => {
    const h = withUser();
    await h.publish({ v: 1, type: "notify", uid: UID, item: item() });
    expect((await metaPost(h, waMessage("5215512345678", { type: "text", text: { body: "ya voy" } }))).status).toBe(
      200,
    );
    expect(h.store.ladders.get(UID)![0]).toMatchObject({ state: "acked", ackedVia: "whatsapp" });
    expect(cap.tasks.some((t) => t.method === "DELETE")).toBe(true);

    await metaPost(
      h,
      waMessage("5215512345678", { type: "button", button: { payload: "chalito_optout", text: "Dejar de recibir" } }),
    );
    expect(h.store.optOuts).toEqual([{ uid: UID, channel: "whatsapp" }]);
    expect(h.store.prefs.get(UID)!.whatsapp).toEqual({ optIn: false });

    expect((await metaPost(h, waMessage("5215512345678", { type: "text" }), "wrong-secret")).status).toBe(403);
    expect(h.store.optOuts).toHaveLength(1);
  });

  it("WhatsApp verification handshake", async () => {
    const h = setup();
    const ok = await h.app.request(
      "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=meta-verify&hub.challenge=12345",
    );
    expect(await ok.text()).toBe("12345");
    expect(
      (await h.app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1")).status,
    ).toBe(403);
  });

  it("after an ack, later ticks send nothing", async () => {
    const h = withUser();
    await h.publish({ v: 1, type: "notify", uid: UID, item: item() });
    await h.publish({ v: 1, type: "ack", uid: UID, via: "app", nid: "n1" });
    const before = cap.push.length;
    h.setClock(NOON_MX + 30 * MIN);
    await h.tick(UID, "n1");
    expect(cap.push.length).toBe(before);
    expect(cap.whatsapp.length + cap.calls.length + cap.sms.length).toBe(0);
  });
});

describe("push subscriptions", () => {
  it("a 410 from the push service deletes the subscription", async () => {
    const h = withUser();
    goneEndpoints.add("https://push.example.test/b");
    await h.publish({ v: 1, type: "notify", uid: UID, item: item({ level: "L1" }) });
    expect(h.store.subs.get(UID)!.map((s) => s.endpoint)).toEqual(["https://push.example.test/a"]);
  });

  it("room events arrive as an L1 nudge", async () => {
    const h = withUser();
    await h.publish({ v: 1, uid: UID, roomId: "r1", eid: "e1", createdAt: NOON_MX }, "/pubsub/room-events");
    expect(h.pushed).toHaveLength(2); // one per subscription
    for (const p of h.pushed) expect(p).toMatchObject({ source: "room_event", level: "L1", deepLink: "/r/r1" });
  });
});

describe("speech on a call", () => {
  it("can only become a call:<CallSid> RelayedCommand (a prompt), never a Decision", async () => {
    const h = setup();
    const agent = await generateBoxKeyPair();
    h.store.boxKeys.set(`${UID}/dev_agent`, await toB64url(agent.publicKey));
    const callSid = `CA${"b".repeat(32)}`;
    const env = await relaySpokenAnswer(h.store, {
      uid: UID,
      callSid,
      targetDeviceId: "dev_agent",
      sid: "s1",
      text: "sí, córrelas",
      now: NOON_MX,
    });
    expect(RelayedCommand.safeParse(env).success).toBe(true);
    expect(SignedCommand.safeParse(env).success).toBe(false);
    expect(env.body.origin).toBe(`call:${callSid}`);
    expect(env.body.payload.type).toBe("session.prompt");
    expect(JSON.stringify(env)).not.toContain("córrelas"); // sealed for the agent
    expect(h.store.commands).toHaveLength(1);
    // And nothing in the notifier can produce or sign a decision.
    for (const f of readdirSync(new URL("../src/", import.meta.url), { recursive: true }) as string[]) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
      expect(src).not.toMatch(/chalito\.decision|DecisionBody|signEnvelope|approval_decisions/);
    }
  });
});
