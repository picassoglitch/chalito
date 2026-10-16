import { afterAll, describe, expect, it } from "vitest";
import {
  ChatApiAdapter,
  chatApiRecipeProblem,
  readSse,
  usageEvent,
  type ChatToolBridge,
} from "../src/chat-api/index.js";
import type { AdapterEvent, SessionHandle } from "../src/core.js";
import { runConformance, waitFor, type ConformanceStep } from "./conformance.js";
import { startMockChat, type MockReply, type MockRequest } from "./chat-api-fixture.js";

/**
 * The `chat-api` driver against a mocked OpenAI-compatible server (real HTTP on loopback, SSE
 * streaming): the shared SessionAdapter conformance suite (tools via a gated bridge, the way the
 * computer-control MCP reaches it), plus text-only by default, usage, auth and errors.
 */
const mock = await startMockChat({ models: ["llama3.2:3b", "qwen3"] });
afterAll(() => mock.close());

const recipe = (over: Record<string, unknown> = {}) => ({
  id: "test-chat",
  name: "Test chat",
  driver: { chatApi: { baseUrl: mock.baseUrl, model: "test-model", tools: true, streamUsage: true, ...over } },
});
const SERVERS = { chalito_computer: { command: "unused", args: [], env: {} } };
const DENIED = "The person's policy didn't allow this action.";

/** Turns of conformance steps → the replies the mock streams (text before a tool rides with it). */
const repliesFor = (turns: ConformanceStep[][]): MockReply[] =>
  turns.flatMap((steps) => {
    const out: MockReply[] = [];
    let text = "";
    let lastWasTool = false;
    for (const s of steps) {
      if ("say" in s) {
        text += s.say;
        lastWasTool = false;
        continue;
      }
      const tool =
        "bash" in s
          ? { name: "Bash", args: { command: s.bash } }
          : "edit" in s
            ? { name: "Edit", args: { file_path: s.edit } }
            : { name: "ask_user", args: { question: s.ask.question, options: s.ask.options } };
      out.push({ tools: [tool], ...(text ? { text } : {}) });
      text = "";
      lastWasTool = true;
    }
    if (text || lastWasTool || !out.length) out.push({ text });
    return out;
  });

/** Tool calls and their replies, from the conversation the adapter sent last. */
const exchanges = (reqs: MockRequest[]) => {
  const msgs = reqs.at(-1)?.body.messages ?? [];
  const out: { name: string; args: Record<string, unknown>; reply: string | null }[] = [];
  for (const m of msgs)
    for (const c of (m.tool_calls ?? []) as unknown as {
      id: string;
      function: { name: string; arguments: string };
    }[]) {
      const reply = msgs.find((x) => x.role === "tool" && x.tool_call_id === c.id);
      out.push({ name: c.function.name, args: JSON.parse(c.function.arguments), reply: reply?.content ?? null });
    }
  return out;
};

const fakeBridge = (ran: { tool: string; target: string }[]): ChatToolBridge => ({
  tools: [
    { name: "Bash", description: "Run a command", parameters: { type: "object" }, toolName: "Bash" },
    { name: "Edit", description: "Edit a file", parameters: { type: "object" }, toolName: "Edit" },
  ],
  call: async (name, args) => {
    ran.push({ tool: name, target: String(args.command ?? args.file_path ?? "") });
    return { ok: true, text: "done" };
  },
  close: async () => undefined,
});

