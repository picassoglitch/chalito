import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { MemoryBuckets, guard, type BucketStore } from "@chalito/guard";
import type {
  CodingAgent,
  CodingCredential,
  CodingMeter,
  CodingRefusal,
  CodingStore,
  CodingTicket,
} from "@chalito/billing";
import type { ProvidersConfig } from "@chalito/config";
import { errorMessage } from "@chalito/redact";
import { gatewayRoutes } from "./limits.js";
import { geminiReader, responsesReader, type UsageReader } from "./wires/usage.js";

/** Where the gateway sends each wire, with OUR key (Secret Manager). Base URLs are overridable for tests. */
export interface Upstreams {
  openai: { baseUrl: string; apiKey: string } | null;
  xai: { baseUrl: string; apiKey: string } | null;
  google: { baseUrl: string; apiKey: string } | null;
}

export interface GatewayDeps {
  store: CodingStore;
  meter: Pick<CodingMeter, "begin" | "finish">;
  providers: ProvidersConfig;
  upstreams: Upstreams;
  /** CODING_MANAGED_ENABLED=1, read per request. */
  enabled: () => boolean;
  now: () => number;
  fetch?: typeof fetch;
  /** Requests per credential: burst and refill per second (an agent's tool loop is bursty). */
  perToken?: { capacity: number; refillPerSec: number };
  trustedProxies?: number;
  /** How long the gateway keeps reading a provider stream after the person's CLI went away. */
  drainMs?: number;
  log?: (msg: string, meta: Record<string, unknown>) => void;
}

type Wire = "responses" | "gemini";
const WIRE_OF: Record<CodingAgent, Wire> = { codex: "responses", "grok-build": "responses", "gemini-cli": "gemini" };

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** An error in the shape the person's CLI reads: OpenAI's for Responses, Google's for Gemini. */
const errorBody = (wire: Wire, status: number, code: string, message: string) =>
  wire === "gemini"
    ? { error: { code: status, message, status: code.toUpperCase() } }
    : { error: { message, type: "chalyb_error", code } };

const REFUSAL: Record<CodingRefusal, [number, string]> = {
  revoked: [401, "This Chalyb session ended. Start a new one."],
  expired: [401, "This Chalyb session ended. Start a new one."],
  device_revoked: [401, "This computer was removed from your account."],
  not_eligible: [403, "IA de Chalyb is part of Pro and VIP."],
  model_not_allowed: [400, "That model isn't available with IA de Chalyb."],
  out_of_energy: [402, "You're out of Chalyb tokens. Recharge, or use your own key."],
  daily_cap: [402, "You reached today's limit for coding agents. Raise it in Ajustes, or use your own key."],
  busy: [429, "Too many live sessions on your plan right now."],
  hub_unavailable: [503, "Chalyb can't check your balance right now. Try again in a moment."],
};

