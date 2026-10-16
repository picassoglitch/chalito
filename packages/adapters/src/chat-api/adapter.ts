import { randomUUID } from "node:crypto";
import type { AdapterKind, Origin } from "@chalito/protocol";
import type { AdapterEvent, LocalMcpServer, SessionAdapter, SessionHandle, SessionStartOptions } from "../core.js";
import { readSse } from "./sse.js";

/**
 * The `chat-api` recipe driver (ADR 0022 §4): any OpenAI-compatible Chat Completions endpoint
 * (`POST {baseUrl}/chat/completions`, `stream: true`, server-sent events ending in `data: [DONE]`)
 * runs as a Chalito session. The provider is reached with the person's OWN key from this
 * computer's keychain, and nothing else: no Chalito credential, no proxy.
 *
 * By default the model only talks (text in, text out). It gets tools only when the recipe says the
 * provider supports tool calls AND the session was given Chalito's computer-control MCP server
 * (which only happens when the person turned it on locally). Every tool call then goes through
 * the session's gate first, exactly like Claude Code's `mcp__<server>__<tool>` calls, so the
 * policy classifier and the signed approvals apply unchanged. There is no other tool.
 */

/** The part of a recipe (packages/protocol `Recipe`) this driver reads. Structural, like AcpRecipe. */
export interface ChatApiRecipe {
  readonly id: string;
  readonly name: string;
  readonly driver: {
    readonly chatApi?:
      | {
          readonly baseUrl: string;
          readonly model?: string | undefined;
          readonly tools?: boolean | undefined;
          readonly streamUsage?: boolean | undefined;
          readonly headers?: Readonly<Record<string, string>> | undefined;
        }
      | undefined;
  };
}

/** One tool the model may call, already mapped to the name and input the gate classifies. */
export interface ChatTool {
  /** The name the model sees (`^[A-Za-z0-9_-]{1,64}$`, the OpenAI function-name rule). */
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the arguments. */
  readonly parameters: Record<string, unknown>;
  /** The Chalito tool name the gate sees (`mcp__chalito_computer__screenshot`, …). */
  readonly toolName: string;
}

/** The tools of the session's local MCP servers (tools.ts builds it from `mcpServers`). */
export interface ChatToolBridge {
  readonly tools: readonly ChatTool[];
  /** Runs one tool AFTER the gate allowed it; the result is text for the model. */
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ ok: boolean; text: string }>;
  close(): Promise<void>;
}

export type ChatToolConnector = (servers: Record<string, LocalMcpServer>) => Promise<ChatToolBridge | null>;

export interface ChatApiConfig {
  /** The person's key (keychain); omitted for an endpoint that needs none (a local server). */
  apiKey?: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
  /** Builds the tool bridge from the session's MCP servers. Without one, the session has no tools. */
  connectTools?: ChatToolConnector;
  /** Tool rounds per prompt before Chalito stops the turn (default 16). */
  maxToolRounds?: number;
  /** Messages kept in the conversation (oldest dropped first, the system frame kept; default 200). */
  maxMessages?: number;
  /** Per request (connect + full stream; default 10 min). */
  requestTimeoutMs?: number;
}

const MAX_TEXT = 200_000;
const MAX_TOOL_RESULT = 50_000;
/** The name of the built-in tool a model uses to ask the human (only offered alongside the gated tools). */
export const ASK_TOOL = "ask_user";

