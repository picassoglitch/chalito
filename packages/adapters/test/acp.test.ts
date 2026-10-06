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
  type AcpRecipe,
  GEMINI_POLICY,
  GROK_COMPAT_OFF,
  GROK_REQUIREMENTS,
  BUILTIN_ACP_RECIPES,
  OPENCODE_PERMISSION,
  acpRecipeProblem,
  askModeOf,
  classifyMode,
  profileFor,
  commandAllowed,
  grokSandboxFor,
  keyEnvAllowed,
  modeAllowed,
  slashCommand,
  toolCallsFor,
  unsafeLaunchArg,
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
  kind: AcpKind | AcpRecipe,
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
  return { adapter, ws, home, calls, events, start, log, received, states };
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
    expect(boot!.argv).toEqual(["--sandbox", "workspace", "--no-auto-update", "agent", "--no-leader", "stdio"]);
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
    expect(boot!.env!.GEMINI_API_KEY).toBeUndefined();
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

/** A second agent that only exists as a recipe: no preset, the generic policy alone. */
const RECIPE: AcpRecipe = {
  id: "fake-agent",
  name: "Fake Agent",
  apiKey: { env: "FAKE_AGENT_API_KEY" },
  driver: { acp: { command: ["fake-agent", "acp", "--log-level", "warn"], authMethods: ["fake-key"] } },
};
const recipe = (over: Partial<AcpRecipe["driver"]["acp"] & object> = {}, rest: Partial<AcpRecipe> = {}): AcpRecipe => ({
  ...RECIPE,
  ...rest,
  driver: { acp: { ...RECIPE.driver.acp!, ...over } },
});
const MODES = {
  currentModeId: "auto",
  availableModes: [
    { id: "auto", name: "Auto" },
    { id: "approve", name: "Approve" },
    { id: "chat", name: "Chat" },
  ],
};

