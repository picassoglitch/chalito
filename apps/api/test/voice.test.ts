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
import { HubClient, HubStreamUsage, MemoryOutbox } from "@chalito/billing";
import { loadPrices } from "@chalito/config";
import type { HubUsage } from "../src/voice/hub.js";
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
            balance: { remaining: hubRemaining, reserved: 0 },
          }
        : { ok: true, allowed: false, reason: "no_tokens" },
    );
  }),
  http.post("https://www.chalyb.com/api/engines/chalito/usage/settle", async ({ request }) => {
    hubCalls.push({ path: "settle", body: (await request.json()) as Record<string, unknown> });
    return HttpResponse.json({ ok: true });
  }),
  http.post("https://api.openai.com/v1/realtime/client_secrets", async ({ request }) => {
    minted.push({
      body: (await request.json()) as Record<string, unknown>,
      headers: Object.fromEntries(request.headers.entries()),
    });
    return HttpResponse.json({ value: "ek_live_looking", expires_at: 1_790_000_060 });
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  minted.length = 0;
  hubCalls.length = 0;
  hubRemaining = 50_000;
});

/** The real hub-backed stream usage, with a memory outbox. */
const realHub = () => {
  const outbox = new MemoryOutbox();
  const hub = new HubStreamUsage({
    hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "chalito-admin-token" }),
    enqueue: (owner, events) => outbox.enqueue(owner, events),
    prices: loadPrices(),
    model: "gpt-realtime-2.1-mini",
    now: () => 1_790_000_000_000,
  });
  return { hub, outbox };
};

const device = (deviceId: string, role: DeviceDoc["role"], revoked = false) =>
  ({ deviceId, role, revoked }) as DeviceDoc;

const setup = (hub: HubUsage = realHub().hub) => {
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
  } as unknown as IdentityIssuer;
  const repo = { getDevice: async (_o: string, id: string) => devices.get(id) ?? null } as unknown as ApiRepo;
  const app = createApp({
    repo,
    identity,
    audit: new MemoryAudit(),
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: () => 1_790_000_000_000,
    voice: {
      provider: openaiRealtime({ apiKey: "sk-test" }),
      hub,
      model: loadModels().voice.desktop.model,
      voiceName: "marin",
      tokenSecret: "voice-token-secret",
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
  return { call, hub };
};

describe("POST /v1/voice/session (desktop push-to-talk)", () => {
  it("an active device gets a short-lived client secret for gpt-realtime-2.1-mini with the desktop tools", async () => {
    const { call } = setup();
    const res = await call("/session", "agent:dev_agent");
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      clientSecret: "ek_live_looking",
      expiresAt: 1_790_000_060_000,
      model: "gpt-realtime-2.1-mini",
    });
    expect(minted).toHaveLength(1);
    const { body, headers } = minted[0]!;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(headers["openai-safety-identifier"]).toBe(createHash("sha256").update("chalito:hub-user-1").digest("hex"));
    expect(body.expires_after).toEqual({ anchor: "created_at", seconds: 60 });
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
      record: async () => ({ continue: false }),
      settle: async () => {},
    };
    expect(await setup(refusing).call("/session", "client:dev_phone")).toMatchObject({
      status: 402,
      json: { error: "voice_not_admitted" },
    });
    expect(minted).toEqual([]);
  });

  it("heartbeats meter voice.seconds (at most 60 s each) for the device that opened the session; end settles", async () => {
    const { hub, outbox } = realHub();
    const { call } = setup(hub);
    const { json } = await call("/session", "client:dev_phone");
    const voiceToken = String(json.voiceToken);
    expect(await call("/session/heartbeat", "client:dev_phone", { voiceToken, seconds: 30 })).toEqual({
      status: 200,
      json: { ok: true, continue: true },
    });
    expect((await call("/session/heartbeat", "client:dev_phone", { voiceToken, seconds: 3600 })).status).toBe(400);
    expect(await call("/session/heartbeat", "agent:dev_agent", { voiceToken, seconds: 30 })).toMatchObject({
      status: 403,
      json: { error: "bad_voice_token" },
    });
    expect(
      (await call("/session/heartbeat", "client:dev_phone", { voiceToken: `${voiceToken}x`, seconds: 30 })).status,
    ).toBe(403);
    expect(await call("/session/end", "client:dev_phone", { voiceToken, seconds: 12 })).toEqual({
      status: 200,
      json: { ok: true, continue: false },
    });
    // Each report is a priced voice.seconds event in the outbox, tied to the reservation.
    expect(
      outbox.rows.map((r) => [r.event.kind, r.event.amount, r.event.cost_usd_micros, r.event.reservation_id]),
    ).toEqual([
      ["voice.seconds", 30, 15_000, RID],
      ["voice.seconds", 12, 6_000, RID],
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

  it("no desktop tool decides anything: open_approval only opens the app", () => {
    expect(JSON.stringify(DESKTOP_TOOLS)).not.toMatch(/"name":"(approve|deny|decide|decision)/i);
    expect(DESKTOP_TOOLS.find((t) => t.name === "open_approval")!.description).toMatch(/sign it there/);
  });

  it("stops the stream when the hub balance runs out, and refuses new sessions with no tokens", async () => {
    const { call } = setup();
    const { json } = await call("/session", "client:dev_phone");
    hubRemaining = 0;
    expect(
      await call("/session/heartbeat", "client:dev_phone", { voiceToken: String(json.voiceToken), seconds: 30 }),
    ).toEqual({
      status: 200,
      json: { ok: true, continue: false },
    });
    expect(await call("/session", "client:dev_phone")).toMatchObject({
      status: 402,
      json: { error: "voice_not_admitted", message: "no_tokens" },
    });
  });
});