type Role = "system" | "user" | "assistant" | "tool";
interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface WireMessage {
  role: Role;
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

type ErrorCode = Extract<AdapterEvent, { type: "error" }>["code"];
class ChatApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const errorCodeFor = (status: number, body: string): ErrorCode => {
  if (status === 401 || status === 403) return "auth_required";
  if (status === 402 || /quota|insufficient|credit|balance|billing/i.test(body)) return "quota_exhausted";
  if (status === 429) return "rate_limited";
  return "internal";
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * OpenAI usage → Chalito's usage event (the hub's `llm.tokens` meter: input + output + cache_read
 * + cache_write). `prompt_tokens` includes cached tokens, so they're split out. DeepSeek's
 * `prompt_cache_hit_tokens` is the same number as `prompt_tokens_details.cached_tokens`.
 */
export const usageEvent = (u: unknown, model: string): Extract<AdapterEvent, { type: "usage" }> | null => {
  const x = rec(u);
  if (!Object.keys(x).length) return null;
  const prompt = num(x.prompt_tokens);
  const cached = Math.min(prompt, num(rec(x.prompt_tokens_details).cached_tokens) || num(x.prompt_cache_hit_tokens));
  return {
    type: "usage",
    tokIn: prompt - cached,
    tokOut: num(x.completion_tokens),
    tokCacheRead: cached,
    tokCacheWrite: 0,
    model,
  };
};

/** Why `recipe` can't drive a chat-api session, or null when it can. */
export const chatApiRecipeProblem = (recipe: ChatApiRecipe): string | null => {
  const c = recipe.driver.chatApi;
  if (!c) return `${recipe.name} has no chat-api driver`;
  let u: URL;
  try {
    u = new URL(c.baseUrl);
  } catch {
    return `${recipe.name}'s base URL isn't a URL`;
  }
  if (u.username || u.password || u.search || u.hash) return `${recipe.name}'s base URL carries credentials or a query`;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback))
    return `${recipe.name}'s base URL must be https (or http on this computer)`;
  return null;
};

export class ChatApiAdapter implements SessionAdapter {
  readonly kind: AdapterKind = "chat-api";
  readonly appId: string;
  readonly #api: NonNullable<ChatApiRecipe["driver"]["chatApi"]>;
  readonly #name: string;

  constructor(
    recipe: ChatApiRecipe,
    private readonly config: ChatApiConfig = {},
  ) {
    const problem = chatApiRecipeProblem(recipe);
    if (problem) throw new Error(problem);
    this.#api = recipe.driver.chatApi!;
    this.#name = recipe.name;
    this.appId = recipe.id;
  }