runConformance("chat-api (mock OpenAI-compatible server)", (turns) => {
  mock.script.splice(0, mock.script.length, ...repliesFor(turns));
  const first = mock.requests.length;
  const reqs = () => mock.requests.slice(first);
  const ran: { tool: string; target: string }[] = [];
  let interrupts = 0;
  const real = new ChatApiAdapter(recipe(), { apiKey: "sk-test", connectTools: async () => fakeBridge(ran) });
  return {
    adapter: {
      kind: real.kind,
      // Chat Completions has no cancel call: an interrupt abandons the turn (and its stream).
      start: async (o) => {
        const h = await real.start({ ...o, mcpServers: SERVERS });
        const wrapped: SessionHandle = {
          ...h,
          prompt: h.prompt,
          close: h.close,
          setPermissionMode: h.setPermissionMode,
          done: h.done,
          interrupt: async () => {
            interrupts++;
            await h.interrupt();
          },
        };
        return wrapped;
      },
    },
    ran: () => ran,
    refused: () =>
      exchanges(reqs())
        .filter((x) => x.name !== "ask_user" && x.reply === DENIED)
        .map((x) => ({ tool: x.name, target: String(x.args.command ?? x.args.file_path ?? "") })),
    answers: () =>
      exchanges(reqs())
        .filter((x) => x.name === "ask_user")
        .map((x) => [x.reply ?? ""]),
    interrupts: () => interrupts,
    // What the provider was allowed per request: only Chalito's gated tools, or text.
    appliedModes: () =>
      reqs().map((r) => {
        const names = (r.body.tools ?? []).map((t) => t.function.name);
        if (!names.length) return "text";
        return names.every((n) => ["Bash", "Edit", "ask_user"].includes(n)) ? "gated-tools" : "ungated";
      }),
    isFullAccess: (m) => m === "ungated",
    escalatesEveryTool: () =>
      reqs().every((r) => (r.body.tools ?? []).every((t) => ["Bash", "Edit", "ask_user"].includes(t.function.name))),
    violations: () => {
      const v: string[] = [];
      for (const r of reqs()) {
        const msgs = r.body.messages;
        const callIds = new Set(msgs.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)));
        for (const m of msgs)
          if (m.role === "tool" && !callIds.has(m.tool_call_id!)) v.push("tool reply without a call");
        for (const id of callIds)
          if (!msgs.some((m) => m.role === "tool" && m.tool_call_id === id)) v.push(`call ${id} without a reply`);
        if (r.body.stream !== true) v.push("not streamed");
      }
      return v;
    },
  };
});

const run = async (adapter: ChatApiAdapter, prompt = "hola", extra: Record<string, unknown> = {}) => {
  const events: AdapterEvent[] = [];
  const gated: string[] = [];
  const handle = await adapter.start({
    sid: "s1",
    cwd: "/ws",
    prompt,
    origin: "client:phone1",
    permissionMode: "default",
    gate: async (c) => {
      gated.push(c.toolName);
      return { allow: true };
    },
    askUser: async () => ({}),
    onEvent: (e) => events.push(e),
    ...extra,
  });
  const ended = () => events.some((e) => e.type === "state" && (e.state === "idle" || e.state === "failed"));
  return { events, gated, handle, ended };
};

