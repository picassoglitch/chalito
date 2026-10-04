import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { HubClient, computeEntitlements } from "@chalito/billing";
import { loadModels, loadPlans, loadPrices } from "@chalito/config";
import { generateBoxKeyPair, openJson, toB64url } from "@chalito/crypto";
import { SealedEnvelope, type EntitlementInputs } from "@chalito/protocol";
import { createOrchestrator } from "../src/app.js";
import { GoogleGenAI } from "@google/genai";
import { AnthropicBrain } from "../src/brains/anthropic.js";
import { GeminiBrain } from "../src/brains/gemini.js";
import { ResponsesBrain } from "../src/brains/responses.js";
import { byoBrains } from "../src/byo.js";
import { LocalKeyWrapper } from "../src/kms.js";
import type { MesaDoc, Participant } from "../src/core/mesa.js";
import { MemoryMesaStore } from "../src/store.js";
import type { TurnDeps } from "../src/turn.js";

/**
 * The Claude API and the Chalyb hub, mocked at the HTTP layer with msw (nothing live), behind the
 * real AnthropicBrain and HubClient.
 */
export const OWNER = "hub-user-1";
export const HUB = "https://www.chalyb.com/api/engines/chalito";
export const RESERVATION = "11111111-1111-4111-8111-111111111111";

export interface ClaudeReply {
  input?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  text?: string;
}

