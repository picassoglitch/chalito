/**
 * Beta rehearsal, the failure paths a beta tester will actually hit, on the same real stack as
 * beta.rehearsal.test.ts: the hub down, out of credit, a phone revoked mid-approval, quiet hours,
 * and a connector's grant revoked mid-session. Each scenario is its own describe with its own
 * people and devices; outside services are mocked at the network, only around the calls that
 * need them (msw also intercepts new sockets).
 */
import { randomUUID } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { openaiRealtime } from "@chalito/adapters/voice";
import {
  HubClient,
  HubStreamUsage,
  PostgresVoiceSessions,
  computeEntitlements,
  enqueueUsage,
  usageEvent,
} from "@chalito/billing";
import { loadModels, loadPlans, loadPrices } from "@chalito/config";
import { randomNonce, signEnvelope } from "@chalito/crypto";
import { createApp } from "../../api/src/app.js";
import { pgVoiceCap } from "../../api/src/voice/caps.js";
import type { VoiceDeps } from "../../api/src/voice/routes.js";
import { GatewayApi } from "../../mcp-gateway/src/api-client.js";
import { createGateway } from "../../mcp-gateway/src/app.js";
import { PostgresGatewayReader, gatewaySql } from "../../mcp-gateway/src/postgres-reader.js";
import { hubState, mockServer as notifierMocks } from "../../notifier/test/harness.js";
import { AnthropicBrain } from "../../orchestrator/src/brains/anthropic.js";
import { PostgresMesaStore } from "../../orchestrator/src/postgres-store.js";
import { runTurn, type TurnDeps, type TurnRequest } from "../../orchestrator/src/turn.js";
import { HUB, mocks as orchestratorMocks } from "../../orchestrator/test/harness.js";
import { waitFor } from "./agent.js";
import { createNotifier } from "./notifier.js";
import { CLAUDE_CLIENT, claudeCimd, connectClaude, pendingHigh, subscribePush } from "./scenario.js";
import { API_ISSUER, DB_URL, GATEWAY_TOKEN, MCP_RESOURCE, READY, createStack, type Person } from "./stack.js";

const stack = READY ? createStack() : null;
beforeAll(async () => {
  await stack?.warm();
});
afterAll(async () => {
  await stack?.close();
});
const closeQuietly = (server: { close(): void }) => {
  try {
    server.close();
  } catch {
    /* not listening */
  }
};

/** A fixed-offset zone where it's `hour` o'clock now. */
const zoneAt = (hour: number, now = new Date()) => {
  let offset = hour - now.getUTCHours();
  if (offset > 12) offset -= 24;
  if (offset < -12) offset += 24;
  return offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
};

