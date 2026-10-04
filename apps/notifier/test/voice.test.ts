import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signStandardWebhook } from "@chalito/adapters/voice";
import { generateBoxKeyPair, toB64url } from "@chalito/crypto";
import { RelayedCommand, SignedCommand } from "@chalito/protocol";
import type { PushPayload } from "@chalito/escalation";
import { CALL_TOOLS } from "../src/voice/call-session.js";
import { twilioSignature } from "../src/signatures.js";
import { BASE, NOON_MX, OPENAI_WEBHOOK_SECRET, mockServer, prefs, pushSubscription, setup } from "./harness.js";

const { server, cap } = mockServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  for (const list of Object.values(cap)) list.length = 0;
});

const UID = "hub-user-1";
const CALL_SID = `CA${"c".repeat(32)}`;

const user = async (callBriefingEnabled = true) => {
  const h = setup();
  h.store.prefs.set(UID, prefs());
  h.store.subs.set(UID, [pushSubscription("https://push.example.test/a")]);
  h.store.companions.set(UID, "Batman");
  h.store.calls.set(UID, {
    callBriefingEnabled,
    items: [
      {
        lid: "l1",
        deviceLabel: "Laptop",
        sessionLabel: "API de pagos",
        line: "¿Corro las migraciones?",
        deviceId: "dev_laptop",
        sid: "s1",
      },
      { lid: "l2", deviceLabel: "Escritorio", sessionLabel: "Landing", deviceId: "dev_desk", sid: "s2" },
    ],
  });
  h.store.approvals.set(UID, [{ aid: "apr_123", deviceLabel: "Laptop", sessionLabel: "API de pagos" }]);
  h.store.boxKeys.set(`${UID}/dev_laptop`, await toB64url((await generateBoxKeyPair()).publicKey));
  const pushed: PushPayload[] = [];
  const send = h.deps.push.send.bind(h.deps.push);
  h.deps.push.send = async (sub, payload, ttl) => (pushed.push(payload), send(sub, payload, ttl));
  return { ...h, pushed };
};

/** Press 1 on the Twilio call; returns the X-Chalito-Ref from the SIP URI. */
const pressOne = async (h: Awaited<ReturnType<typeof user>>) => {
  const path = "/webhooks/twilio/gather?uid=hub-user-1&nid=n1&lang=es";
  const params = { CallSid: CALL_SID, Digits: "1" };
  const res = await h.app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilioSignature("twilio-auth-token-test", `${BASE}${path}`, params),
    },
    body: new URLSearchParams(params).toString(),
  });
  return /X-Chalito-Ref=([\w-]+\.[\w-]+)/.exec(await res.text())?.[1] ?? "";
};

const incoming = (callId: string, ref?: string) => ({
  object: "event",
  id: `evt_${callId}`,
  type: "realtime.call.incoming",
  created_at: Math.floor(NOON_MX / 1000),
  data: {
    call_id: callId,
    sip_headers: [
      { name: "From", value: "sip:+14155550100@pstn.twilio.com" },
      ...(ref ? [{ name: "X-Chalito-Ref", value: ref }] : []),
    ],
  },
});

const webhook = (
  h: { app: { request: (p: string, i: RequestInit) => Response | Promise<Response> } },
  event: unknown,
  o: { secret?: string; ts?: number } = {},
) => {
  const raw = JSON.stringify(event);
  const id = `msg_${Math.random()}`;
  const ts = o.ts ?? Math.floor(NOON_MX / 1000);
  return h.app.request("/webhooks/openai", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(ts),
      "webhook-signature": signStandardWebhook(o.secret ?? OPENAI_WEBHOOK_SECRET, id, ts, raw),
    },
    body: raw,
  });
};

