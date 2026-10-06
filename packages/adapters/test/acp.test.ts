import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AdapterEvent, SessionStartOptions, ToolCall } from "../src/core.js";
import {
  AcpAdapter,
  type AcpAdapterConfig,
  type AcpKind,
  GEMINI_POLICY,
  GROK_COMPAT_OFF,
  GROK_REQUIREMENTS,
  grokSandboxFor,
  toolCallsFor,
} from "../src/acp/index.js";
import { waitFor } from "./conformance.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

interface LogEntry {
  argv?: string[];
  env?: Record<string, string>;
  in?: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
  permission?: string;
  outcome?: { outcome: string; optionId?: string } | null;
}

/** One session against the fake agent, run in a fresh workspace with its own script. */
const setup = (
  kind: AcpKind,
  script: Record<string, unknown>,
  config: Partial<AcpAdapterConfig> = {},
  gate: (c: ToolCall, signal: AbortSignal) => Promise<boolean> = async () => true,
) => {
  const ws = mkdtempSync(join(tmpdir(), "chalito-acp-ws-"));
  const home = mkdtempSync(join(tmpdir(), "chalito-acp-home-"));
  writeFileSync(join(ws, ".fake-acp.json"), JSON.stringify(script));
  const calls: ToolCall[] = [];
  const events: AdapterEvent[] = [];
  const adapter = new AcpAdapter(kind, {
    binPath: FAKE,
    home,
    clientVersion: "0.1.0",
    startTimeoutMs: 10_000,
    env: {
      PATH: process.env.PATH,
      HOME: ws,
      // Never reaches the CLI (allowlist).
      OPENAI_API_KEY: "sk-must-not-leak",
      CHALITO_SECRETS_PASSPHRASE: "must-not-leak",
    },
    ...config,
  });
  const start = (over: Partial<SessionStartOptions> = {}) =>
    adapter.start({
      sid: "s1",
      cwd: ws,
      prompt: "hola",
      origin: "client:phone1",
      permissionMode: "default",
      gate: async (c, signal) => {
        calls.push(c);
        return (await gate(c, signal)) ? { allow: true } : { allow: false, reason: "policy_block" };
      },
      askUser: async () => ({}),
      onEvent: (e) => events.push(e),
      ...over,
    });
  const log = (): LogEntry[] =>
    existsSync(join(ws, ".fake-acp.log.jsonl"))
      ? readFileSync(join(ws, ".fake-acp.log.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as LogEntry)
      : [];
  const received = (method: string) => log().flatMap((e) => (e.in?.method === method ? [e.in] : []));
  const states = () => events.flatMap((e) => (e.type === "state" ? [e.state] : []));
  return { ws, home, calls, events, start, log, received, states };
};

describe("ACP adapter: Grok Build profile", () => {
  it("runs a full session: launch, API-key auth, streaming, gated tools, usage", async () => {
    const s = setup(
      "grok",
      {
        requireAuth: true,
        turns: [
          [
            { say: "Voy a " },
            { say: "correr los tests." },
            { tool: { id: "t1", kind: "execute", title: "pnpm test", rawInput: { command: "pnpm test" } } },
            { tool: { id: "t2", kind: "edit", title: "Edit src/a.ts", locations: [{ path: "/ws/src/a.ts" }] } },
            { say: "Listo." },
            { usage: { totalTokens: 150, inputTokens: 100, outputTokens: 50, cachedReadTokens: 40 } },
          ],
        ],
      },
      { apiKey: "xai-test-key" },
    );
    const h = await s.start();
    await waitFor(() => s.states().includes("idle"), 5000);

    const [boot] = s.log();
    expect(boot!.argv).toEqual(["--no-auto-update", "--sandbox", "workspace", "agent", "--no-leader", "stdio"]);
    expect(boot!.env!.XAI_API_KEY).toBe("xai-test-key");
    expect(boot!.env!.GROK_HOME).toBe(s.home);
    expect(boot!.env!.CHALITO_SESSION).toBe("1");
    for (const k of GROK_COMPAT_OFF) expect(boot!.env![k]).toBe("false");
    expect(boot!.env!.OPENAI_API_KEY).toBeUndefined();
    expect(boot!.env!.CHALITO_SECRETS_PASSPHRASE).toBeUndefined();
    expect(readFileSync(join(s.home, "requirements.toml"), "utf8")).toBe(GROK_REQUIREMENTS);
    if (process.platform !== "win32") expect(statSync(s.home).mode & 0o777).toBe(0o700);

    const [init] = s.received("initialize");
    expect(init!.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "chalito", version: "0.1.0" },
    });
    expect(s.received("authenticate")[0]!.params).toEqual({ methodId: "xai.api_key" });
    expect(s.received("session/new")[0]!.params).toEqual({ cwd: s.ws, mcpServers: [] });
    // Never always-approve: nothing in session/new asks for it.
    expect(JSON.stringify(s.received("session/new"))).not.toMatch(/yolo/i);

    expect(s.calls.map((c) => [c.toolName, c.input, c.origin])).toEqual([
      ["Bash", { command: "pnpm test", cwd: s.ws }, "client:phone1"],
      ["Edit", { file_path: "/ws/src/a.ts" }, "client:phone1"],
    ]);
    // A single decision each time, never "allow always".
    expect(s.log().flatMap((e) => (e.permission ? [[e.permission, e.outcome]] : []))).toEqual([
      ["t1", { outcome: "selected", optionId: "allow-once" }],
      ["t2", { outcome: "selected", optionId: "allow-once" }],
    ]);
    expect(s.events).toEqual([
      { type: "started", providerSessionId: "fake-session-1" },
      { type: "state", state: "running" },
      { type: "assistant_text", text: "Voy a correr los tests." },
      { type: "tool_started", toolUseId: "t1", toolName: "Bash", input: { command: "pnpm test", cwd: s.ws } },
      { type: "tool_finished", toolUseId: "t1", ok: true },
      { type: "tool_started", toolUseId: "t2", toolName: "Edit", input: { file_path: "/ws/src/a.ts" } },
      { type: "tool_finished", toolUseId: "t2", ok: true },
      { type: "assistant_text", text: "Listo." },
      { type: "usage", tokIn: 60, tokOut: 50, tokCacheRead: 40, tokCacheWrite: 0 },
      { type: "state", state: "idle" },
    ]);

    h.close();
    await h.done;
    expect(s.states().at(-1)).toBe("completed");
  });

  it("a denied permission request is rejected once, and the tool fails", async () => {
    const s = setup(
      "grok",
      {
        turns: [
          [
            { tool: { id: "t1", kind: "edit", locations: [{ path: "/ws/.env" }] } },
            { tool: { id: "t2", kind: "move", locations: [{ path: "/ws/a.ts" }, { path: "/etc/passwd" }] } },
          ],
        ],
      },
      { apiKey: "xai-k" },
      async (c) => c.input.file_path !== "/ws/.env" && c.input.file_path !== "/etc/passwd",
    );
    const h = await s.start();
    await waitFor(() => s.states().includes("idle"), 5000);
    // Every path of a multi-location change is gated; the first refusal decides.
    expect(s.calls.map((c) => [c.toolUseId, c.input.file_path])).toEqual([
      ["t1", "/ws/.env"],
      ["t2", "/ws/a.ts"],
      ["t2#1", "/etc/passwd"],
    ]);
    expect(s.log().flatMap((e) => (e.permission ? [e.outcome] : []))).toEqual([
      { outcome: "selected", optionId: "reject-once" },
      { outcome: "selected", optionId: "reject-once" },
    ]);
    expect(s.events).toContainEqual({ type: "tool_finished", toolUseId: "t1", ok: false });
    h.close();
    await h.done;
  });

  it("interrupt sends session/cancel and answers the pending permission request with cancelled", async () => {
    let pending: AbortSignal | undefined;
    const s = setup(
      "grok",
      { turns: [[{ say: "pensando" }, { tool: { id: "t1", kind: "execute", rawInput: { command: "git push" } } }]] },
      { apiKey: "xai-k" },
      // An approval that never comes: only the abort ends it.
      (_c, signal) =>
        new Promise((resolve) => {
          pending = signal;
          signal.addEventListener("abort", () => resolve(true));
        }),
    );
    const h = await s.start();
    await waitFor(() => pending !== undefined, 5000);
    await h.interrupt();
    await waitFor(() => s.log().some((e) => e.permission === "t1"), 5000);
    expect(s.received("session/cancel")).toEqual([
      { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "fake-session-1" } },
    ]);
    // Allowed by a gate that resolved on abort, but the turn was cancelled: never an approval.
    expect(s.log().find((e) => e.permission === "t1")!.outcome).toEqual({ outcome: "cancelled" });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.states()).toEqual(["running", "interrupted"]);

    // The session keeps working after an interrupt.
    h.close();
    await h.done;
  });

  it("cancels a turn that is only streaming (stopReason cancelled)", async () => {
    const s = setup(
      "grok",
      { turns: [[{ say: "largo" }, { waitCancel: true }], [{ say: "otra vez" }]] },
      { apiKey: "k" },
    );
    const h = await s.start();
    await waitFor(() => s.received("session/prompt").length === 1, 5000);
    await h.interrupt();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.states()).toEqual(["running", "interrupted"]);
    expect(s.events).toContainEqual({ type: "assistant_text", text: "largo" });
    h.prompt("sigue", "local");
    await waitFor(() => s.states().includes("idle"), 5000);
    expect(s.events).toContainEqual({ type: "assistant_text", text: "otra vez" });
    h.close();
    await h.done;
  });

  it("a failed API-key authentication fails the start with auth_required", async () => {
    const s = setup("grok", { authFail: "invalid api key" }, { apiKey: "xai-bad" });
    await expect(s.start()).rejects.toMatchObject({ code: "auth_required" });
    expect(s.received("session/new")).toEqual([]);
    expect(s.events).toEqual([]);
  });

  it("sign-in mode uses the CLI's own login: no authenticate, the user's GROK_HOME, a hint when signed out", async () => {
    const s = setup("grok", { requireAuth: true }, { signIn: true });
    const err = await s.start().catch((e: Error & { code?: string }) => e);
    expect(err).toMatchObject({ code: "auth_required" });
    expect((err as Error).message).toMatch(/grok login/);
    expect(s.received("authenticate")).toEqual([]);
    const env = s.log()[0]!.env!;
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.GROK_HOME).toBeUndefined();
    expect(existsSync(join(s.home, "requirements.toml"))).toBe(false);
  });

  it("needs an API key or sign-in", async () => {
    const s = setup("grok", {});
    await expect(s.start()).rejects.toThrow(/API key or the CLI's own sign-in/);
  });

  it("refuses advertised slash commands that would switch approvals off", async () => {
    const s = setup(
      "grok",
      { commands: ["always-approve", "compact"], turns: [[{ say: "ok" }], [{ say: "compacted" }]] },
      { apiKey: "k" },
    );
    const h = await s.start();
    await waitFor(() => s.states().includes("idle"), 5000);
    h.prompt("/always-approve on", "client:phone1");
    await waitFor(() => s.events.some((e) => e.type === "error"), 5000);
    expect(s.received("session/prompt")).toHaveLength(1);
    h.prompt("/compact", "local");
    await waitFor(() => s.received("session/prompt").length === 2, 5000);
    h.close();
    await h.done;
  });

  it("plan mode launches in the read-only sandbox", async () => {
    expect(grokSandboxFor("plan")).toBe("read-only");
    expect(grokSandboxFor("acceptEdits")).toBe("workspace");
    const s = setup("grok", { turns: [[]] }, { apiKey: "k" });
    const h = await s.start({ permissionMode: "plan" });
    expect(s.log()[0]!.argv).toContain("read-only");
    h.close();
    await h.done;
  });

  it("an agent that exits mid-session is an adapter crash", async () => {
    const s = setup("grok", { turns: [[{ say: "adiós" }, { crash: true }]] }, { apiKey: "k" });
    const h = await s.start();
    await h.done;
    expect(s.events).toContainEqual({ type: "error", code: "adapter_crash", message: "Grok Build exited" });
    expect(s.states().at(-1)).toBe("failed");
  });

  it("resume loads the session without replaying its history as new output", async () => {
    const s = setup("grok", { turns: [[{ say: "de vuelta" }]] }, { apiKey: "k" });
    const h = await s.start({ resume: "prev-session" });
    await waitFor(() => s.states().includes("idle"), 5000);
    expect(s.received("session/load")[0]!.params).toEqual({ sessionId: "prev-session", cwd: s.ws, mcpServers: [] });
    const texts = s.events.flatMap((e) => (e.type === "assistant_text" ? [e.text] : []));
    expect(texts).toEqual(["de vuelta"]);
    expect(s.events[0]).toEqual({ type: "started", providerSessionId: "prev-session" });
    h.close();
    await h.done;
  });
});

