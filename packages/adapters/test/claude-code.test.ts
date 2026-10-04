import { describe, expect, it } from "vitest";
import type { AdapterEvent, ToolCall } from "../src/core.js";
import { ClaudeCodeAdapter, fakeClaudeCode, type FakeStep } from "../src/claude-code/index.js";

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
    expect(o.settingSources).toEqual(["project"]);
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
});
