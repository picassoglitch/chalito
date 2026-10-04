import { describe, expect, it } from "vitest";
import type { AdapterEvent, ToolCall } from "../src/core.js";
import {
  ClaudeCodeAdapter,
  claudeEnv,
  fakeClaudeCode,
  lowerTrustOrigin,
  type FakeStep,
} from "../src/claude-code/index.js";
import type { Origin } from "@chalito/protocol";

const waitFor = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const setup = (turns: FakeStep[][], gate: (c: ToolCall) => boolean) => {
  const fake = fakeClaudeCode(turns);
  const calls: ToolCall[] = [];
  const events: AdapterEvent[] = [];
  const adapter = new ClaudeCodeAdapter({
    apiKey: "sk-ant-test",
    queryFn: fake.queryFn,
    env: {
      PATH: "/usr/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
      ANTHROPIC_AUTH_TOKEN: "x",
      ANTHROPIC_API_KEY: "old",
    },
  });
  const start = (prompt = "hola") =>
    adapter.start({
      sid: "s1",
      cwd: "/ws",
      prompt,
      origin: "client:phone1",
      permissionMode: "default",
      gate: async (c) => (calls.push(c), gate(c) ? { allow: true } : { allow: false, reason: "policy_block" }),
      askUser: async () => ({ "¿Qué base?": "Postgres" }),
      onEvent: (e) => events.push(e),
    });
  return { fake, calls, events, start };
};