export const mocks = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Call = { body: Record<string, any>; auth: string | null; url: string };
  const claude: Call[] = [];
  const openai: Call[] = [];
  const xai: Call[] = [];
  const gemini: Call[] = [];
  const hub: { path: string; body: Record<string, any> }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const state = {
    reply: (_body: Record<string, unknown>): ClaudeReply => ({
      input: {
        say: "Hola, ¿en qué te ayudo?",
        proposals: [],
        objections: [],
        emotion: { tag: "happy", intensity: 0.6 },
      },
    }),
    claudeStatus: 200,
    /** Reply for OpenAI / xAI / Gemini: the `respond` arguments and the provider's usage block. */
    other: (_provider: "openai" | "xai" | "google", _body: Record<string, unknown>): ClaudeReply => ({
      input: { say: "De acuerdo.", proposals: [], objections: [], emotion: { tag: "relaxed", intensity: 0.4 } },
    }),
    admit: (_b: Record<string, unknown>): Record<string, unknown> => ({
      ok: true,
      allowed: true,
      reservation_id: RESERVATION,
      lane: "standard",
      boost_fee_tokens: 0,
      limits: {},
      balance: {
        remaining: 50_000,
        unlimited: false,
        monthlyAllocation: 100_000,
        bonus: 0,
        monthlyUsed: 50_000,
        reserved: 1_000,
        periodStart: "2026-10-01T00:00:00Z",
      },
    }),
  };
  const server = setupServer(
    http.post("https://api.anthropic.com/v1/messages", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      claude.push({ body, auth: request.headers.get("x-api-key"), url: request.url });
      if (state.claudeStatus !== 200)
        return HttpResponse.json(
          { type: "error", error: { type: "api_error", message: "x" } },
          { status: state.claudeStatus },
        );
      const r = state.reply(body);
      return HttpResponse.json({
        id: `msg_${claude.length}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content: [
          ...(r.text ? [{ type: "text", text: r.text }] : []),
          ...(r.input ? [{ type: "tool_use", id: `tu_${claude.length}`, name: "respond", input: r.input }] : []),
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: r.usage ?? {
          input_tokens: 1200,
          output_tokens: 150,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 500,
          cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
        },
      });
    }),
    ...(["https://api.openai.com/v1/responses", "https://api.x.ai/v1/responses"] as const).map((url) =>
      http.post(url, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        const provider = url.includes("x.ai") ? "xai" : "openai";
        (provider === "xai" ? xai : openai).push({
          body,
          auth: request.headers.get("authorization"),
          url: request.url,
        });
        const r = state.other(provider, body);
        return HttpResponse.json({
          id: `resp_${openai.length + xai.length}`,
          object: "response",
          created_at: 1,
          model: body.model,
          status: "completed",
          output: r.input
            ? [
                {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_1",
                  name: "respond",
                  arguments: JSON.stringify(r.input),
                  status: "completed",
                },
              ]
            : [
                {
                  type: "message",
                  id: "m_1",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: r.text ?? "", annotations: [] }],
                },
              ],
          usage: r.usage ?? {
            input_tokens: 3000,
            input_tokens_details: {
              cached_tokens: 1000,
              ...(provider === "openai" ? { cache_write_tokens: 500 } : {}),
            },
            output_tokens: 200,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 3200,
          },
        });
      }),
    ),
    http.post(
      /^https:\/\/(aiplatform|generativelanguage)\.googleapis\.com\/.*:generateContent$/,
      async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        gemini.push({ body, auth: request.headers.get("x-goog-api-key"), url: request.url });
        const r = state.other("google", body);
        return HttpResponse.json({
          candidates: [
            {
              content: {
                role: "model",
                parts: r.input ? [{ functionCall: { name: "respond", args: r.input } }] : [{ text: r.text ?? "" }],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: r.usage ?? {
            promptTokenCount: 2000,
            cachedContentTokenCount: 800,
            candidatesTokenCount: 100,
            thoughtsTokenCount: 50,
            totalTokenCount: 2150,
          },
        });
      },
    ),
    http.post(`${HUB}/usage/admit`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      hub.push({ path: "admit", body });
      return HttpResponse.json(state.admit(body));
    }),
    http.post(`${HUB}/usage/settle`, async ({ request }) => {
      hub.push({ path: "settle", body: (await request.json()) as Record<string, unknown> });
      return HttpResponse.json({ ok: true });
    }),
  );
  return { server, claude, openai, xai, gemini, hub, state };
};

export const participants: Participant[] = [
  { kind: "companion", pid: "chalito", name: "Chalito", companionId: "chl_abcdefghijklmnopqrstuvwxyz" },
  { kind: "brain", pid: "claude", name: "Claude", provider: "anthropic", modelRef: "auto" },
  { kind: "brain", pid: "gpt", name: "GPT", provider: "openai", modelRef: "auto" },
  { kind: "brain", pid: "grok", name: "Grok", provider: "xai", modelRef: "auto" },
];

export const harness = async (
  opts: {
    entitlement?: Partial<EntitlementInputs>;
    budget?: MesaDoc["budget"];
    managed?: TurnDeps["brains"]["managed"];
    extraParticipants?: Participant[];
  } = {},
) => {
  const store = new MemoryMesaStore();
  const wrapper = new LocalKeyWrapper();
  const phone = await generateBoxKeyPair();
  store.clients.set(OWNER, { dev_phone: await toB64url(phone.publicKey) });
  const plans = loadPlans();
  const entitlementInputs: EntitlementInputs = {
    uid: OWNER,
    hubTier: "pro",
    soloTier: null,
    hubTrialActive: false,
    hubBalanceRemaining: 50_000,
    hubUnlimited: false,
    comped: false,
    now: 1,
    ...opts.entitlement,
  };
  let n = 0;
  const deps: TurnDeps = {
    store,
    hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "engine-token" }),
    brains: {
      managed: {
        anthropic: new AnthropicBrain({ apiKey: "sk-ant-managed", maxRetries: 0 }),
        openai: new ResponsesBrain("openai", { apiKey: "sk-openai-managed", maxRetries: 0 }),
        xai: new ResponsesBrain("xai", { apiKey: "xai-managed", maxRetries: 0 }),
        // Vertex AI (express mode in tests: no ADC needed).
        google: new GeminiBrain(new GoogleGenAI({ vertexai: true, apiKey: "vertex-managed" })),
        ...opts.managed,
      },
      byo: byoBrains({ store, wrapper }),
    },
    models: loadModels(),
    prices: loadPrices(),
    entitlements: async () => computeEntitlements(entitlementInputs, plans),
    now: () => 1_790_000_000_000,
    newId: () => `t_${++n}`,
  };
  const mid = "m_1";
  await store.createMesa(OWNER, mid, {
    v: 1,
    kind: "mesa",
    participants: [
      { kind: "human", pid: "owner", name: "Aldo", uid: OWNER },
      ...participants,
      ...(opts.extraParticipants ?? []),
    ],
    budget: opts.budget ?? { mesaTokens: null, perParticipant: null },
    used: { total: 0, byParticipant: {} },
    status: "open",
    createdAt: 1,
  });
  const app = createOrchestrator({
    ...deps,
    wrapper,
    authn: {
      verify: async (t) => {
        if (t === "phone-token") return { owner: OWNER, deviceId: "dev_phone", role: "client" };
        if (t === "agent-token") return { owner: OWNER, deviceId: "dev_agent", role: "agent" };
        if (t === "revoked-token") return { owner: OWNER, deviceId: "dev_old", role: "client" };
        throw new Error("bad token");
      },
    },
  });
  /** Opens a stored turn as the phone would. */
  const open = async (doc: Record<string, unknown>, m = mid) =>
    openJson<Record<string, unknown>>(SealedEnvelope.parse(doc.outCt), "dev_phone", phone, `mesa:${m}`);
  return { store, deps, mid, app, open, phone, wrapper };
};