describe("ACP adapter: any recipe with driver.acp", () => {
  it("launches the recipe's command with the key in its apiKey.env, and authenticates with its method", async () => {
    const s = setup(RECIPE, { requireAuth: true, turns: [[{ say: "hola" }]] }, { apiKey: "fk-1" });
    expect(s.adapter.kind).toBe("acp");
    expect(s.adapter.appId).toBe("fake-agent");
    const h = await s.start();
    await waitFor(() => s.states().includes("idle"), 5000);
    const [boot] = s.log();
    expect(boot!.argv).toEqual(["acp", "--log-level", "warn"]);
    expect(boot!.env!.FAKE_AGENT_API_KEY).toBe("fk-1");
    expect(boot!.env!.CHALITO_SESSION).toBe("1");
    expect(boot!.env!.OPENAI_API_KEY).toBeUndefined();
    expect(s.received("authenticate").map((m) => m.params)).toEqual([{ methodId: "fake-key" }]);
    h.close();
    await h.done;
  });

  it("sign-in: no authenticate and no key; never an interactive (terminal) auth method", async () => {
    const signIn = setup(RECIPE, { turns: [[]] }, { signIn: true });
    const h = await signIn.start();
    expect(signIn.received("authenticate")).toEqual([]);
    expect(signIn.log()[0]!.env!.FAKE_AGENT_API_KEY).toBeUndefined();
    h.close();
    await h.done;

    const s = setup(
      recipe({ authMethods: ["login-tui", "fake-key"] }),
      {
        authMethods: [
          { id: "login-tui", name: "Log in", type: "terminal" },
          { id: "fake-key", name: "Key" },
        ],
        turns: [[]],
      },
      { apiKey: "fk" },
    );
    const h2 = await s.start();
    expect(s.received("authenticate").map((m) => m.params)).toEqual([{ methodId: "fake-key" }]);
    h2.close();
    await h2.done;

    // No auth methods in the recipe: the key only goes in the environment.
    const envOnly = setup(recipe({ authMethods: [] }), { turns: [[]] }, { apiKey: "fk" });
    const h3 = await envOnly.start();
    expect(envOnly.received("authenticate")).toEqual([]);
    expect(envOnly.log()[0]!.env!.FAKE_AGENT_API_KEY).toBe("fk");
    h3.close();
    await h3.done;
  });

  it("refuses recipes whose command skips approvals or whose key variable isn't a key", () => {
    const make = (r: AcpRecipe) => () => new AcpAdapter(r, { binPath: FAKE, apiKey: "k" });
    expect(make(recipe({ command: ["qwen", "--acp", "--yolo"] }))).toThrow(/--yolo/);
    expect(make(recipe({ command: ["gemini", "--acp", "--approval-mode", "yolo"] }))).toThrow(/approval-mode yolo/);
    expect(make(recipe({ command: ["x", "--approval-mode=auto_edit"] }))).toThrow(/approval-mode=auto_edit/);
    expect(make(recipe({ command: ["claude", "--dangerously-skip-permissions"] }))).toThrow(/dangerously/);
    expect(make(recipe({ command: ["grok", "--always-approve", "agent", "stdio"] }))).toThrow(/always-approve/);
    expect(make(recipe({ command: [] }))).toThrow(/empty/);
    expect(make(recipe({}, { apiKey: { env: "LD_PRELOAD" } }))).toThrow(/isn't allowed/);
    expect(make(recipe({}, { apiKey: { env: "NODE_OPTIONS" } }))).toThrow(/isn't allowed/);
    expect(make(recipe({}, { apiKey: { env: "CHALITO_API_KEY" } }))).toThrow(/isn't allowed/);
    expect(make(recipe({}, { id: "Bad Id" }))).toThrow(/invalid recipe id/);
    expect(make({ ...RECIPE, driver: {} })).toThrow(/no ACP driver/);
  });

  it("a custom recipe for a known CLI keeps that CLI's hardening (preset by binary name)", async () => {
    const s = setup(
      { id: "mi-gemini", name: "Mi Gemini", driver: { acp: { command: ["gemini", "--acp"] } } },
      { turns: [[]] },
      { apiKey: "AIza-k" },
    );
    const h = await s.start();
    expect(s.log()[0]!.argv).toEqual(["--acp", "--admin-policy", join(s.home, "chalito-policy")]);
    expect(s.received("authenticate")[0]!.params).toEqual({
      methodId: "gemini-api-key",
      _meta: { "api-key": "AIza-k" },
    });
    h.close();
    await h.done;
  });

  it("forces the ask mode at start and puts it back when the agent switches to one that skips prompts", async () => {
    const s = setup(
      RECIPE,
      { modes: MODES, turns: [[{ mode: "chat" }, { say: "a" }, { mode: "auto" }, { say: "b" }]] },
      { apiKey: "k" },
    );
    const h = await s.start();
    await waitFor(() => s.states().includes("idle"), 5000);
    await waitFor(() => s.received("session/set_mode").length === 2, 5000);
    // Start: auto → approve. Read-only "chat" may stay; "auto" goes back to approve.
    expect(s.received("session/set_mode").map((m) => m.params!.modeId)).toEqual(["approve", "approve"]);
    expect(s.states()).not.toContain("failed");
    h.close();
    await h.done;
  });

  it("stops the session when the ask mode can't be restored", async () => {
    const s = setup(
      RECIPE,
      {
        modes: { ...MODES, currentModeId: "approve" },
        setModeFails: true,
        turns: [[{ mode: "auto" }, { waitCancel: true }]],
      },
      { apiKey: "k" },
    );
    const h = await s.start();
    await h.done;
    expect(s.events).toContainEqual(
      expect.objectContaining({ type: "error", message: expect.stringMatching(/"auto" mode.*stopped/) }),
    );
    expect(s.states()).toContain("failed");
  });

  it("refuses to start in a mode that skips prompts when the agent offers none that asks", async () => {
    const s = setup(
      RECIPE,
      {
        modes: {
          currentModeId: "yolo",
          availableModes: [
            { id: "yolo", name: "YOLO" },
            { id: "build", name: "Build" },
          ],
        },
      },
      { apiKey: "k" },
    );
    await expect(s.start()).rejects.toThrow(/"yolo" mode and offers no mode that asks/);
    expect(s.received("session/prompt")).toEqual([]);

    // Unknown modes that aren't known to skip prompts stay (every request still reaches the gate).
    const ok = setup(
      RECIPE,
      { modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] }, turns: [[]] },
      { apiKey: "k" },
    );
    const h = await ok.start();
    expect(ok.received("session/set_mode")).toEqual([]);
    h.close();
    await h.done;
  });

  it("holds a mode config option on its ask value and switches approval toggles off", async () => {
    const configOptions = [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "yolo",
        options: [
          { value: "default", name: "Ask" },
          { value: "yolo", name: "YOLO" },
        ],
      },
      { id: "auto_approve", name: "Auto approve", type: "boolean", currentValue: true },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "m1",
        options: [{ value: "m1", name: "M1" }],
      },
    ];
    const s = setup(
      RECIPE,
      {
        configOptions,
        turns: [[{ config: [{ ...configOptions[0], currentValue: "yolo" }] }, { say: "ok" }]],
      },
      { apiKey: "k" },
    );
    const h = await s.start();
    await waitFor(() => s.states().includes("idle"), 5000);
    await waitFor(() => s.received("session/set_config_option").length === 3, 5000);
    expect(s.received("session/set_config_option").map((m) => m.params)).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "default" },
      { sessionId: "fake-session-1", configId: "auto_approve", type: "boolean", value: false },
      { sessionId: "fake-session-1", configId: "mode", value: "default" },
    ]);
    h.close();
    await h.done;
  });

  it("refuses advertised and approval-related slash commands; passes paths and harmless ones", async () => {
    const s = setup(
      RECIPE,
      { commands: ["compact", "help"], turns: [[{ say: "1" }], [{ say: "2" }], [{ say: "3" }]] },
      { apiKey: "k" },
    );
    const h = await s.start();
    await waitFor(() => s.states().includes("idle"), 5000);
    const errors = () => s.events.filter((e) => e.type === "error").length;
    for (const [i, p] of ["/yolo", "/permissions allow all", "/approval-mode auto", "/compact", "/help"].entries()) {
      h.prompt(p, "client:phone1");
      await waitFor(() => errors() === i + 1, 5000);
    }
    expect(s.received("session/prompt")).toHaveLength(1);
    h.prompt("/src/a.ts: why does this fail?", "local");
    await waitFor(() => s.received("session/prompt").length === 2, 5000);
    await waitFor(() => s.states().filter((x) => x === "idle").length >= 7, 5000);
    h.prompt("/explain this", "local");
    await waitFor(() => s.received("session/prompt").length === 3, 5000);
    h.close();
    await h.done;
  });

  it("never answers allow_always: without a one-time allow the request is cancelled", async () => {
    const s = setup(
      RECIPE,
      {
        permissionOptions: [
          { optionId: "always", name: "Always", kind: "allow_always" },
          { optionId: "no", name: "No", kind: "reject_always" },
        ],
        turns: [[{ tool: { id: "t1", kind: "execute", rawInput: { command: "ls" } } }]],
      },
      { apiKey: "k" },
    );
    const h = await s.start();
    await waitFor(() => s.log().some((e) => e.permission === "t1"), 5000);
    expect(s.calls).toHaveLength(1);
    expect(s.log().find((e) => e.permission === "t1")!.outcome).toEqual({ outcome: "cancelled" });
    h.close();
    await h.done;
  });
});