/** The token, wherever the CLI puts it: Bearer (Codex, Grok), x-goog-api-key or ?key= (Gemini). */
const tokenOf = (c: Context) => {
  const auth = c.req.header("authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return c.req.header("x-goog-api-key") ?? c.req.query("key") ?? "";
};

export const createGateway = (d: GatewayDeps) => {
  const app = new Hono();
  const doFetch = d.fetch ?? fetch;
  const buckets: BucketStore = new MemoryBuckets();

  const log = d.log ?? ((m, meta) => console.warn(`[ai-gateway] ${m}`, JSON.stringify(meta)));
  app.use(
    "*",
    guard(gatewayRoutes(), {
      now: d.now,
      ...(d.trustedProxies !== undefined ? { trustedProxies: d.trustedProxies } : {}),
    }),
  );
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/health", (c) => c.json({ ok: true }));

  const fail = (c: Context, wire: Wire, status: number, code: string, message: string) =>
    c.json(errorBody(wire, status, code, message), status as 400);

  /** The live credential behind the request's token, or a response that refuses it. */
  const authorize = async (c: Context, wire: Wire): Promise<CodingCredential | Response> => {
    const token = tokenOf(c);
    if (!/^chc_[A-Za-z0-9_-]{43}$/.test(token))
      return fail(c, wire, 401, "invalid_token", "Not a Chalyb session token.");
    const cred = await d.store.byTokenHash(sha256hex(token));
    if (!cred || WIRE_OF[cred.agent] !== wire)
      return fail(c, wire, 401, "invalid_token", "Not a Chalyb session token.");
    if (!d.enabled()) {
      if (cred.revokedAt === null)
        await d.store.withCredential(cred.id, (tx) => tx.update({ revoked: { at: d.now(), reason: "kill_switch" } }));
      return fail(c, wire, 503, "managed_disabled", "IA de Chalyb is paused. Use your own key for now.");
    }
    if (cred.revokedAt !== null || cred.expiresAt <= d.now())
      return fail(c, wire, 401, "invalid_token", REFUSAL.revoked[1]);
    const perToken = d.perToken ?? { capacity: 60, refillPerSec: 1 };
    if (!(await buckets.take(cred.id, perToken.capacity, perToken.refillPerSec, d.now())))
      return fail(c, wire, 429, "rate_limited", "Too many requests. Slow down a little.");
    return cred;
  };

  /** Meters and forwards one request, streaming back as it arrives. If the CLI hangs up, the gateway keeps
   *  reading the provider's stream so the usage is still known (ADR 0030: no unbilled usage). */
  const forward = async (
    c: Context,
    p: {
      wire: Wire;
      cred: CodingCredential;
      model: string;
      body: Record<string, unknown>;
      url: string;
      headers: Record<string, string>;
      stream: boolean;
      meter: boolean;
    },
  ): Promise<Response> => {
    const managed = d.providers.codingAgents[p.cred.agent]?.managed;
    if (!managed) return fail(c, p.wire, 400, "not_managed", "This agent has no IA de Chalyb.");
    const payload = JSON.stringify(p.body);
    let ticket: CodingTicket | null = null;
    if (p.meter) {
      const r = await d.meter.begin(p.cred.id, {
        model: p.model,
        inputBytes: Buffer.byteLength(payload),
        maxInputTokens: managed.maxInputTokens,
        maxOutputTokens: managed.maxOutputTokens,
      });
      if (!r.ok) {
        const [status, message] = REFUSAL[r.reason];
        return fail(c, p.wire, status, r.reason, message);
      }
      ticket = r.ticket;
    } else if (!p.cred.models.includes(p.model)) {
      return fail(c, p.wire, 400, "model_not_allowed", REFUSAL.model_not_allowed[1]);
    }
    let finished = false;
    const finish = async (reader: UsageReader | null, ok: boolean) => {
      if (finished || !ticket) return;
      finished = true;
      // A refused or failed upstream call isn't charged by the provider: nothing billed, the hold released.
      const usage = ok && reader ? reader.end() : { input: 0, output: 0 };
      try {
        await d.meter.finish(ticket, usage, { outputBytes: reader?.bytes ?? 0 });
      } catch (err) {
        log("meter.finish_failed", { credential: ticket.credentialId, seq: ticket.seq, error: errorMessage(err) });
      }
    };

    let upstream: Response;
    try {
      upstream = await doFetch(p.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...p.headers },
        body: payload,
      });
    } catch (err) {
      await finish(null, false);
      log("upstream.unreachable", { credential: p.cred.id, error: errorMessage(err) });
      return fail(c, p.wire, 502, "upstream_unavailable", "The model provider didn't answer. Try again.");
    }
    const okStatus = upstream.ok;
    const reader = p.wire === "gemini" ? geminiReader(p.stream) : responsesReader(p.stream);
    const headers = new Headers({ "cache-control": "no-store" });
    const type = upstream.headers.get("content-type");
    if (type) headers.set("content-type", type);
    if (!upstream.body) {
      await finish(reader, okStatus);
      return new Response(null, { status: upstream.status, headers });
    }
    const src = upstream.body.getReader();
    const drainMs = d.drainMs ?? 15 * 60_000;
    let clientGone = false;
    // The CLI hung up: keep reading (bounded) so the provider's final usage still reaches the bill.
    const drain = async () => {
      const until = Date.now() + drainMs;
      try {
        for (;;) {
          if (Date.now() > until) {
            await src.cancel().catch(() => undefined);
            break;
          }
          const { done, value } = await src.read();
          if (done) break;
          reader.push(value);
        }
      } catch {
        /* the provider cut the stream: fallback billing */
      }
      await finish(reader, okStatus);
    };
    const out = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        try {
          const { done, value } = await src.read();
          if (done) {
            ctrl.close();
            await finish(reader, okStatus);
            return;
          }
          reader.push(value);
          if (!clientGone) ctrl.enqueue(value);
        } catch {
          ctrl.error(new Error("upstream stream failed"));
          await finish(reader, okStatus);
        }
      },
      cancel() {
        clientGone = true;
        void drain();
      },
    });
    return new Response(out, { status: upstream.status, headers });
  };

  const readJson = async (c: Context) => {
    const v = await c.req.json().catch(() => null);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  };

  // Codex and Grok Build: OpenAI's Responses API.
  app.post("/v1/responses", async (c) => {
    const cred = await authorize(c, "responses");
    if (cred instanceof Response) return cred;
    const body = await readJson(c);
    if (!body || typeof body.model !== "string")
      return fail(c, "responses", 400, "bad_request", "A model is required.");
    const managed = d.providers.codingAgents[cred.agent]!.managed!;
    // Codex never sends a limit: set one, and never above the agent's.
    const asked =
      typeof body.max_output_tokens === "number" && body.max_output_tokens > 0 ? body.max_output_tokens : Infinity;
    body.max_output_tokens = Math.min(asked, managed.maxOutputTokens);
    const up = cred.provider === "xai" ? d.upstreams.xai : d.upstreams.openai;
    if (!up) return fail(c, "responses", 503, "managed_disabled", "IA de Chalyb is paused for this agent.");
    return forward(c, {
      wire: "responses",
      cred,
      model: body.model,
      body,
      url: `${up.baseUrl.replace(/\/$/, "")}/responses`,
      headers: { authorization: `Bearer ${up.apiKey}`, accept: body.stream ? "text/event-stream" : "application/json" },
      stream: body.stream === true,
      meter: true,
    });
  });

  // Grok Build lists models at start: the session's allowlist, in OpenAI's shape.
  app.get("/v1/models", async (c) => {
    const cred = await authorize(c, "responses");
    if (cred instanceof Response) return cred;
    c.header("cache-control", "no-store");
    return c.json({
      object: "list",
      data: cred.models.map((id) => ({ id, object: "model", created: 0, owned_by: "chalyb" })),
    });
  });

  // Gemini CLI: generateContent, streamGenerateContent (SSE) and countTokens (free at Google: forwarded, not billed).
  app.post("/v1beta/models/:target", async (c) => {
    const cred = await authorize(c, "gemini");
    if (cred instanceof Response) return cred;
    const m = /^([A-Za-z0-9._-]{1,80}):(generateContent|streamGenerateContent|countTokens)$/.exec(
      c.req.param("target"),
    );
    if (!m) return fail(c, "gemini", 404, "not_found", "Unknown method.");
    const [, model, method] = m as unknown as [string, string, string];
    const body = await readJson(c);
    if (!body) return fail(c, "gemini", 400, "bad_request", "A JSON body is required.");
    const managed = d.providers.codingAgents[cred.agent]!.managed!;
    if (method !== "countTokens") {
      const gc = (
        body.generationConfig && typeof body.generationConfig === "object" ? body.generationConfig : {}
      ) as Record<string, unknown>;
      const asked = typeof gc.maxOutputTokens === "number" && gc.maxOutputTokens > 0 ? gc.maxOutputTokens : Infinity;
      body.generationConfig = { ...gc, maxOutputTokens: Math.min(asked, managed.maxOutputTokens) };
    }
    const up = d.upstreams.google;
    if (!up) return fail(c, "gemini", 503, "managed_disabled", "IA de Chalyb is paused for this agent.");
    const stream = method === "streamGenerateContent";
    return forward(c, {
      wire: "gemini",
      cred,
      model,
      body,
      url: `${up.baseUrl.replace(/\/$/, "")}/v1beta/models/${model}:${method}${stream ? "?alt=sse" : ""}`,
      headers: { "x-goog-api-key": up.apiKey },
      stream,
      meter: method !== "countTokens",
    });
  });

  app.onError((err, c) => {
    log("unhandled", { error: errorMessage(err) });
    return c.json({ error: { message: "internal", code: "internal" } }, 500);
  });
  return app;
};
