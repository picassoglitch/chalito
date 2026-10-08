import { createHash } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openaiRealtime } from "@chalito/adapters/voice";
import { loadModels } from "@chalito/config";
import type { DeviceDoc } from "@chalito/protocol";
import { createApp } from "../src/app.js";
import { MemoryAudit } from "../src/deps.js";
import type { ApiRepo, IdentityIssuer } from "../src/repo.js";
import { HubClient, HubStreamUsage, MemoryVoiceSessions } from "@chalito/billing";
import { loadPrices } from "@chalito/config";
import type { HubUsage } from "../src/voice/hub.js";
import type { VoiceDeps } from "../src/voice/routes.js";
import { DESKTOP_TOOLS } from "../src/voice/tools.js";

/** OpenAI client_secrets and the Chalyb hub, mocked at the HTTP layer. */
const minted: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
const hubCalls: { path: string; body: Record<string, unknown> }[] = [];
let hubRemaining = 50_000;
const RID = "33333333-3333-4333-8333-333333333333";
const server = setupServer(
  http.post("https://www.chalyb.com/api/engines/chalito/usage/admit", async ({ request }) => {
    hubCalls.push({ path: "admit", body: (await request.json()) as Record<string, unknown> });
    return HttpResponse.json(
      hubRemaining > 0
        ? {
            ok: true,
            allowed: true,
            reservation_id: RID,
            lane: "standard",
            boost_fee_tokens: 0,
            limits: {},
            balance: {
              remaining: hubRemaining,
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
  http.post("https://www.chalyb.com/api/engines/chalito/usage/settle", async ({ request }) => {
    hubCalls.push({ path: "settle", body: (await request.json()) as Record<string, unknown> });
    return HttpResponse.json({ ok: true });
  }),
  // The api-proxied WebRTC call (unified interface) and its server-side hang-up.
  http.post("https://api.openai.com/v1/realtime/calls", async ({ request }) => {
    const form = await request.formData();
    minted.push({
      body: { sdp: form.get("sdp"), session: JSON.parse(String(form.get("session"))) },
      headers: Object.fromEntries(request.headers.entries()),
    });
    return new HttpResponse("v=0\r\nanswer-sdp", {
      status: 201,
      headers: { location: `/v1/realtime/calls/rtc_call${minted.length}`, "content-type": "application/sdp" },
    });
  }),
  http.post("https://api.openai.com/v1/realtime/calls/:id/hangup", ({ params }) => {
    hungUp.push(String(params.id));
    return HttpResponse.json({});
  }),
);
const hungUp: string[] = [];
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  minted.length = 0;
  hungUp.length = 0;
  hubCalls.length = 0;
  hubRemaining = 50_000;
});

/** A clock the tests move: the server's view of time is what gets billed (R-H6). */
const T0 = 1_790_000_000_000;
let clock = T0;
beforeEach(() => void (clock = T0));

let callSdp: (voiceToken: string, token: string) => Promise<{ status: number; json: Record<string, unknown> }>;

/** The real hub-backed stream usage. */
const realHub = () => {
  const hub = new HubStreamUsage({
    hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "chalito-admin-token" }),
    prices: loadPrices(),
    model: "gpt-realtime-2.1-mini",
    reserveBasis: "pre_margin",
    now: () => clock,
  });
  return { hub };
};

const device = (deviceId: string, role: DeviceDoc["role"], revoked = false) =>
  ({ deviceId, role, revoked }) as DeviceDoc;

const setup = (hub: HubUsage = realHub().hub, cap?: VoiceDeps["cap"], maxSessionSec?: number) => {
  const sessions = new MemoryVoiceSessions();
  const devices = new Map([
    ["dev_phone", device("dev_phone", "client")],
    ["dev_agent", device("dev_agent", "agent")],
    ["dev_old", device("dev_old", "client", true)],
  ]);
  // Bearer "<role>:<deviceId>" in these tests.
  const identity = {
    verify: async (token: string) => {
      const [role, deviceId] = token.split(":");
      return { uid: `d_${deviceId}`, role, owner: "hub-user-1", ...(deviceId ? { deviceId } : {}) };
    },
    disableDevice: async () => undefined,
  } as unknown as IdentityIssuer;
  const repo = {
    getDevice: async (_o: string, id: string) => devices.get(id) ?? null,
    revokeDevice: async (_o: string, id: string) => {
      const d = devices.get(id);
      if (!d) return "not_found";
      devices.set(id, { ...d, revoked: true });
      return "revoked";
    },
  } as unknown as ApiRepo;
  const app = createApp({
    repo,
    identity,
    audit: new MemoryAudit(),
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: () => clock,
    voice: {
      sessions,
      ...(maxSessionSec ? { maxSessionSec } : {}),
      provider: openaiRealtime({ apiKey: "sk-test" }),
      hub,
      model: loadModels().voice.desktop.model,
      voiceName: "marin",
      tokenSecret: "voice-token-secret",
      ...(cap ? { cap } : {}),
    },
  });
  const call = async (path: string, token: string, body: unknown = {}) => {
    const res = await app.request(`/v1/voice${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  /** POST /session then /session/sdp: the call connected through the api. */
  const connect = async (token = "client:dev_phone") => {
    const s = await call("/session", token);
    const voiceToken = String(s.json.voiceToken);
    const res = await app.request("/v1/voice/session/sdp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ voiceToken, sdp: "v=0\r\noffer-sdp" }),
    });
    return {
      session: s,
      voiceToken,
      status: res.status,
      answer: await res.text(),
      type: res.headers.get("content-type"),
    };
  };
  callSdp = async (voiceToken, token) => {
    const res = await app.request("/v1/voice/session/sdp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ voiceToken, sdp: "v=0\r\noffer-sdp" }),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const revoke = (by: string, deviceId: string) =>
    app.request("/v1/devices/revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${by}`, "content-type": "application/json" },
      body: JSON.stringify({ deviceId }),
    });
  return { call, connect, revoke, hub, sessions };
};