/** A verified WhatsApp number with the charges notice acknowledged, in `tz`. */
const whatsappReady = async (s: NonNullable<typeof stack>, p: Person, tz: string) => {
  const e164 = `+5255${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  await s.sql`update chalito.users set tz = ${tz}, phone_e164 = ${e164}, phone_country = 'MX',
    phone_verified_at = now(), charges_notice_ack_at = now(), whatsapp_opt_in = true where id = ${p.owner}`;
};

/** A Mesa turn addressed to Claude, as the orchestrator runs it (Claude API + hub mocked). */
const mesaTurn = async (s: NonNullable<typeof stack>, p: Person) => {
  const store = new PostgresMesaStore(s.sql);
  const mid = `m_${randomUUID().slice(0, 8)}`;
  await store.createMesa(p.owner, mid, {
    v: 1,
    kind: "mesa",
    participants: [
      { kind: "human", pid: "owner", name: p.name, uid: p.owner },
      { kind: "brain", pid: "claude", name: "Claude", provider: "anthropic", modelRef: "auto" },
    ],
    budget: { mesaTokens: null, perParticipant: null },
    used: { total: 0, byParticipant: {} },
    status: "open",
    createdAt: Date.now(),
  });
  const r = await runTurn(
    {
      store,
      hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "engine-token" }),
      brains: {
        managed: { anthropic: new AnthropicBrain({ apiKey: "sk-ant-managed", maxRetries: 0 }) },
        byo: async () => null,
      },
      models: loadModels(),
      prices: loadPrices(),
      entitlements: async () =>
        computeEntitlements(
          {
            uid: p.owner,
            hubTier: "pro",
            soloTier: null,
            hubTrialActive: false,
            hubBalanceRemaining: 50_000,
            hubUnlimited: false,
            comped: false,
            now: Date.now(),
          },
          loadPlans(),
        ),
      now: Date.now,
    } as unknown as TurnDeps,
    {
      owner: p.owner,
      deviceId: p.phone.deviceId,
      mid,
      tid: `in_${randomUUID().slice(0, 8)}`,
      text: "@Claude ¿lanzamos el lunes?",
      source: "owner",
      goal: "Decidir el lanzamiento",
      card: null,
      recent: [],
      locale: "es",
    } as TurnRequest,
  );
  const outbox = await s.sql`select 1 from chalito_private.usage_outbox where owner = ${p.owner}`;
  return { r, outboxRows: outbox.length };
};

describe.skipIf(!READY)("a. the hub is down", () => {
  const s = stack!;

  it("a companion turn finishes on free_min with no recharge line, and nothing is billed", async () => {
    const m = orchestratorMocks();
    m.server.use(http.post(`${HUB}/usage/admit`, () => HttpResponse.json({ error: "down" }, { status: 503 })));
    const p = await s.person("ines", "pro");
    m.server.listen({ onUnhandledFrame: "bypass" });
    try {
      const { r, outboxRows } = await mesaTurn(s, p);
      expect(r.stopped).toBe("refused:hub_unavailable");
      expect(r.energy).toBeUndefined(); // no "recharge" line: it isn't the person's balance
      expect(m.claude).toHaveLength(0); // fails closed: no managed spend
      expect(outboxRows).toBe(0);
    } finally {
      closeQuietly(m.server);
    }
  });

  it("paid comms are suppressed with the reason (push, which is free, still goes)", async () => {
    const net = notifierMocks();
    const p = await s.person("javi");
    await s.enrolPasskey(p);
    const endpoint = await subscribePush(p.owner, p.phone);
    await whatsappReady(s, p, zoneAt(12));
    const notifier = createNotifier(s.sql, { billing: true });
    const h = await pendingHigh(s, p, "Laptop de Javi");
    hubState.admit = "down";
    net.server.listen({ onUnhandledFrame: "bypass" });
    try {
      expect((await notifier.poke(h.notifyRow.id)).status).toBe(200);
      await waitFor(() => net.cap.push.some((x) => x.endpoint === endpoint), 20_000, "the web push");
      notifier.advance(3 * 60_000 + 1_000);
      expect((await notifier.tick(p.owner, h.notifyRow.nid)).status).toBeLessThan(300);
      await waitFor(
        () => notifier.logs.some((l) => l.msg === "notifier.suppressed" && l.meta?.channel === "whatsapp"),
        20_000,
        "the WhatsApp rung to be decided",
      );
      expect(net.cap.whatsapp).toHaveLength(0);
      expect(
        notifier.logs.find((l) => l.msg === "notifier.suppressed" && l.meta?.channel === "whatsapp")?.meta?.reason,
      ).toBe("hub_unavailable");
    } finally {
      hubState.admit = "allowed";
      closeQuietly(net.server);
      await h.agent.close();
    }
  });
});

describe.skipIf(!READY)("b. out of credit", () => {
  const s = stack!;

  it("the companion's recharge line and chip, on free_min; nothing billed", async () => {
    const m = orchestratorMocks();
    m.state.admit = () => ({ ok: true, allowed: false, reason: "no_tokens", limits: {} });
    const p = await s.person("karla", "pro");
    m.server.listen({ onUnhandledFrame: "bypass" });
    try {
      const { r, outboxRows } = await mesaTurn(s, p);
      expect(r.stopped).toBe("out_of_energy");
      expect(r.energy).toMatchObject({
        profile: "free_min",
        animation: "tired",
        presentation: "inline",
        chip: { href: "/creditos" },
      });
      expect(r.energy!.line.length).toBeGreaterThan(0);
      expect(m.claude).toHaveLength(0);
      expect(outboxRows).toBe(0);
    } finally {
      closeQuietly(m.server);
    }
  });

  it("a desktop voice session is refused at the monthly cap, with the once-a-month note", async () => {
    const p = await s.person("lalo", "standard"); // 120 voice minutes a month
    await s.sql`update chalito.users set tz = 'America/Mexico_City' where id = ${p.owner}`;
    // This month's minutes, already used (desktop and calls share them).
    await enqueueUsage(s.sql, p.owner, [
      usageEvent(
        { owner: p.owner, billingMode: "managed", origin: "voice.desktop" },
        {
          kind: "voice.seconds",
          provider: "openai",
          amount: 120 * 60,
          costUsdMicros: 1,
          occurredAt: Date.now(),
          sourceId: `voice_${randomUUID()}:7200`,
        },
      ),
    ]);
    const voiceApi = createApp({
      ...s.deps,
      voice: {
        provider: openaiRealtime({ apiKey: "sk-test" }),
        hub: new HubStreamUsage({
          hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "engine-token" }),
          prices: loadPrices(),
          model: loadModels().voice.desktop.model,
          reserveBasis: "pre_margin",
          now: Date.now,
        }),
        model: loadModels().voice.desktop.model,
        voiceName: "marin",
        tokenSecret: "rehearsal-voice-token-secret",
        cap: pgVoiceCap(s.sql, loadPlans(), () => false),
        sessions: new PostgresVoiceSessions(s.sql),
      } as VoiceDeps,
    });
    const res = await voiceApi.request("/v1/voice/session", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${p.phone.token}`,
        "x-forwarded-for": "10.9.9.9",
      },
      body: "{}",
    });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toBe("voice_cap_reached");
    const notes = await s.sql`select nid from chalito.notifications where owner = ${p.owner} and source = 'budget'`;
    expect(notes.map((n) => String(n.nid))).toEqual([expect.stringMatching(/^cap_voice_/)]);
  });
});