describe("chat-api driver", () => {
  it("is text only by default: no tools offered, a tool call the model makes up is never run", async () => {
    mock.script.push({ tools: [{ name: "Bash", args: { command: "rm -rf /" } }], text: "voy" });
    const before = mock.requests.length;
    let bridged = 0;
    // A recipe without `tools`, and one with tools but no MCP server for the session.
    for (const a of [
      new ChatApiAdapter(recipe({ tools: undefined }), { connectTools: async () => (bridged++, null) }),
    ]) {
      const r = await run(a, "hola", { mcpServers: SERVERS });
      await waitFor(r.ended);
      expect(r.gated).toEqual([]);
      expect(mock.requests[before]!.body.tools).toBeUndefined();
      expect(r.events).toContainEqual({ type: "assistant_text", text: "voy" });
      r.handle.close();
      await r.handle.done;
    }
    expect(bridged).toBe(0);
    mock.script.push({ text: "ok" });
    const r = await run(new ChatApiAdapter(recipe(), { connectTools: async () => (bridged++, null) }));
    await waitFor(r.ended);
    expect(bridged).toBe(0); // no mcpServers given: no bridge is even built
    r.handle.close();
    await r.handle.done;
  });

  it("streams text, sends the key only as a bearer token, keeps the conversation across prompts", async () => {
    mock.script.push({ text: "Hola, ¿qué tal?" }, { text: "Bien." });
    const before = mock.requests.length;
    const r = await run(
      new ChatApiAdapter(recipe({ headers: { "X-OpenRouter-Title": "Chalito" } }), { apiKey: "sk-own" }),
    );
    await waitFor(r.ended);
    r.handle.prompt("¿y tú?", "mcp:claude");
    await waitFor(() => r.events.filter((e) => e.type === "state" && e.state === "idle").length === 2);
    const [a, b] = mock.requests.slice(before);
    expect(a!.auth).toBe("Bearer sk-own");
    expect(a!.headers["x-openrouter-title"]).toBe("Chalito");
    expect(a!.body).toMatchObject({ model: "test-model", stream: true, stream_options: { include_usage: true } });
    expect(b!.body.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hola"],
      ["assistant", "Hola, ¿qué tal?"],
      ["user", "¿y tú?"],
    ]);
    expect(r.events.filter((e) => e.type === "assistant_text")).toEqual([
      { type: "assistant_text", text: "Hola, ¿qué tal?" },
      { type: "assistant_text", text: "Bien." },
    ]);
    r.handle.close();
    await r.handle.done;
  });

  it("never follows a redirect with the key (every request is redirect: error)", async () => {
    mock.script.push({ text: "ok" });
    const modes: (RequestInit["redirect"] | undefined)[] = [];
    const r = await run(
      new ChatApiAdapter(recipe({ model: undefined }), {
        apiKey: "sk-own",
        fetch: async (input, init) => {
          modes.push(init?.redirect);
          return fetch(input, init);
        },
      }),
    );
    await waitFor(r.ended);
    expect(modes.length).toBeGreaterThanOrEqual(2); // /models, then /chat/completions
    expect(modes.every((m) => m === "error")).toBe(true);
    r.handle.close();
    await r.handle.done;
  });

  it("usage events fit the usage / hub admit-settle path (cached tokens split out; Groq's x_groq)", async () => {
    mock.script.push(
      { text: "a", usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } } },
      { text: "b", groqUsage: true, usage: { prompt_tokens: 7, completion_tokens: 3 } },
    );
    const r = await run(new ChatApiAdapter(recipe({ streamUsage: undefined })));
    await waitFor(r.ended);
    r.handle.prompt("otra", "client:phone1");
    await waitFor(() => r.events.filter((e) => e.type === "usage").length === 2);
    expect(r.events.filter((e) => e.type === "usage")).toEqual([
      { type: "usage", tokIn: 40, tokOut: 20, tokCacheRead: 60, tokCacheWrite: 0, model: "test-model" },
      { type: "usage", tokIn: 7, tokOut: 3, tokCacheRead: 0, tokCacheWrite: 0, model: "test-model" },
    ]);
    expect(mock.requests.at(-1)!.body.stream_options).toBeUndefined();
    expect(
      usageEvent({ prompt_tokens: 9, completion_tokens: 1, prompt_cache_hit_tokens: 4 }, "deepseek-flash"),
    ).toEqual({
      type: "usage",
      tokIn: 5,
      tokOut: 1,
      tokCacheRead: 4,
      tokCacheWrite: 0,
      model: "deepseek-flash",
    });
    r.handle.close();
    await r.handle.done;
  });

  it("without a model in the recipe, uses the first one the server lists (a local server)", async () => {
    mock.script.push({ text: "hi" });
    const r = await run(new ChatApiAdapter(recipe({ model: undefined })));
    await waitFor(r.ended);
    expect(mock.requests.at(-1)!.body.model).toBe("llama3.2:3b");
    r.handle.close();
    await r.handle.done;
  });

  it("maps provider errors: 401 auth_required, 429 rate_limited, 402 quota_exhausted", async () => {
    for (const [status, code] of [
      [401, "auth_required"],
      [429, "rate_limited"],
      [402, "quota_exhausted"],
    ] as const) {
      mock.script.push({ status });
      const r = await run(new ChatApiAdapter(recipe(), { apiKey: "bad" }));
      await waitFor(r.ended);
      expect(r.events.find((e) => e.type === "error")).toMatchObject({ code });
      expect(r.events.at(-1)).toEqual({ type: "state", state: "failed" });
      r.handle.close();
      await r.handle.done;
    }
  });

  it("interrupt during a stream aborts the HTTP request", async () => {
    mock.script.push({ hang: true });
    const r = await run(new ChatApiAdapter(recipe()));
    await waitFor(() => mock.requests.at(-1)?.body.messages.at(-1)?.content === "hola" && !mock.script.length);
    await new Promise((res) => setTimeout(res, 30));
    await r.handle.interrupt();
    await waitFor(() => mock.requests.at(-1)!.aborted);
    expect(r.events.at(-1)).toEqual({ type: "state", state: "interrupted" });
    r.handle.close();
    await r.handle.done;
  });

  it("stops a turn that keeps calling tools", async () => {
    const ran: { tool: string; target: string }[] = [];
    for (let i = 0; i < 3; i++) mock.script.push({ tools: [{ name: "Bash", args: { command: "ls" } }] });
    const r = await run(
      new ChatApiAdapter(recipe(), { connectTools: async () => fakeBridge(ran), maxToolRounds: 2 }),
      "x",
      {
        mcpServers: SERVERS,
      },
    );
    await waitFor(r.ended);
    expect(ran).toHaveLength(2);
    expect(r.events.find((e) => e.type === "error")?.message).toMatch(/kept calling tools/);
    mock.script.length = 0;
    r.handle.close();
    await r.handle.done;
  });

  it("recipes: https, or http only on loopback; no credentials or query", () => {
    const p = (baseUrl: string) => chatApiRecipeProblem({ id: "x", name: "X", driver: { chatApi: { baseUrl } } });
    expect(p("https://api.x.ai/v1")).toBeNull();
    expect(p("http://localhost:11434/v1")).toBeNull();
    expect(p("http://127.0.0.1:1234/v1")).toBeNull();
    expect(p("http://192.168.1.5:11434/v1")).toMatch(/https/);
    expect(p("https://u:p@api.example.com/v1")).toMatch(/credentials/);
    expect(p("https://api.example.com/v1?key=1")).toMatch(/credentials or a query/);
    expect(() => new ChatApiAdapter({ id: "x", name: "X", driver: {} })).toThrow(/no chat-api driver/);
  });

  it("readSse joins multi-line data, skips comments and other fields, handles CRLF split across chunks", async () => {
    const enc = new TextEncoder();
    const parts = [": ping\r", "\n", "event: x\r\ndata: a\r\ndata: b\r", "\n\r\n", "data: [DONE]\n\n"];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    });
    const out: string[] = [];
    for await (const d of readSse(body)) out.push(d);
    expect(out).toEqual(["a\nb", "[DONE]"]);
  });
});