  get #base() {
    return this.#api.baseUrl.replace(/\/+$/, "");
  }

  #headers(stream: boolean): Record<string, string> {
    return {
      ...this.#api.headers,
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
    };
  }

  /** The recipe's model, else the first one the server lists (a local server's pulled model). */
  async #model(signal: AbortSignal): Promise<string> {
    if (this.#api.model) return this.#api.model;
    const res = await (this.config.fetch ?? fetch)(`${this.#base}/models`, {
      headers: this.#headers(false),
      // The key never follows a redirect to another host.
      redirect: "error",
      signal,
    });
    const text = await res.text();
    if (!res.ok) throw new ChatApiError(errorCodeFor(res.status, text), `${this.#name}: /models ${res.status}`);
    const data = rec(JSON.parse(text)).data;
    const id = Array.isArray(data) ? rec(data[0]).id : undefined;
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/.test(id))
      throw new ChatApiError("internal", `${this.#name} lists no model; pull or load one first`);
    return id;
  }

  async start(opts: SessionStartOptions): Promise<SessionHandle> {
    const providerSessionId = opts.resume ?? `chat_${randomUUID().replace(/-/g, "")}`;
    const startAbort = new AbortController();
    const model = await this.#model(startAbort.signal).catch((err: unknown) => {
      const code = err instanceof ChatApiError ? err.code : "adapter_crash";
      throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), { code });
    });

    // Tools: only the session's own (gated) local MCP servers, only if the provider does tool calls.
    const bridge =
      this.#api.tools && opts.mcpServers && Object.keys(opts.mcpServers).length && this.config.connectTools
        ? await this.config.connectTools(opts.mcpServers)
        : null;
    const toolByName = new Map((bridge?.tools ?? []).map((t) => [t.name, t]));
    const wireTools = bridge
      ? [
          ...bridge.tools.map((t) => ({
            type: "function" as const,
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          {
            type: "function" as const,
            function: {
              name: ASK_TOOL,
              description: "Ask the person a question and wait for their answer.",
              parameters: {
                type: "object",
                properties: {
                  question: { type: "string" },
                  options: { type: "array", items: { type: "string" } },
                },
                required: ["question"],
              },
            },
          },
        ]
      : null;

    const messages: WireMessage[] = [];
    let origin: Origin = opts.origin;
    let closed = false;
    let interrupted = false;
    let turn: Promise<void> | null = null;
    let turnAbort = new AbortController();
    const queue: { text: string; origin: Origin }[] = [];
    let doneResolve!: () => void;
    const done = new Promise<void>((r) => (doneResolve = r));
    const maxRounds = this.config.maxToolRounds ?? 16;
    const maxMessages = this.config.maxMessages ?? 200;

    const trim = () => {
      // Drop whole exchanges from the front: never leave a tool result without its call.
      while (messages.length > maxMessages) {
        messages.shift();
        while (messages[0] && messages[0].role !== "user") messages.shift();
      }
    };

    /** One streamed completion: its text, its tool calls, and its usage. */
    const complete = async (signal: AbortSignal) => {
      const timeout = AbortSignal.timeout(this.config.requestTimeoutMs ?? 10 * 60_000);
      const res = await (this.config.fetch ?? fetch)(`${this.#base}/chat/completions`, {
        method: "POST",
        headers: this.#headers(true),
        redirect: "error",
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          ...(this.#api.streamUsage ? { stream_options: { include_usage: true } } : {}),
          ...(wireTools ? { tools: wireTools } : {}),
        }),
        signal: AbortSignal.any([signal, timeout]),
      });
      if (!res.ok || !res.body) {
        const body = (await res.text().catch(() => "")).slice(0, 500);
        throw new ChatApiError(errorCodeFor(res.status, body), `${this.#name}: HTTP ${res.status}`);
      }
      let text = "";
      let usage: unknown = null;
      const calls = new Map<number, WireToolCall>();
      for await (const data of readSse(res.body)) {
        if (data === "[DONE]") break;
        let chunk: Record<string, unknown>;
        try {
          chunk = rec(JSON.parse(data));
        } catch {
          continue;
        }
        if (chunk.error)
          throw new ChatApiError("internal", `${this.#name}: ${String(rec(chunk.error).message ?? "error")}`);
        // Groq reports usage under x_groq; everyone else on the last chunk (with include_usage).
        const u = chunk.usage ?? rec(chunk.x_groq).usage;
        if (u) usage = u;
        const choice = rec(Array.isArray(chunk.choices) ? chunk.choices[0] : undefined);
        const delta = rec(choice.delta);
        if (typeof delta.content === "string" && text.length < MAX_TEXT) text += delta.content;
        if (Array.isArray(delta.tool_calls)) {
          for (const raw of delta.tool_calls) {
            const d = rec(raw);
            const i = typeof d.index === "number" ? d.index : 0;
            const f = rec(d.function);
            const cur = calls.get(i) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
            if (typeof d.id === "string") cur.id = d.id;
            if (typeof f.name === "string") cur.function.name += f.name;
            if (typeof f.arguments === "string" && cur.function.arguments.length < MAX_TEXT)
              cur.function.arguments += f.arguments;
            calls.set(i, cur);
          }
        }
      }
      return { text, calls: [...calls.values()].map((c, i) => ({ ...c, id: c.id || `call_${i}` })), usage };
    };

    /** Gate, then run, one tool call. Returns the tool message for the model. */
    const runTool = async (c: WireToolCall, signal: AbortSignal): Promise<WireMessage> => {
      const reply = (content: string): WireMessage => ({ role: "tool", tool_call_id: c.id, content });
      let args: Record<string, unknown>;
      try {
        args = rec(JSON.parse(c.function.arguments || "{}"));
      } catch {
        return reply("Error: the arguments weren't valid JSON.");
      }
      if (c.function.name === ASK_TOOL) {
        const question = typeof args.question === "string" ? args.question.slice(0, 2000) : "";
        if (!question) return reply("Error: a question is required.");
        const options = Array.isArray(args.options)
          ? args.options.filter((o): o is string => typeof o === "string").slice(0, 8)
          : [];
        const answers = await opts.askUser(
          {
            sid: opts.sid,
            questionId: `q_${randomUUID().replace(/-/g, "")}`,
            questions: [{ question, options: options.map((label) => ({ label })) }],
          },
          signal,
        );
        const a = answers[question];
        return reply(Array.isArray(a) ? a.join(", ") : (a ?? ""));
      }
      const tool = toolByName.get(c.function.name);
      // A name the model made up is never run; it's an unknown tool, refused.
      if (!tool || !bridge) return reply(`Error: there is no tool named ${c.function.name}.`);
      opts.onEvent({ type: "tool_started", toolUseId: c.id, toolName: tool.toolName, input: args });
      // A gate failure is a denial, never an approval.
      const allowed = await opts
        .gate({ sid: opts.sid, toolUseId: c.id, toolName: tool.toolName, input: args, origin }, signal)
        .then(
          (g) => g.allow && !signal.aborted,
          () => false,
        );
      if (!allowed) {
        opts.onEvent({ type: "tool_finished", toolUseId: c.id, ok: false });
        return reply("The person's policy didn't allow this action.");
      }
      const r = await bridge.call(c.function.name, args, signal).catch((err: unknown) => ({
        ok: false,
        text: `Error: ${err instanceof Error ? err.message : "the tool failed"}`,
      }));
      opts.onEvent({ type: "tool_finished", toolUseId: c.id, ok: r.ok });
      return reply(r.text.slice(0, MAX_TOOL_RESULT));
    };

    const runTurn = async (prompt: string, signal: AbortSignal) => {
      messages.push({ role: "user", content: prompt });
      trim();
      for (let round = 0; ; round++) {
        if (round >= maxRounds)
          throw new ChatApiError("internal", `${this.#name} kept calling tools; the turn was stopped`);
        const r = await complete(signal);
        const ev = usageEvent(r.usage, model);
        if (ev) opts.onEvent(ev);
        if (r.text) opts.onEvent({ type: "assistant_text", text: r.text });
        const calls = wireTools ? r.calls : [];
        messages.push({ role: "assistant", content: r.text || null, ...(calls.length ? { tool_calls: calls } : {}) });
        if (!calls.length) return;
        for (const c of calls) {
          if (signal.aborted) return;
          messages.push(await runTool(c, signal));
        }
      }
    };

    const startTurn = (prompt: string, turnOrigin: Origin) => {
      origin = turnOrigin;
      interrupted = false;
      turnAbort = new AbortController();
      const signal = turnAbort.signal;
      opts.onEvent({ type: "state", state: "running" });
      turn = runTurn(prompt, signal).then(
        () => {
          if (closed) return;
          if (signal.aborted) {
            if (!interrupted) opts.onEvent({ type: "state", state: "interrupted" });
          } else opts.onEvent({ type: "state", state: "idle" });
        },
        (err: unknown) => {
          if (closed || interrupted || signal.aborted) return;
          opts.onEvent({
            type: "error",
            code: err instanceof ChatApiError ? err.code : "internal",
            message: err instanceof Error ? err.message : String(err),
          });
          opts.onEvent({ type: "state", state: "failed" });
        },
      );
      void turn.finally(() => {
        turn = null;
        const n = queue.shift();
        if (n && !closed) startTurn(n.text, n.origin);
      });
    };

    const handle: SessionHandle = {
      prompt: (text, turnOrigin) => {
        if (closed) return;
        if (turn) queue.push({ text, origin: turnOrigin });
        else startTurn(text, turnOrigin);
      },
      interrupt: async () => {
        interrupted = true;
        queue.length = 0;
        turnAbort.abort();
        await turn?.catch(() => undefined);
        opts.onEvent({ type: "state", state: "interrupted" });
      },
      // The gate applies the permission mode to every tool call; the provider has no modes.
      setPermissionMode: async () => undefined,
      close: () => {
        if (closed) return;
        closed = true;
        queue.length = 0;
        turnAbort.abort();
        void (async () => {
          await turn?.catch(() => undefined);
          await bridge?.close().catch(() => undefined);
          opts.onEvent({ type: "state", state: "completed" });
          doneResolve();
        })();
      },
      done,
    };

    opts.onEvent({ type: "started", providerSessionId });
    startTurn(opts.prompt, opts.origin);
    return handle;
  }
}