describe.skipIf(!READY)("c. a phone revoked mid-approval", () => {
  const s = stack!;

  it("its later decisions are refused, and the ladder goes on to the remaining device only", async () => {
    const net = notifierMocks();
    const p = await s.person("mara");
    await s.enrolPasskey(p);
    const { device: web } = await s.endorseBrowser(p);
    const phoneEndpoint = await subscribePush(p.owner, p.phone);
    const webEndpoint = await subscribePush(p.owner, web);
    const notifier = createNotifier(s.sql);
    const h = await pendingHigh(s, p, "Laptop de Mara");
    net.server.listen({ onUnhandledFrame: "bypass" });
    try {
      expect((await notifier.poke(h.notifyRow.id)).status).toBe(200);
      await waitFor(
        () => [phoneEndpoint, webEndpoint].every((e) => net.cap.push.some((x) => x.endpoint === e)),
        20_000,
        "the first push to both devices",
      );
      closeQuietly(net.server);

      // The phone is lost: the browser revokes it.
      expect((await s.call("/v1/devices/revoke", { deviceId: p.phone.deviceId }, web.token)).status).toBe(200);
      const late = await p.phone.db.from("approval_decisions").insert({
        owner: p.owner,
        aid: h.approval.aid,
        signer_device_id: p.phone.deviceId,
        decision: await signEnvelope(
          "chalito.decision.v1",
          {
            v: 1 as const,
            aid: h.approval.aid,
            requestId: h.approval.request_id,
            uid: p.owner,
            targetDeviceId: h.agentDevice.deviceId,
            allow: false,
            nonce: await randomNonce(),
            issuedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          },
          p.phone.deviceId,
          p.phone.sign.secretKey,
        ),
      });
      expect(late.error, "a revoked phone's decision must be refused").not.toBeNull();

      // The ladder's next push (+5 min) reaches the browser, and not the revoked phone.
      const before = net.cap.push.length;
      net.server.listen({ onUnhandledFrame: "bypass" });
      notifier.advance(5 * 60_000 + 1_000);
      expect((await notifier.tick(p.owner, h.notifyRow.nid)).status).toBeLessThan(300);
      await waitFor(
        () => net.cap.push.slice(before).some((x) => x.endpoint === webEndpoint),
        20_000,
        "the next push to the browser",
      );
      const after = net.cap.push.slice(before).map((x) => x.endpoint);
      expect(after, "no notification may reach a revoked device").not.toContain(phoneEndpoint);
      const [a] = await s.sql<{ status: string }[]>`
        select status from chalito.approvals where owner = ${p.owner} and aid = ${h.approval.aid}`;
      expect(a!.status).toBe("pending");
      expect(h.fake.run.ran).toHaveLength(0);
    } finally {
      closeQuietly(net.server);
      await h.agent.close();
    }
  });
});