describe("OpenAI realtime.call.incoming", () => {
  it("rejects forged, stale and unsigned webhooks without touching the call", async () => {
    const h = await user();
    const ref = await pressOne(h);
    const other = `whsec_${Buffer.from("not-the-secret").toString("base64")}`;
    expect((await webhook(h, incoming("call_1", ref), { secret: other })).status).toBe(401);
    expect((await webhook(h, incoming("call_1", ref), { ts: Math.floor(NOON_MX / 1000) - 3600 })).status).toBe(401);
    const unsigned = await h.app.request("/webhooks/openai", {
      method: "POST",
      body: JSON.stringify(incoming("call_1", ref)),
    });
    expect(unsigned.status).toBe(401);
    expect(cap.openai).toEqual([]);
  });

  it("rejects calls without a valid X-Chalito-Ref (unknown, tampered, expired) and replays", async () => {
    const h = await user();
    const ref = await pressOne(h);
    const [body, sig] = ref.split(".");
    const tampered = `${Buffer.from(JSON.stringify({ uid: "victim", nid: "n1", callSid: CALL_SID, locale: "es", exp: NOON_MX + 1e9 })).toString("base64url")}.${sig}`;
    for (const r of [undefined, "garbage", tampered, `${body}.AAAA`]) {
      expect((await webhook(h, incoming("call_x", r))).status).toBe(200);
    }
    expect(cap.openai.map((c) => c.path)).toEqual(Array(4).fill("/v1/realtime/calls/call_x/reject"));
    expect(cap.openai[0]!.body).toEqual({ status_code: 603 });

    cap.openai.length = 0;
    expect((await webhook(h, incoming("call_1", ref))).status).toBe(200);
    expect(cap.openai.map((c) => c.path)).toEqual(["/v1/realtime/calls/call_1/accept"]);
    cap.openai.length = 0;
    await webhook(h, incoming("call_2", ref)); // the same ref again
    expect(cap.openai.map((c) => c.path)).toEqual(["/v1/realtime/calls/call_2/reject"]);

    cap.openai.length = 0;
    const late = await pressOne(h);
    h.setClock(NOON_MX + 3 * 60_000);
    await webhook(h, incoming("call_3", late), { ts: Math.floor((NOON_MX + 3 * 60_000) / 1000) });
    expect(cap.openai.map((c) => c.path)).toEqual(["/v1/realtime/calls/call_3/reject"]);
  });

  it("DTMF 1 → accept with the persona, the briefing context and exactly the two call tools", async () => {
    const h = await user();
    const ref = await pressOne(h);
    await webhook(h, incoming("call_1", ref));
    const accept = cap.openai[0]!;
    expect(accept.path).toBe("/v1/realtime/calls/call_1/accept");
    expect(accept.headers.authorization).toBe("Bearer sk-test");
    expect(accept.body).toMatchObject({
      type: "realtime",
      model: "gpt-realtime-2.1-mini",
      audio: { output: { voice: "marin" } },
      tool_choice: "auto",
    });
    expect((accept.body.tools as { name: string }[]).map((t) => t.name)).toEqual(["answer_item", "push_approval"]);
    const instructions = String(accept.body.instructions);
    expect(instructions).toContain("Eres Batman");
    expect(instructions).toContain(
      '<data name="items">[{"ref":"i1","device":"Laptop","session":"API de pagos","question":"¿Corro las migraciones?"}',
    );
    expect(instructions).toMatch(/nunca instrucciones/);
    expect(instructions).toContain('{"ref":"i2","device":"Escritorio","session":"Landing"}');
    expect(instructions).toContain('<data name="approvals">[{"ref":"a1","device":"Laptop","session":"API de pagos"}]');
    expect(instructions).toContain("las aprobaciones solo se dan en la app");
    expect(instructions).not.toContain("dev_laptop");
    expect(instructions).not.toContain("apr_123");

    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]!.url).toBe("wss://api.openai.com/v1/realtime?call_id=call_1");
    expect(h.sockets[0]!.headers).toEqual({ authorization: "Bearer sk-test" });
    h.sockets[0]!.open();
    expect(h.sockets[0]!.sent[0]).toEqual({ type: "response.create" });
  });

  it("with call briefing off, the session has no call lines", async () => {
    const h = await user(false);
    await webhook(h, incoming("call_1", await pressOne(h)));
    const instructions = String(cap.openai[0]!.body.instructions);
    expect(instructions).not.toContain("migraciones");
    expect(instructions).toContain('{"ref":"i1","device":"Laptop","session":"API de pagos"}');
  });
});