describe("ACP adapter: Gemini CLI profile", () => {
  it("launches with --acp, the ask-everything admin policy, and the key only in authenticate", async () => {
    const s = setup(
      "gemini",
      { requireAuth: true, turns: [[{ tool: { id: "r1", kind: "read", locations: [{ path: "/ws/README.md" }] } }]] },
      { apiKey: "AIza-test" },
    );
    const h = await s.start();
    await waitFor(() => s.states().includes("idle"), 5000);
    const policyDir = join(s.home, "chalito-policy");
    const [boot] = s.log();
    expect(boot!.argv).toEqual(["--acp", "--approval-mode", "default", "--admin-policy", policyDir]);
    expect(readFileSync(join(policyDir, "chalito.toml"), "utf8")).toBe(GEMINI_POLICY);
    expect(boot!.env!.GEMINI_CLI_HOME).toBe(join(s.home, "home"));
    expect(JSON.stringify(boot!.env)).not.toContain("AIza-test");
    expect(s.received("authenticate")[0]!.params).toEqual({
      methodId: "gemini-api-key",
      _meta: { "api-key": "AIza-test" },
    });
    // Reads reach the gate too (the admin policy makes every tool ask).
    expect(s.calls.map((c) => [c.toolName, c.input])).toEqual([["Read", { file_path: "/ws/README.md" }]]);
    h.close();
    await h.done;
  });

  it("sign-in mode: no authenticate, the user's own ~/.gemini", async () => {
    const s = setup("gemini", { turns: [[{ say: "hola" }]] }, { signIn: true });
    const h = await s.start();
    await waitFor(() => s.states().includes("idle"), 5000);
    expect(s.received("authenticate")).toEqual([]);
    expect(s.log()[0]!.env!.GEMINI_CLI_HOME).toBeUndefined();
    h.close();
    await h.done;
  });

  it("switches back to the default mode when the agent reports yolo", async () => {
    const s = setup(
      "gemini",
      {
        modes: {
          currentModeId: "yolo",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "yolo", name: "YOLO" },
          ],
        },
        turns: [[{ mode: "autoEdit" }, { say: "ok" }]],
      },
      { apiKey: "k" },
    );
    const h = await s.start();
    await waitFor(() => s.states().includes("idle"), 5000);
    await waitFor(() => s.received("session/set_mode").length === 2, 5000);
    expect(s.received("session/set_mode").map((m) => m.params)).toEqual([
      { sessionId: "fake-session-1", modeId: "default" },
      { sessionId: "fake-session-1", modeId: "default" },
    ]);
    h.close();
    await h.done;
  });
});