describe("chat-api tool bridge (connectMcpTools)", () => {
  it("speaks to a stdio MCP server shaped like Chalito's computer control; names reach the gate as mcp__<server>__<tool>", async () => {
    const { connectMcpTools } = await import("../src/chat-api/index.js");
    const server = new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url).pathname;
    const bridge = await connectMcpTools({
      chalito_computer: { command: process.execPath, args: [server], env: { CHALITO_TEST_TOKEN: "tok1" } },
    });
    expect(bridge).not.toBeNull();
    expect(bridge!.tools.map((t) => [t.name, t.toolName])).toEqual([
      ["chalito_computer__screenshot", "mcp__chalito_computer__screenshot"],
      ["chalito_computer__click", "mcp__chalito_computer__click"],
    ]);
    const ctl = new AbortController();
    expect(await bridge!.call("chalito_computer__click", { x: 3, y: 4 }, ctl.signal)).toEqual({
      ok: true,
      text: "clicked 3,4 env=tok1",
    });
    expect(await bridge!.call("chalito_computer__screenshot", {}, ctl.signal)).toEqual({
      ok: true,
      text: "[image omitted]\n1280x800",
    });
    expect((await bridge!.call("nope", {}, ctl.signal)).ok).toBe(false);
    await bridge!.close();
  });

  it("a session with tools: the gate sees mcp__chalito_computer__click; a denial never reaches the server", async () => {
    const { connectMcpTools } = await import("../src/chat-api/index.js");
    const server = new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url).pathname;
    mock.script.push(
      { tools: [{ name: "chalito_computer__click", args: { x: 1, y: 2 } }] },
      { tools: [{ name: "chalito_computer__click", args: { x: 9, y: 9 } }] },
      { text: "listo" },
    );
    const events: AdapterEvent[] = [];
    const gated: { toolName: string; origin: string }[] = [];
    const before = mock.requests.length;
    const h = await new ChatApiAdapter(recipe(), { connectTools: connectMcpTools }).start({
      sid: "s1",
      cwd: "/ws",
      prompt: "haz clic",
      origin: "mcp:claude",
      permissionMode: "default",
      mcpServers: { chalito_computer: { command: process.execPath, args: [server], env: { CHALITO_TEST_TOKEN: "t" } } },
      gate: async (c) => {
        gated.push({ toolName: c.toolName, origin: c.origin });
        return c.input.x === 9 ? { allow: false, reason: "policy_block" } : { allow: true };
      },
      askUser: async () => ({}),
      onEvent: (e) => events.push(e),
    });
    await waitFor(() => events.some((e) => e.type === "state" && e.state === "idle"), 5000);
    expect(gated).toEqual([
      { toolName: "mcp__chalito_computer__click", origin: "mcp:claude" },
      { toolName: "mcp__chalito_computer__click", origin: "mcp:claude" },
    ]);
    const tools = mock.requests[before]!.body.tools!.map((t) => t.function.name);
    expect(tools).toEqual(["chalito_computer__screenshot", "chalito_computer__click", "ask_user"]);
    const replies = mock.requests
      .at(-1)!
      .body.messages.filter((m) => m.role === "tool")
      .map((m) => m.content);
    expect(replies).toEqual(["clicked 1,2 env=t", DENIED]);
    h.close();
    await h.done;
  });
});