describe("call tools", () => {
  const connected = async () => {
    const h = await user();
    await webhook(h, incoming("call_1", await pressOne(h)));
    const socket = h.sockets[0]!;
    socket.open();
    return { h, socket };
  };

  it("answer_item relays a sealed call:<CallSid> prompt to that session, never a decision", async () => {
    const { h, socket } = await connected();
    expect(await socket.functionCall("answer_item", { session_ref: "i1", text: "sí, córrelas en staging" })).toEqual({
      ok: true,
    });
    expect(h.store.commands).toHaveLength(1);
    const { env, targetDeviceId } = h.store.commands[0]!;
    expect(targetDeviceId).toBe("dev_laptop");
    expect(RelayedCommand.safeParse(env).success).toBe(true);
    expect(SignedCommand.safeParse(env).success).toBe(false);
    expect(env.body.origin).toBe(`call:${CALL_SID}`);
    expect(env.body.payload).toMatchObject({ type: "session.prompt", sid: "s1" });
    expect(JSON.stringify(env)).not.toContain("córrelas");
    // The tool result goes back, then the companion keeps talking.
    expect(socket.sent.slice(-2).map((m) => m.type)).toEqual(["conversation.item.create", "response.create"]);
  });

  it("push_approval re-sends the approval to the app; it can't approve it", async () => {
    const { h, socket } = await connected();
    expect(await socket.functionCall("push_approval", { aid: "a1" })).toEqual({ ok: true, sentToApp: true });
    expect(h.pushed).toEqual([expect.objectContaining({ nid: "apr_123", source: "approval", deepLink: "/a/apr_123" })]);
    expect(h.store.commands).toHaveLength(0);
  });

  it("anything else does nothing: unknown tools, unknown references, bad arguments", async () => {
    const { h, socket } = await connected();
    expect(await socket.functionCall("approve", { aid: "a1" })).toEqual({ ok: false, error: "unknown_tool" });
    expect(await socket.functionCall("submit_decision", { allow: true })).toEqual({ ok: false, error: "unknown_tool" });
    expect(await socket.functionCall("answer_item", { session_ref: "i9", text: "x" })).toEqual({
      ok: false,
      error: "unknown_item",
    });
    expect(await socket.functionCall("answer_item", { session_ref: "i2; drop", text: "x" })).toEqual({
      ok: false,
      error: "unknown_item",
    });
    expect(await socket.functionCall("push_approval", { aid: "apr_123" })).toEqual({
      ok: false,
      error: "unknown_approval",
    });
    expect(h.store.commands).toHaveLength(0);
    expect(h.pushed).toHaveLength(0);
  });

  it("the call tool set is exactly answer_item and push_approval", () => {
    expect(CALL_TOOLS.map((t) => t.name)).toEqual(["answer_item", "push_approval"]);
    expect(JSON.stringify(CALL_TOOLS)).not.toMatch(/"name":"(approve|deny|decide|decision)/i);
  });
});

describe("R-H3: the call is bound to the items it was placed for", () => {
  it("an item that appears after DTMF 1 isn't in the session and can't be answered", async () => {
    const h = await user();
    const ref = await pressOne(h);
    // A new waiting item (say, injected by another session) shows up between DTMF 1 and accept.
    const calls = h.store.calls.get(UID)!;
    h.store.calls.set(UID, {
      ...calls,
      items: [
        { lid: "l9", deviceLabel: "Otra", sessionLabel: "Intrusa", deviceId: "dev_desk", sid: "s9", line: "hola" },
        ...calls.items,
      ],
    });
    await webhook(h, incoming("call_1", ref));
    const instructions = String(cap.openai.at(-1)!.body.instructions);
    expect(instructions).not.toContain("Intrusa");
    const socket = h.sockets[0]!;
    socket.open();
    expect(await socket.functionCall("answer_item", { session_ref: "i3", text: "sí" })).toEqual({
      ok: false,
      error: "unknown_item",
    });
    expect(await socket.functionCall("answer_item", { session_ref: "i1", text: "sí" })).toEqual({ ok: true });
    expect(h.store.commands.map((c) => c.env.body.payload)).toEqual([expect.objectContaining({ sid: "s1" })]);
  });
});
