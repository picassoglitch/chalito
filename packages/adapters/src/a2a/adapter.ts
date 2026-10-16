import { randomUUID } from "node:crypto";
import { A2A_PROTOCOL_VERSION, A2A_VERSION_HEADER, AGENT_CARD_PATH, AgentCard, Role, TaskState } from "@a2a-js/sdk";
import type { Message, Part, StreamResponse, Task } from "@a2a-js/sdk";
import { type Client, ClientFactory, JsonRpcTransportFactory, RestTransportFactory } from "@a2a-js/sdk/client";
import { AgentCard as LinkAgentCard, type AdapterKind, type Origin } from "@chalito/protocol";
import type { AdapterEvent, SessionAdapter, SessionHandle, SessionStartOptions } from "../core.js";

/**
 * The `a2a` recipe driver (ADR 0022 §4): a remote A2A v1.0 agent (its base URL plus the Agent
 * Card it publishes at `/.well-known/agent-card.json`) runs as a Chalito session, through the
 * official `@a2a-js/sdk` client over the JSON-RPC or HTTP+JSON binding the card offers. The
 * session is one A2A `contextId`; every prompt is a message (a new task, or the continuation of a
 * task that asked for input).
 *
 * The remote agent runs on its own side: Chalito gives it no local tool, no file and no command,
 * so nothing here calls the gate. What it returns is text shown in the session. The person's key
 * (keychain) is sent only to interfaces on the recipe's own origin.
 */

export interface A2aRecipe {
  readonly id: string;
  readonly name: string;
  readonly driver: {
    readonly a2a?: { readonly url: string; readonly binding?: "JSONRPC" | "HTTP+JSON" | undefined } | undefined;
  };
}

export interface A2aConfig {
  /** The person's token or key for the remote agent (keychain). */
  apiKey?: string;
  /** Injected in tests (the SDK's transports and card resolver use it). */
  fetch?: typeof fetch;
}

const BINDINGS = ["JSONRPC", "HTTP+JSON"] as const;

class A2aAuthError extends Error {
  readonly code = "auth_required";
}
const MAX_TEXT = 200_000;

type ErrorCode = Extract<AdapterEvent, { type: "error" }>["code"];
const errorCode = (message: string): ErrorCode => {
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|auth/i.test(message)) return "auth_required";
  if (/\b429\b|rate.?limit|too many/i.test(message)) return "rate_limited";
  if (/quota|credit|billing|\b402\b/i.test(message)) return "quota_exhausted";
  return "internal";
};
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Why `recipe` can't drive an a2a session, or null when it can. */
export const a2aRecipeProblem = (recipe: A2aRecipe): string | null => {
  const a = recipe.driver.a2a;
  if (!a) return `${recipe.name} has no a2a driver`;
  try {
    const u = new URL(a.url);
    if (u.protocol !== "https:") return `${recipe.name}'s A2A URL must be https`;
    if (u.username || u.password || u.search || u.hash)
      return `${recipe.name}'s A2A URL carries credentials or a query`;
  } catch {
    return `${recipe.name}'s A2A URL isn't a URL`;
  }
  return null;
};

/**
 * The text of A2A parts: text parts as they are (an appended artifact arrives as consecutive text
 * parts, so they're joined without a separator), a data part as JSON on its own line, a file by
 * reference only (never downloaded).
 */
export const partsText = (parts: readonly Part[] | undefined): string =>
  (parts ?? [])
    .map((p) => {
      const c = p.content;
      if (!c) return "";
      if (c.$case === "text") return c.value;
      if (c.$case === "data") return `\n${JSON.stringify(c.value)}\n`;
      if (c.$case === "url") return `\n[${p.filename || "file"}: ${c.value}]\n`;
      return `\n[${p.filename || "file"} (${p.mediaType || "binary"}) omitted]\n`;
    })
    .join("")
    .replace(/^\n+|\n+$/g, "")
    .replace(/\n{2,}/g, "\n");