describe("built-in ACP recipes and presets", () => {
  it("every built-in recipe passes the generic checks", () => {
    for (const r of Object.values(BUILTIN_ACP_RECIPES)) expect(acpRecipeProblem(r)).toBeNull();
  });

  const launchOf = (id: keyof typeof BUILTIN_ACP_RECIPES, config: Partial<AcpAdapterConfig> = { signIn: true }) => {
    const home = mkdtempSync(join(tmpdir(), "chalito-acp-home-"));
    return profileFor(BUILTIN_ACP_RECIPES[id]).launch({ binPath: "/bin/x", home, env: {}, ...config }, "default");
  };

  it("OpenCode asks for every tool; Goose starts in approve; Qwen in default", () => {
    const oc = launchOf("opencode");
    expect(oc.args).toEqual(["acp"]);
    expect(oc.env.OPENCODE_PERMISSION).toBe(OPENCODE_PERMISSION);
    expect(launchOf("goose").env.GOOSE_MODE).toBe("approve");
    expect(launchOf("qwen-code").args).toEqual(["--acp", "--approval-mode", "default"]);
    const q = launchOf("qwen-code", { apiKey: "sk-q" });
    expect(q.args).toEqual(["--acp", "--approval-mode", "default", "--auth-type", "openai"]);
    expect(q.env.OPENAI_API_KEY).toBe("sk-q");
    expect(launchOf("mistral-vibe", { apiKey: "m" }).env.MISTRAL_API_KEY).toBe("m");
  });

  it("holds each agent's ask mode", () => {
    const p = (id: keyof typeof BUILTIN_ACP_RECIPES) => profileFor(BUILTIN_ACP_RECIPES[id]);
    expect(askModeOf(p("opencode"), [{ id: "build" }, { id: "plan" }])).toBe("build");
    const goose = [{ id: "auto" }, { id: "approve" }, { id: "smart_approve" }, { id: "chat" }];
    expect(askModeOf(p("goose"), goose)).toBe("approve");
    expect(modeAllowed(p("goose"), "approve", "smart_approve")).toBe(false);
    const qwen = ["plan", "default", "auto-edit", "auto", "yolo"].map((id) => ({ id }));
    expect(askModeOf(p("qwen-code"), qwen)).toBe("default");
    expect(
      askModeOf(
        p("mistral-vibe"),
        ["ask", "plan", "accept-edits", "auto-approve"].map((id) => ({ id })),
      ),
    ).toBe("ask");
    // Copilot's approval commands never reach it, advertised or not.
    for (const c of ["allow-all", "permissions", "autopilot", "reset-allowed-tools", "sandbox"])
      expect(commandAllowed(c, p("copilot-cli").allowedCommands, new Set())).toBe(false);
  });
});