describe("Claude Code adapter", () => {
  it("pins permission mode, setting sources, hook timeout and API-key-only auth", async () => {
    const { fake, start } = setup([[{ say: "ok" }]], () => true);
    const h = await start();
    await waitFor(() => fake.run.options !== undefined);
    const o = fake.run.options!;
    expect(o.permissionMode).toBe("default");
    expect(o.allowDangerouslySkipPermissions).toBe(false);
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.env).toMatchObject({ ANTHROPIC_API_KEY: "sk-ant-test", PATH: "/usr/bin" });
    expect(o.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(o.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(o.hooks?.PreToolUse?.[0]?.timeout).toBeGreaterThan(600);
    h.close();
    await h.done;
  });

  it("routes every tool call through the gate; denied tools never run", async () => {
    const { fake, calls, start } = setup(
      [
        [
          { tool: "Read", input: { file_path: "/ws/a" } },
          { tool: "Bash", input: { command: "sudo rm -rf /" } },
          { say: "listo" },
        ],
      ],
      (c) => c.toolName !== "Bash",
    );
    const h = await start();
    await waitFor(() => fake.run.ran.length + fake.run.refused.length === 2);
    expect(calls.map((c) => c.toolName)).toEqual(["Read", "Bash"]);
    expect(fake.run.ran.map((r) => r.tool)).toEqual(["Read"]);
    expect(fake.run.refused[0]).toMatchObject({ tool: "Bash" });
    h.close();
    await h.done;
  });

  it("surfaces AskUserQuestion to the human and returns the answers", async () => {
    const { fake, start } = setup(
      [
        [
          {
            tool: "AskUserQuestion",
            input: { questions: [{ question: "¿Qué base?", options: [{ label: "Postgres" }, { label: "SQLite" }] }] },
          },
        ],
      ],
      () => true,
    );
    const h = await start();
    await waitFor(() => fake.run.ran.length === 1);
    expect(fake.run.ran[0]!.input).toMatchObject({ answers: { "¿Qué base?": "Postgres" } });
    h.close();
    await h.done;
  });

  it("maps SDK messages to adapter events and tags each turn with its origin", async () => {
    const { calls, events, start } = setup([[{ say: "uno" }], [{ tool: "Grep", input: { pattern: "x" } }]], () => true);
    const h = await start();
    await waitFor(() => events.some((e) => e.type === "state" && e.state === "idle"));
    h.prompt("sigue", "mcp:chatgpt");
    await waitFor(() => calls.length === 1);
    expect(calls[0]!.origin).toBe("mcp:chatgpt");
    h.close();
    await h.done;
    const types = events.map((e) => e.type);
    expect(types).toContain("started");
    expect(types).toContain("assistant_text");
    expect(types).toContain("tool_started");
    expect(types).toContain("tool_finished");
    expect(types).toContain("usage");
    expect(events.at(-1)).toEqual({ type: "state", state: "completed" });
  });

  it("forwards interrupt and permission-mode changes", async () => {
    const { fake, start } = setup([[{ say: "x" }]], () => true);
    const h = await start();
    await h.setPermissionMode("acceptEdits");
    await h.interrupt();
    expect(fake.run.modes).toEqual(["default", "acceptEdits"]);
    expect(fake.run.interrupted).toBe(1);
    h.close();
    await h.done;
  });

  it("isolates repo settings: settingSources [] and the workspace CLAUDE.md appended to the system prompt", async () => {
    const fake = fakeClaudeCode([[{ say: "ok" }]]);
    const adapter = new ClaudeCodeAdapter({
      apiKey: "sk-ant-test",
      queryFn: fake.queryFn,
      env: {},
      readFile: async (p) => {
        if (p === "/ws/CLAUDE.md") return "Usa pnpm.";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    const h = await adapter.start({
      sid: "s1",
      cwd: "/ws",
      prompt: "hola",
      origin: "local",
      permissionMode: "default",
      gate: async () => ({ allow: true }),
      askUser: async () => ({}),
      onEvent: () => {},
    });
    await waitFor(() => fake.run.options !== undefined);
    expect(fake.run.options!.settingSources).toEqual([]);
    expect(fake.run.options!.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code" });
    expect((fake.run.options!.systemPrompt as { append: string }).append).toContain("Usa pnpm.");
    h.close();
    await h.done;
  });

  it("strips env that could redirect the API key", () => {
    const env = claudeEnv(
      {
        PATH: "/usr/bin",
        ANTHROPIC_BASE_URL: "https://evil.example",
        ANTHROPIC_CUSTOM_HEADERS: "X-Leak: 1",
        ANTHROPIC_BEDROCK_BASE_URL: "https://evil.example",
        CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "1",
      },
      "sk-ant-test",
    );
    expect(env).toEqual({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-test" });
  });

  it("denies the tool when the gate throws (fails closed)", async () => {
    const fake = fakeClaudeCode([[{ tool: "Edit", input: { file_path: "/ws/.github/workflows/deploy.yml" } }]]);
    const adapter = new ClaudeCodeAdapter({ apiKey: "sk-ant-test", queryFn: fake.queryFn, env: {} });
    const h = await adapter.start({
      sid: "s1",
      cwd: "/ws",
      prompt: "hola",
      origin: "client:phone1",
      permissionMode: "acceptEdits",
      gate: async () => {
        throw new Error("store offline");
      },
      askUser: async () => ({}),
      onEvent: () => {},
    });
    await waitFor(() => fake.run.refused.length === 1);
    expect(fake.run.ran).toEqual([]);
    expect(fake.run.refused[0]!.reason).toMatch(/gate error/);
    h.close();
    await h.done;
  });

  describe("turn origin", () => {
    /** A session whose gate records origins and can be held open on the first call. */
    const held = (turns: FakeStep[][], first: Origin) => {
      const fake = fakeClaudeCode(turns);
      const origins: Origin[] = [];
      let release!: () => void;
      const gateOpen = new Promise<void>((r) => (release = r));
      const adapter = new ClaudeCodeAdapter({ apiKey: "sk-ant-test", queryFn: fake.queryFn, env: {} });
      const started = adapter.start({
        sid: "s1",
        cwd: "/ws",
        prompt: "hola",
        origin: first,
        permissionMode: "default",
        gate: async (c) => {
          origins.push(c.origin);
          if (origins.length === 1) await gateOpen;
          return { allow: true };
        },
        askUser: async () => ({}),
        onEvent: () => {},
      });
      return { fake, origins, release, started };
    };

    it("a client prompt queued during an mcp turn doesn't make the rest of that turn client:", async () => {
      const { fake, origins, release, started } = held(
        [
          [
            { tool: "Read", input: { file_path: "/ws/a" } },
            { tool: "Bash", input: { command: "ls" } },
          ],
          [{ tool: "Grep", input: { pattern: "x" } }],
        ],
        "mcp:claude",
      );
      const h = await started;
      await waitFor(() => origins.length === 1);
      h.prompt("desde el teléfono", "client:phone1");
      release();
      await waitFor(() => fake.run.ran.length === 3);
      expect(origins).toEqual(["mcp:claude", "mcp:claude", "client:phone1"]);
      h.close();
      await h.done;
    });

    it("prompts queued together start the next turn with the least trusted origin", async () => {
      const { fake, origins, release, started } = held(
        [[{ tool: "Read", input: { file_path: "/ws/a" } }], [{ tool: "Bash", input: { command: "ls" } }]],
        "local",
      );
      const h = await started;
      await waitFor(() => origins.length === 1);
      h.prompt("uno", "client:phone1");
      h.prompt("dos", "call:CA123");
      release();
      await waitFor(() => fake.run.ran.length === 2);
      expect(origins).toEqual(["local", "call:CA123"]);
      h.close();
      await h.done;
    });

    it("lowerTrustOrigin orders unsigned < client < local", () => {
      expect(lowerTrustOrigin("local", "client:p")).toBe("client:p");
      expect(lowerTrustOrigin("client:p", "mcp:claude")).toBe("mcp:claude");
      expect(lowerTrustOrigin("call:CA1", "client:p")).toBe("call:CA1");
      expect(lowerTrustOrigin("mcp:claude", "call:CA1")).toBe("mcp:claude");
    });
  });

  it("reports the SDK init metadata once per session through onInit", async () => {
    const fake = fakeClaudeCode([[{ say: "uno" }], [{ say: "dos" }]]);
    const inits: unknown[] = [];
    const adapter = new ClaudeCodeAdapter({
      apiKey: "sk-ant-test",
      queryFn: fake.queryFn,
      env: {},
      onInit: (i) => inits.push(i),
    });
    const events: AdapterEvent[] = [];
    const h = await adapter.start({
      sid: "s1",
      cwd: "/ws",
      prompt: "hola",
      origin: "local",
      permissionMode: "default",
      gate: async () => ({ allow: true }),
      askUser: async () => ({}),
      onEvent: (e) => events.push(e),
    });
    await waitFor(() => events.some((e) => e.type === "state" && e.state === "idle"));
    h.prompt("otra", "local");
    h.close();
    await h.done;
    expect(inits).toEqual([
      {
        sid: "s1",
        providerSessionId: "fake-session-1",
        apiKeySource: "ANTHROPIC_API_KEY",
        permissionMode: "default",
        claude_code_version: "2.9.0-fake",
        mcp_servers: ["fake-mcp"],
        model: "claude-fake",
      },
    ]);
  });
});