/**
 * The card's interfaces Chalito may use: A2A 1.0, JSON-RPC or HTTP+JSON, https on the recipe's
 * own origin (the key never goes anywhere else), the recipe's preferred binding first.
 */
export const usableInterfaces = (card: AgentCard, recipeUrl: string, prefer: "JSONRPC" | "HTTP+JSON" = "JSONRPC") => {
  const origin = new URL(recipeUrl).origin;
  return card.supportedInterfaces
    .filter((i) => (BINDINGS as readonly string[]).includes(i.protocolBinding.toUpperCase()))
    .filter((i) => !i.protocolVersion || i.protocolVersion === A2A_PROTOCOL_VERSION)
    .filter((i) => {
      try {
        const u = new URL(i.url);
        return u.protocol === "https:" && u.origin === origin;
      } catch {
        return false;
      }
    })
    .sort(
      (a, b) => Number(b.protocolBinding.toUpperCase() === prefer) - Number(a.protocolBinding.toUpperCase() === prefer),
    );
};

/** How the card asks for credentials: an API-key header it names, else a bearer token. */
export const authHeader = (card: AgentCard, key: string): Record<string, string> => {
  for (const s of Object.values(card.securitySchemes ?? {})) {
    const x = s.scheme;
    if (
      x?.$case === "apiKeySecurityScheme" &&
      x.value.location.toLowerCase() === "header" &&
      /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(x.value.name)
    )
      return { [x.value.name]: key };
  }
  return { authorization: `Bearer ${key}` };
};

const textPart = (text: string): Part => ({
  content: { $case: "text", value: text },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain",
});

export class A2aAdapter implements SessionAdapter {
  readonly kind: AdapterKind = "a2a";
  readonly appId: string;
  readonly #url: string;
  readonly #binding: "JSONRPC" | "HTTP+JSON";
  readonly #name: string;

  constructor(
    recipe: A2aRecipe,
    private readonly config: A2aConfig = {},
  ) {
    const problem = a2aRecipeProblem(recipe);
    if (problem) throw new Error(problem);
    this.#url = recipe.driver.a2a!.url.replace(/\/+$/, "");
    this.#binding = recipe.driver.a2a!.binding ?? "JSONRPC";
    this.#name = recipe.name;
    this.appId = recipe.id;
  }