describe("ACP adapter: OpenCode-style mode option", () => {
  it("keeps build (ask mode once every tool asks) and puts it back from an unknown mode", async () => {
    const mode = (currentValue: string) => ({
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue,
      options: [
        { value: "build", name: "Build" },
        { value: "plan", name: "Plan" },
        { value: "custom", name: "Custom" },
      ],
    });
    const s = setup(
      { ...BUILTIN_ACP_RECIPES.opencode },
      {
        configOptions: [mode("build")],
        turns: [[{ config: [mode("plan")] }, { config: [mode("custom")] }, { say: "ok" }]],
      },
      { signIn: true },
    );
    const h = await s.start();
    await waitFor(() => s.states().includes("idle"), 5000);
    await waitFor(() => s.received("session/set_config_option").length === 1, 5000);
    expect(s.received("session/set_config_option").map((m) => m.params)).toEqual([
      { sessionId: "fake-session-1", configId: "mode", value: "build" },
    ]);
    expect(s.log()[0]!.env!.OPENCODE_PERMISSION).toBe(OPENCODE_PERMISSION);
    h.close();
    await h.done;
  });
});

describe("generic ACP policy", () => {
  const policy = { unsafeModes: [] };
  it("finds approval-skipping launch flags", () => {
    expect(unsafeLaunchArg(["acp"])).toBeNull();
    expect(unsafeLaunchArg(["--sandbox", "workspace", "--no-auto-update"])).toBeNull();
    expect(unsafeLaunchArg(["--approval-mode", "default"])).toBeNull();
    for (const bad of [
      ["-y"],
      ["--yolo"],
      ["--full-auto"],
      ["--allow-all-tools"],
      ["--sandbox", "off"],
      ["--no-sandbox"],
      ["--mode=bypassPermissions"],
    ])
      expect(unsafeLaunchArg(bad)).not.toBeNull();
  });
  it("classifies modes and picks the one that asks", () => {
    expect(classifyMode(policy, "yolo")).toBe("unsafe");
    expect(classifyMode(policy, "x", "Always allow")).toBe("unsafe");
    expect(classifyMode(policy, "default")).toBe("ask");
    expect(classifyMode(policy, "plan")).toBe("read_only");
    expect(classifyMode(policy, "build")).toBe("unknown");
    expect(askModeOf(policy, [{ id: "plan" }, { id: "default" }])).toBe("default");
    expect(askModeOf(policy, [{ id: "build" }, { id: "plan" }])).toBe("plan");
    expect(askModeOf({ unsafeModes: [], safeMode: "careful" }, [{ id: "careful" }, { id: "default" }])).toBe("careful");
    expect(askModeOf(policy, [{ id: "default", name: "Auto-accept edits" }])).toBeNull();
    expect(modeAllowed(policy, "default", "plan")).toBe(true);
    expect(modeAllowed(policy, "default", "build")).toBe(false);
    expect(modeAllowed(policy, null, "build")).toBe(true);
    expect(modeAllowed(policy, null, "acceptEdits")).toBe(false);
  });
  it("decides which slash commands reach the agent", () => {
    const adv = new Set(["compact", "always-approve"]);
    expect(slashCommand("  /always-approve on")).toBe("always-approve");
    expect(slashCommand("hola /yolo")).toBeNull();
    expect(commandAllowed("compact", ["compact"], adv)).toBe(true);
    expect(commandAllowed("compact", [], adv)).toBe(false);
    expect(commandAllowed("always-approve", ["compact"], adv)).toBe(false);
    expect(commandAllowed("yolo", [], new Set())).toBe(false);
    expect(commandAllowed("mcp", [], new Set())).toBe(false);
    expect(commandAllowed("src", [], new Set())).toBe(true);
  });
  it("allows only key-like variables for the API key", () => {
    expect(keyEnvAllowed("XAI_API_KEY")).toBe(true);
    expect(keyEnvAllowed("DASHSCOPE_API_KEY")).toBe(true);
    expect(keyEnvAllowed("GITHUB_TOKEN")).toBe(true);
    for (const bad of ["PATH", "LD_PRELOAD", "NODE_OPTIONS", "CHALITO_KEY", "lower_key", "GIT_ASKPASS_TOKEN"])
      expect(keyEnvAllowed(bad)).toBe(false);
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