describe("toolCallsFor", () => {
  it("maps ACP tool kinds to the tool names the policy classifier knows", () => {
    const cwd = "/ws";
    expect(toolCallsFor({ toolCallId: "a", kind: "execute", rawInput: { command: "ls" } }, cwd)).toEqual([
      { toolName: "Bash", input: { command: "ls", cwd } },
    ]);
    expect(toolCallsFor({ toolCallId: "a", kind: "delete", locations: [{ path: "/ws/x" }] }, cwd)).toEqual([
      { toolName: "Edit", input: { file_path: "/ws/x" } },
    ]);
    expect(toolCallsFor({ toolCallId: "a", kind: "edit" }, cwd)).toEqual([{ toolName: "Edit", input: {} }]);
    expect(toolCallsFor({ toolCallId: "a", kind: "search", rawInput: { pattern: "foo" } }, cwd)).toEqual([
      { toolName: "Grep", input: { path: cwd } },
    ]);
    expect(toolCallsFor({ toolCallId: "a", kind: "search", rawInput: { query: "news" } }, cwd)).toEqual([
      { toolName: "WebSearch", input: { query: "news" } },
    ]);
    expect(toolCallsFor({ toolCallId: "a", kind: "fetch", rawInput: { url: "https://x.dev/a" } }, cwd)).toEqual([
      { toolName: "WebFetch", input: { url: "https://x.dev/a" } },
    ]);
    // Unknown tools keep an acp: name, which the classifier rates HIGH (step-up).
    expect(toolCallsFor({ toolCallId: "a", kind: "other", title: "linear: create_issue" }, cwd)).toEqual([
      { toolName: "acp:linear: create_issue", input: {} },
    ]);
    expect(toolCallsFor({ toolCallId: "a", kind: "switch_mode", title: "Exit plan mode" }, cwd)[0]!.toolName).toBe(
      "acp:Exit plan mode",
    );
  });
});