describe.skipIf(!READY)("d. quiet hours", () => {
  const s = stack!;

  it("phone channels are held (no WhatsApp, no call); the in-app notice is still written", async () => {
    const net = notifierMocks();
    const p = await s.person("nico");
    await s.enrolPasskey(p);
    const endpoint = await subscribePush(p.owner, p.phone);
    await whatsappReady(s, p, zoneAt(2)); // 02:00 in the person's zone
    const notifier = createNotifier(s.sql);
    const h = await pendingHigh(s, p, "Laptop de Nico");
    net.server.listen({ onUnhandledFrame: "bypass" });
    try {
      expect((await notifier.poke(h.notifyRow.id)).status).toBe(200);
      await waitFor(
        async () =>
          (await s.sql`select 1 from chalito.notifications where owner = ${p.owner} and nid = ${h.notifyRow.nid}`)
            .length === 1,
        20_000,
        "the in-app notice",
      );
      notifier.advance(3 * 60_000 + 1_000);
      expect((await notifier.tick(p.owner, h.notifyRow.nid)).status).toBeLessThan(300);
      await new Promise((r) => setTimeout(r, 1000));
      expect(net.cap.whatsapp).toHaveLength(0);
      expect(net.cap.calls).toHaveLength(0);
      // Quiet hours hold every phone channel, push included (ADR 0011; L4 allowlisted items aside).
      expect(net.cap.push.filter((x) => x.endpoint === endpoint)).toHaveLength(0);
      const held = notifier.logs.filter((l) => l.msg === "notifier.suppressed" && l.meta?.reason === "quiet_hours");
      expect(held.map((l) => l.meta?.channel)).toEqual(expect.arrayContaining(["push", "whatsapp"]));
    } finally {
      closeQuietly(net.server);
      await h.agent.close();
    }
  });
});

describe.skipIf(!READY)("e. a connector's grant revoked mid-session", () => {
  const s = stack!;
  const gwSql = gatewaySql(DB_URL ?? "postgres://unused", { max: 2, role: "chalito_gateway" });
  const cimd = setupServer(http.get(CLAUDE_CLIENT, () => HttpResponse.json(claudeCimd)));
  beforeAll(async () => {
    await Promise.all([gwSql`select pg_sleep(0.05)`, gwSql`select pg_sleep(0.05)`]);
  });
  afterAll(async () => {
    closeQuietly(cimd);
    await gwSql.end();
  });

  it("the very next MCP call fails", async () => {
    const p = await s.person("olga");
    await s.enrolPasskey(p);
    cimd.listen({ onUnhandledFrame: "bypass" });
    let token: string;
    try {
      token = await connectClaude(s, p, ["mcp:read"]);
    } finally {
      closeQuietly(cimd);
    }
    const gw = createGateway({
      reader: new PostgresGatewayReader(gwSql),
      api: new GatewayApi("http://api.rehearsal.invalid", GATEWAY_TOKEN, s.apiFetch),
      cfg: { resource: MCP_RESOURCE, issuer: API_ISSUER },
      now: Date.now,
    });
    const gwFetch = ((url: string | URL, init?: RequestInit) => gw.fetch(new Request(url, init))) as typeof fetch;
    const client = new Client({ name: "rehearsal", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(MCP_RESOURCE), {
        fetch: gwFetch,
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const ok = (await client.callTool({ name: "list_pending", arguments: {} })) as { isError?: boolean };
    expect(ok.isError ?? false).toBe(false);

    // The person revokes Claude's connector on the phone (Settings → Connections).
    const [g] = await s.sql<{ cid: string }[]>`select cid from chalito.connectors where owner = ${p.owner}`;
    const revoked = await s.api.request(`/v1/connectors/${g!.cid}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.phone.token}`, "x-forwarded-for": "10.8.8.8" },
    });
    expect(revoked.status).toBe(204);

    // The very next call through the same open session is refused (the token is checked each time).
    await expect(client.callTool({ name: "list_pending", arguments: {} })).rejects.toThrow();
    const raw = await gwFetch(MCP_RESOURCE, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(raw.status).toBe(401);
    await client.close().catch(() => undefined);
  });
});