describe("POST /v1/voice/session (desktop push-to-talk)", () => {
  it("an active device connects through the api: OpenAI gets its offer with the server key; no credential reaches it", async () => {
    const { connect, sessions } = setup();
    const c = await connect("agent:dev_agent");
    expect(c.session.status).toBe(201);
    expect(c.session.json).toMatchObject({ expiresAt: T0 + 60_000, model: "gpt-realtime-2.1-mini" });
    expect(c.session.json.clientSecret).toBeUndefined();
    expect(c).toMatchObject({ status: 201, answer: "v=0\r\nanswer-sdp", type: "application/sdp" });
    expect(minted).toHaveLength(1);
    const { body, headers } = minted[0]!;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(headers["openai-safety-identifier"]).toBe(createHash("sha256").update("chalito:hub-user-1").digest("hex"));
    expect(body.sdp).toBe("v=0\r\noffer-sdp");
    // The call id stays on the server.
    expect([...sessions.sessions.values()][0]!.callId).toBe("rtc_call1");
    expect(JSON.stringify(c)).not.toContain("rtc_call1");
    expect(body.session).toMatchObject({
      type: "realtime",
      model: "gpt-realtime-2.1-mini",
      audio: { output: { voice: "marin" } },
    });
    expect((body.session as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual([
      "route_to",
      "open_approval",
      "mesa_say",
      "snooze",
      "room_say",
    ]);
  });

  it("is refused for revoked devices, web sessions and when the hub doesn't admit; OpenAI is never called", async () => {
    const { call } = setup();
    expect(await call("/session", "client:dev_old")).toMatchObject({ status: 403, json: { error: "device_revoked" } });
    expect((await call("/session", "user")).status).toBe(403);
    expect((await call("/session", "client:dev_unknown")).status).toBe(403);
    const refusing: HubUsage = {
      admit: async () => ({ admitted: false, reason: "insufficient_balance" }),
      event: () => null,
      keepAlive: async () => ({ continue: false }),
      settle: async () => {},
    };
    expect(await setup(refusing).call("/session", "client:dev_phone")).toMatchObject({
      status: 402,
      json: { error: "voice_not_admitted" },
    });
    expect(minted).toEqual([]);
  });

  it("bills the time the server observes, not what the client reports; retries never double-bill; end settles", async () => {
    const { call, sessions } = setup();
    const { json } = await call("/session", "client:dev_phone");
    expect(json.maxSeconds).toBe(30 * 60);
    const voiceToken = String(json.voiceToken);
    clock += 30_000;
    // A modified client reports 0 s: it's billed 30 s anyway.
    expect(await call("/session/heartbeat", "client:dev_phone", { voiceToken, seconds: 0 })).toEqual({
      status: 200,
      json: { ok: true, continue: true, billedSeconds: 30 },
    });
    // The same heartbeat retried: no new event.
    expect((await call("/session/heartbeat", "client:dev_phone", { voiceToken, seconds: 0 })).json.billedSeconds).toBe(
      30,
    );
    expect((await call("/session/heartbeat", "client:dev_phone", { voiceToken, seconds: 3600 })).status).toBe(400);
    expect(await call("/session/heartbeat", "agent:dev_agent", { voiceToken, seconds: 30 })).toMatchObject({
      status: 403,
      json: { error: "bad_voice_token" },
    });
    expect(
      (await call("/session/heartbeat", "client:dev_phone", { voiceToken: `${voiceToken}x`, seconds: 30 })).status,
    ).toBe(403);
    clock += 12_000;
    expect(await call("/session/end", "client:dev_phone", { voiceToken, seconds: 0 })).toEqual({
      status: 200,
      json: { ok: true, continue: false, billedSeconds: 42 },
    });
    // Each increment is a priced voice.seconds event, tied to the reservation, keyed by its total.
    expect(
      sessions.events.map((e) => [e.kind, e.amount, e.cost_usd_micros, e.reservation_id, e.source_id.split(":")[1]]),
    ).toEqual([
      ["voice.seconds", 30, 15_000, RID, "30"],
      ["voice.seconds", 12, 6_000, RID, "42"],
    ]);
    expect(hubCalls.filter((c) => c.path === "settle").map((c) => c.body.outcome)).toEqual([
      "heartbeat",
      "heartbeat",
      "succeeded",
    ]);
    expect(hubCalls[0]!.body).toMatchObject({
      external_user_id: "hub-user-1",
      class: "stream",
      operation: "voice.session",
    });
  });

  it("one open session per owner; one never ended is billed in full before the next can start", async () => {
    const { call, sessions } = setup(realHub().hub, undefined, 60);
    const first = await call("/session", "client:dev_phone");
    expect(first.status).toBe(201);
    expect(await call("/session", "client:dev_phone")).toMatchObject({
      status: 409,
      json: { error: "voice_session_open" },
    });
    // The client vanishes without heartbeats or an end; past max + grace the next session sweeps it.
    clock += 60_000 + 121_000;
    expect((await call("/session", "client:dev_phone")).status).toBe(201);
    expect(sessions.events.map((e) => e.amount)).toEqual([60]);
  });

  it("a session stops at its maximum, and billing never passes it", async () => {
    const { call, sessions } = setup(realHub().hub, undefined, 60);
    const voiceToken = String((await call("/session", "client:dev_phone")).json.voiceToken);
    clock += 70_000;
    expect((await call("/session/heartbeat", "client:dev_phone", { voiceToken, seconds: 30 })).json).toEqual({
      ok: true,
      continue: false,
      reason: "max",
      billedSeconds: 60,
    });
    clock += 600_000;
    expect((await call("/session/end", "client:dev_phone", { voiceToken, seconds: 30 })).json.billedSeconds).toBe(60);
    expect(sessions.events.map((e) => e.amount)).toEqual([60]);
  });

  it("no desktop tool decides anything: open_approval only opens the app", () => {
    expect(JSON.stringify(DESKTOP_TOOLS)).not.toMatch(/"name":"(approve|deny|decide|decision)/i);
    expect(DESKTOP_TOOLS.find((t) => t.name === "open_approval")!.description).toMatch(/sign it there/);
  });

  it("stops the stream when the hub balance runs out, and refuses new sessions with no tokens", async () => {
    const { call } = setup();
    const { json } = await call("/session", "client:dev_phone");
    hubRemaining = 0;
    clock += 30_000;
    expect(
      await call("/session/heartbeat", "client:dev_phone", { voiceToken: String(json.voiceToken), seconds: 30 }),
    ).toEqual({
      status: 200,
      json: { ok: true, continue: false, reason: "stopped", billedSeconds: 30 },
    });
    clock += 31 * 60_000 + 121_000;
    expect(await call("/session", "client:dev_phone")).toMatchObject({
      status: 402,
      json: { error: "voice_not_admitted", message: "no_tokens" },
    });
  });

  it("monthly voice minutes: a session can't outrun the cap, none starts at it (with a note), a stream stops at it", async () => {
    let used = 120 * 60 - 10;
    const notes: string[] = [];
    const cap = {
      status: async () => ({ limitSeconds: 120 * 60, usedSeconds: used }),
      note: async (owner: string) => void notes.push(owner),
    };
    const { call } = setup(realHub().hub, cap);
    const { json } = await call("/session", "client:dev_phone");
    // Only the 10 s left this month.
    expect(json.maxSeconds).toBe(10);
    clock += 5_000;
    expect(
      (await call("/session/heartbeat", "client:dev_phone", { voiceToken: String(json.voiceToken), seconds: 5 })).json,
    ).toEqual({ ok: true, continue: true, billedSeconds: 5 });
    used = 120 * 60;
    clock += 5_000;
    expect(
      (await call("/session/heartbeat", "client:dev_phone", { voiceToken: String(json.voiceToken), seconds: 10 })).json,
    ).toEqual({ ok: true, continue: false, reason: "cap", billedSeconds: 10 });
    await call("/session/end", "client:dev_phone", { voiceToken: String(json.voiceToken), seconds: 0 });
    expect(await call("/session", "client:dev_phone")).toMatchObject({
      status: 402,
      json: { error: "voice_cap_reached" },
    });
    expect(notes).toEqual(["hub-user-1", "hub-user-1"]);
  });
});

describe("the api ends the call itself (SDP proxy, R-H6 follow-up)", () => {
  it("at the monthly cap: a client that ignores `continue: false` is hung up server-side", async () => {
    let used = 120 * 60 - 10;
    const cap = { status: async () => ({ limitSeconds: 120 * 60, usedSeconds: used }), note: async () => undefined };
    const { call, connect } = setup(realHub().hub, cap);
    const c = await connect();
    used = 120 * 60;
    clock += 10_000;
    expect(
      (await call("/session/heartbeat", "client:dev_phone", { voiceToken: c.voiceToken, seconds: 10 })).json,
    ).toMatchObject({
      continue: false,
      reason: "cap",
    });
    expect(hungUp).toEqual(["rtc_call1"]);
  });

  it("at the session's maximum and on end", async () => {
    const max = setup(realHub().hub, undefined, 60);
    const c = await max.connect();
    clock += 70_000;
    await max.call("/session/heartbeat", "client:dev_phone", { voiceToken: c.voiceToken, seconds: 30 });
    expect(hungUp).toEqual(["rtc_call1"]);
    hungUp.length = 0;
    const e = setup();
    const c2 = await e.connect();
    await e.call("/session/end", "client:dev_phone", { voiceToken: c2.voiceToken, seconds: 0 });
    expect(hungUp).toEqual(["rtc_call2"]);
  });

  it("revoking the device bills the elapsed time, closes the session and hangs up", async () => {
    const { connect, revoke, sessions } = setup();
    await connect("agent:dev_agent");
    clock += 25_000;
    expect((await revoke("client:dev_phone", "dev_agent")).status).toBe(200);
    expect(hungUp).toEqual(["rtc_call1"]);
    const s = [...sessions.sessions.values()][0]!;
    expect(s.endedAt).toBe(clock);
    expect(sessions.events.map((e) => e.amount)).toEqual([25]);
  });

  it("revoking a device also hangs up the owner's live phone call (its OpenAI leg; the notifier bills it)", async () => {
    const { revoke, sessions } = setup();
    await sessions.open({
      sourceId: "voice_call1",
      owner: "hub-user-1",
      channel: "call",
      deviceId: `CA${"c".repeat(32)}`,
      reservationId: "r_call",
      model: "gpt-realtime-2.1-mini",
      startedAt: clock,
      maxSeconds: 900,
    });
    await sessions.setCallId("hub-user-1", "voice_call1", "rtc_phone");
    expect((await revoke("client:dev_phone", "dev_agent")).status).toBe(200);
    expect(hungUp).toEqual(["rtc_phone"]);
    expect(sessions.sessions.get("voice_call1")!.endedAt).toBeNull();
    expect(sessions.events).toEqual([]);
  });

  it("the api's sweep leaves a stale phone-call session to the notifier (call pricing lives there)", async () => {
    const { call, sessions } = setup();
    await sessions.open({
      sourceId: "voice_call_stale",
      owner: "hub-user-1",
      channel: "call",
      deviceId: `CA${"d".repeat(32)}`,
      reservationId: "r_call",
      model: "gpt-realtime-2.1-mini",
      startedAt: clock,
      maxSeconds: 60,
    });
    await sessions.setCallId("hub-user-1", "voice_call_stale", "rtc_phone_stale");
    clock += 60_000 + 121_000;
    expect((await call("/session", "client:dev_phone")).status).toBe(201);
    expect(sessions.sessions.get("voice_call_stale")).toMatchObject({ endedAt: null, billedSeconds: 0 });
    expect(sessions.events).toEqual([]);
    expect(hungUp).toEqual([]);
  });

  it("the stale sweep hangs up a call that was never ended", async () => {
    const { connect, call } = setup(realHub().hub, undefined, 60);
    await connect();
    clock += 60_000 + 121_000;
    expect((await call("/session", "client:dev_phone")).status).toBe(201);
    expect(hungUp).toEqual(["rtc_call1"]);
  });

  it("one call per session, connected soon after minting, only with the device's own token", async () => {
    const { call, connect } = setup();
    const c = await connect();
    const again = await callSdp(c.voiceToken, "client:dev_phone");
    expect([again.status, again.json.error]).toEqual([409, "voice_call_connected"]);
    expect((await callSdp(c.voiceToken, "agent:dev_agent")).status).toBe(403);
    expect(minted).toHaveLength(1);
    await call("/session/end", "client:dev_phone", { voiceToken: c.voiceToken, seconds: 0 });
    // A fresh session whose connect comes too late (past the 60 s window): refused.
    const late = await call("/session", "client:dev_phone");
    clock += 61_000;
    const tooLate = await callSdp(String(late.json.voiceToken), "client:dev_phone");
    expect([tooLate.status, tooLate.json.error]).toEqual([410, "voice_connect_expired"]);
  });
});

describe("hub and OpenAI failures are answers, never a 500", () => {
  it("admit failing → 503; keep-alive failing → 503 (time still billed); settle failing on end → 200", async () => {
    const down: HubUsage = {
      admit: async () => {
        throw new Error("fetch failed");
      },
      event: () => null,
      keepAlive: async () => ({ continue: true }),
      settle: async () => {},
    };
    expect(await setup(down).call("/session", "client:dev_phone")).toMatchObject({
      status: 503,
      json: { error: "hub_unavailable" },
    });

    const flaky: HubUsage = {
      admit: async () => ({ admitted: true, admissionId: RID }),
      event: () => null,
      keepAlive: async () => {
        throw new Error("fetch failed");
      },
      settle: async () => {
        throw new Error("fetch failed");
      },
    };
    const { call } = setup(flaky);
    const voiceToken = String((await call("/session", "client:dev_phone")).json.voiceToken);
    clock += 30_000;
    expect(await call("/session/heartbeat", "client:dev_phone", { voiceToken, seconds: 30 })).toMatchObject({
      status: 503,
      json: { error: "hub_unavailable" },
    });
    expect(await call("/session/end", "client:dev_phone", { voiceToken, seconds: 0 })).toMatchObject({
      status: 200,
      json: { ok: true, continue: false, billedSeconds: 30 },
    });
  });

  it("OpenAI refusing the offer → 502, and the session may try again", async () => {
    const { call } = setup();
    const voiceToken = String((await call("/session", "client:dev_phone")).json.voiceToken);
    server.use(
      http.post("https://api.openai.com/v1/realtime/calls", () => HttpResponse.json({ error: {} }, { status: 500 }), {
        once: true,
      }),
    );
    expect(await callSdp(voiceToken, "client:dev_phone")).toMatchObject({
      status: 502,
      json: { error: "voice_provider_failed" },
    });
    expect((await callSdp(voiceToken, "client:dev_phone")).status).toBe(201);
  });
});