  /**
   * The Agent Card at `{url}/.well-known/agent-card.json` (A2A 1.0 §8.2), in ProtoJSON. Bounded
   * and checked against Chalito's AgentCard schema before the SDK's codec reads it.
   */
  async #card(base: typeof fetch): Promise<AgentCard> {
    const res = await base(`${this.#url}/${AGENT_CARD_PATH}`, {
      headers: { accept: "application/json", [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok)
      throw Object.assign(new Error(`its Agent Card answered HTTP ${res.status}`), { code: "adapter_crash" });
    const text = await res.text();
    if (text.length > 256 * 1024)
      throw Object.assign(new Error("its Agent Card is too large"), { code: "adapter_crash" });
    const json: unknown = JSON.parse(text);
    const checked = LinkAgentCard.safeParse(json);
    if (!checked.success)
      throw Object.assign(new Error("its Agent Card isn't a valid A2A 1.0 card"), { code: "adapter_crash" });
    return AgentCard.fromJSON(json);
  }

  /** Fetches the card and builds a client on its best usable interface. */
  async connect(): Promise<{ card: AgentCard; client: Client }> {
    const base = this.config.fetch ?? fetch;
    const card = await this.#card(base);
    const usable = usableInterfaces(card, this.#url, this.#binding);
    if (!usable.length)
      throw Object.assign(
        new Error(
          `${this.#name}'s Agent Card offers no A2A ${A2A_PROTOCOL_VERSION} JSON-RPC or HTTP+JSON interface on ${new URL(this.#url).origin}`,
        ),
        {
          code: "adapter_crash",
        },
      );
    const extra = this.config.apiKey ? authHeader(card, this.config.apiKey) : {};
    const origin = new URL(this.#url).origin;
    // The key goes only to the recipe's origin, whatever URL a transport is handed.
    const authed = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.origin !== origin) throw new Error(`refused to call ${url.origin}`);
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(extra)) headers.set(k, v);
      // A redirect would carry the key to wherever it points: refused (never followed).
      const res = await base(input, { ...init, headers, redirect: "error" });
      // The SDK's errors don't keep the HTTP status; an auth refusal must still read as one.
      if (res.status === 401 || res.status === 403)
        throw new A2aAuthError(`HTTP ${res.status}: the agent refused the credentials`);
      return res;
    }) as typeof fetch;
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: authed }), new RestTransportFactory({ fetchImpl: authed })],
      preferredTransports: usable.map((i) => i.protocolBinding),
    });
    const client = await factory.createFromAgentCard({ ...card, supportedInterfaces: usable });
    return { card, client };
  }

  async start(opts: SessionStartOptions): Promise<SessionHandle> {
    let connected: { card: AgentCard; client: Client };
    try {
      connected = await this.connect();
    } catch (err) {
      const message = messageOf(err);
      const known = (err as { code?: unknown }).code;
      throw Object.assign(new Error(`${this.#name}: ${message}`), {
        code:
          typeof known === "string"
            ? known
            : errorCode(message) === "auth_required"
              ? "auth_required"
              : "adapter_crash",
      });
    }
    const { card, client } = connected;
    const streaming = card.capabilities?.streaming === true;
    const contextId = opts.resume ?? randomUUID();
    let closed = false;
    let interrupted = false;
    let turn: Promise<void> | null = null;
    let turnAbort = new AbortController();
    /** The task that asked for more input: the next prompt continues it. */
    let openTaskId = "";
    let currentTaskId = "";
    const queue: { text: string; origin: Origin }[] = [];
    let doneResolve!: () => void;
    const done = new Promise<void>((r) => (doneResolve = r));

    const say = (text: string) => {
      if (text) opts.onEvent({ type: "assistant_text", text: text.slice(0, MAX_TEXT) });
    };

    /** Applies one A2A event; returns the task state when it's final for this turn. */
    const artifacts = new Map<string, string>();
    const apply = (
      r: StreamResponse | { payload: { $case: "task"; value: Task } | { $case: "message"; value: Message } },
    ): TaskState | null => {
      const p = r.payload;
      if (!p) return null;
      switch (p.$case) {
        case "message":
          if (p.value.role === Role.ROLE_AGENT) say(partsText(p.value.parts));
          return TaskState.TASK_STATE_COMPLETED;
        case "task": {
          currentTaskId = p.value.id;
          for (const a of p.value.artifacts) say(partsText(a.parts));
          const st = p.value.status;
          if (st?.message && st.message.role === Role.ROLE_AGENT) say(partsText(st.message.parts));
          return st ? finalState(st.state) : null;
        }
        case "artifactUpdate": {
          const a = p.value.artifact;
          if (!a) return null;
          // Chunks build up until the last one; an artifact without lastChunk is said at the turn's end.
          const prev = p.value.append ? (artifacts.get(a.artifactId) ?? "") : "";
          const text = (prev + partsText(a.parts)).slice(0, MAX_TEXT);
          if (p.value.lastChunk) {
            artifacts.delete(a.artifactId);
            say(text);
          } else artifacts.set(a.artifactId, text);
          return null;
        }
        case "statusUpdate": {
          const st = p.value.status;
          if (!st) return null;
          if (st.message && st.message.role === Role.ROLE_AGENT) say(partsText(st.message.parts));
          return finalState(st.state);
        }
      }
    };
    const finalState = (s: TaskState): TaskState | null =>
      s === TaskState.TASK_STATE_SUBMITTED || s === TaskState.TASK_STATE_WORKING ? null : s;

    const runTurn = async (prompt: string, signal: AbortSignal): Promise<TaskState> => {
      artifacts.clear();
      currentTaskId = "";
      const message: Message = {
        messageId: randomUUID(),
        contextId,
        taskId: openTaskId,
        role: Role.ROLE_USER,
        parts: [textPart(prompt)],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      };
      const req = { tenant: "", message, configuration: undefined, metadata: undefined };
      let last: TaskState = TaskState.TASK_STATE_COMPLETED;
      if (streaming) {
        for await (const ev of client.sendMessageStream(req, { signal })) {
          const s = apply(ev);
          if (s !== null) last = s;
        }
      } else {
        const r = await client.sendMessage(req, { signal });
        const s =
          "messageId" in r
            ? apply({ payload: { $case: "message", value: r } })
            : apply({ payload: { $case: "task", value: r } });
        if (s !== null) last = s;
      }
      for (const text of artifacts.values()) say(text);
      return last;
    };

    const startTurn = (prompt: string, _origin: Origin) => {
      interrupted = false;
      turnAbort = new AbortController();
      const signal = turnAbort.signal;
      opts.onEvent({ type: "state", state: "running" });
      turn = runTurn(prompt, signal).then(
        (state) => {
          if (closed) return;
          openTaskId = state === TaskState.TASK_STATE_INPUT_REQUIRED ? currentTaskId : "";
          if (signal.aborted || state === TaskState.TASK_STATE_CANCELED) {
            if (!interrupted) opts.onEvent({ type: "state", state: "interrupted" });
            return;
          }
          if (state === TaskState.TASK_STATE_AUTH_REQUIRED)
            opts.onEvent({ type: "error", code: "auth_required", message: `${this.#name} needs you to sign in again` });
          else if (state === TaskState.TASK_STATE_FAILED || state === TaskState.TASK_STATE_REJECTED)
            opts.onEvent({
              type: "error",
              code: "internal",
              message: `${this.#name} ${state === TaskState.TASK_STATE_REJECTED ? "rejected" : "failed"} the task`,
            });
          // A remote task's end, good or bad, leaves the session ready for the next prompt.
          opts.onEvent({ type: "state", state: "idle" });
        },
        (err: unknown) => {
          if (closed || interrupted || signal.aborted) return;
          const message = messageOf(err);
          const auth = err instanceof A2aAuthError || (err as { cause?: unknown }).cause instanceof A2aAuthError;
          opts.onEvent({
            type: "error",
            code: auth ? "auth_required" : errorCode(message),
            message: `${this.#name}: ${message}`.slice(0, 500),
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

    const cancelRemote = async () => {
      const id = currentTaskId;
      if (!id) return;
      await client.cancelTask({ tenant: "", id, metadata: undefined }).catch(() => undefined);
    };

    const handle: SessionHandle = {
      prompt: (text, origin) => {
        if (closed) return;
        if (turn) queue.push({ text, origin });
        else startTurn(text, origin);
      },
      interrupt: async () => {
        interrupted = true;
        queue.length = 0;
        const wasRunning = !!turn;
        turnAbort.abort();
        if (wasRunning) await cancelRemote();
        await turn?.catch(() => undefined);
        opts.onEvent({ type: "state", state: "interrupted" });
      },
      // Nothing runs locally; the remote agent has no Chalito permission mode to apply.
      setPermissionMode: async () => undefined,
      close: () => {
        if (closed) return;
        closed = true;
        queue.length = 0;
        const wasRunning = !!turn;
        turnAbort.abort();
        void (async () => {
          if (wasRunning) await cancelRemote();
          await turn?.catch(() => undefined);
          opts.onEvent({ type: "state", state: "completed" });
          doneResolve();
        })();
      },
      done,
    };

    opts.onEvent({ type: "started", providerSessionId: contextId });
    startTurn(opts.prompt, opts.origin);
    return handle;
  }
}
