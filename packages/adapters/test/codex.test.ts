import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RemotePermissionMode } from "@chalito/protocol";
import type { AdapterEvent, Question, SessionStartOptions, ToolCall } from "../src/core.js";
import {
  APPROVAL_POLICY,
  CHATGPT_PLAN_OVERRIDES,
  API_KEY_OVERRIDES,
  BYO_KEY_ENV,
  HARDENING_OVERRIDES,
  checkCodexVersion,
  codexVersionFromUserAgent,
  mcpServerOverrides,
  CodexAdapter,
  type CodexConfig,
  type CodexTransport,
  sandboxModeFor,
  sandboxPolicyFor,
} from "../src/codex/index.js";
import { fakeCodex, type FakeCodexStep } from "../src/testing.js";
import { InputQueue } from "../src/core.js";
import { waitFor } from "./conformance.js";
import { loadTranscript, replay, type TranscriptEntry } from "./replay.js";

// SYNTHETIC: codex-transcript.synthetic.jsonl was hand-built from openai/codex app-server-protocol at
// 550eb50, not recorded from a real binary. It MUST be re-recorded against a real `codex app-server`
// in the tested version range before M4 closes.
const transcript = loadTranscript(new URL("./fixtures/codex-transcript.synthetic.jsonl", import.meta.url));

const LAUNCH_ARGS = ["app-server", "--listen", "stdio://", ...HARDENING_OVERRIDES.flatMap((o) => ["-c", o])];
/** With a BYO API key: the env-key provider, never a Codex login (review R-L12). */
const KEY_LAUNCH_ARGS = [...LAUNCH_ARGS, ...API_KEY_OVERRIDES.flatMap((o) => ["-c", o])];

const session = (
  config: CodexConfig,
  over: Partial<SessionStartOptions> = {},
  gate: (c: ToolCall, signal: AbortSignal) => Promise<boolean> = async () => true,
) => {
  const calls: ToolCall[] = [];
  const events: AdapterEvent[] = [];
  const questions: Question[][] = [];
  const start = () =>
    new CodexAdapter(config).start({
      sid: "s1",
      cwd: "/ws",
      prompt: "hola",
      origin: "client:phone1",
      permissionMode: "default",
      gate: async (c, signal) => {
        calls.push(c);
        return (await gate(c, signal)) ? { allow: true } : { allow: false, reason: "policy_block" };
      },
      askUser: async (q) => {
        questions.push(q.questions);
        return { [q.questions[0]!.question]: q.questions[0]!.options[0]!.label };
      },
      onEvent: (e) => events.push(e),
      ...over,
    });
  const states = () => events.flatMap((e) => (e.type === "state" ? [e.state] : []));
  return { calls, events, questions, start, states };
};

describe("Codex adapter: recorded app-server transcript", () => {
  it("speaks the transcript exactly and maps it to adapter events", async () => {
    const r = replay(transcript);
    const { calls, events, questions, start, states } = session(
      { apiKey: "sk-test-fixture", clientVersion: "0.1.0", spawn: r.spawn, env: {} },
      { prompt: "Arregla el test que falla" },
      async (c, signal) => {
        if (c.input.command === "git push")
          return new Promise((res) => signal.addEventListener("abort", () => res(true)));
        return c.input.file_path !== "/ws/.env";
      },
    );
    const h = await start();
    await waitFor(() => states().includes("idle"));

    await h.setPermissionMode("plan");
    h.prompt("Sube los cambios", "mcp:chatgpt");
    await waitFor(() => calls.some((c) => c.input.command === "git push"));
    await h.interrupt();
    await waitFor(() => r.finished());
    h.close();
    await h.done;

    expect(r.state.mismatches).toEqual([]);
    expect(r.finished()).toBe(true);
    expect(r.state.spawned).toEqual({ command: "codex", args: KEY_LAUNCH_ARGS });

    expect(calls.map((c) => [c.toolUseId, c.toolName, c.input, c.origin])).toEqual([
      ["item_3", "Bash", { command: "pnpm test", cwd: "/ws" }, "client:phone1"],
      ["item_4", "Edit", { file_path: "/ws/src/sum.ts" }, "client:phone1"],
      ["item_4#1", "Edit", { file_path: "/ws/.env" }, "client:phone1"],
      ["item_8", "Bash", { command: "git push", cwd: "/ws" }, "mcp:chatgpt"],
    ]);
    expect(questions).toEqual([
      [
        {
          question: "¿Qué base usamos para los tests?",
          header: "Base",
          options: [
            { label: "Postgres", description: "Como en producción" },
            { label: "SQLite", description: "Más rápido" },
          ],
        },
      ],
    ]);

    expect(events).toEqual([
      { type: "started", providerSessionId: "thr_0199a1b2c3d4" },
      { type: "state", state: "running" },
      { type: "assistant_text", text: "Voy a correr los tests." },
      { type: "tool_started", toolUseId: "item_3", toolName: "Bash", input: { command: "pnpm test", cwd: "/ws" } },
      { type: "tool_finished", toolUseId: "item_3", ok: true },
      { type: "tool_started", toolUseId: "item_4", toolName: "Edit", input: { file_path: "/ws/src/sum.ts" } },
      { type: "tool_finished", toolUseId: "item_4", ok: false },
      { type: "state", state: "waiting_input" },
      { type: "state", state: "running" },
      { type: "usage", tokIn: 400, tokOut: 90, tokCacheRead: 800, tokCacheWrite: 0 },
      { type: "usage", tokIn: 600, tokOut: 60, tokCacheRead: 800, tokCacheWrite: 0 },
      { type: "assistant_text", text: "Usaré Postgres." },
      { type: "state", state: "idle" },
      { type: "state", state: "running" },
      { type: "tool_started", toolUseId: "item_8", toolName: "Bash", input: { command: "git push", cwd: "/ws" } },
      { type: "state", state: "interrupted" },
      { type: "tool_finished", toolUseId: "item_8", ok: false },
      { type: "state", state: "completed" },
    ]);
  });

  it("the transcript itself never carries jsonrpc, acceptForSession, chatgpt login or full access", () => {
    const sent = transcript.filter((e) => e.dir === "send").map((e) => JSON.stringify(e.msg));
    for (const line of sent) {
      expect(line).not.toContain("jsonrpc");
      expect(line).not.toContain("acceptForSession");
      expect(line).not.toMatch(/"type":"chatgpt"/);
      expect(line).not.toMatch(/danger-full-access|dangerFullAccess/);
      expect(line).not.toMatch(/"approvalPolicy":"(?!untrusted")/);
    }
  });

  it("maps a failed turn's codexErrorInfo and ignores retried errors", async () => {
    const head = transcript.slice(0, transcript.findIndex((e) => e.msg.method === "turn/started") + 1);
    const T = { threadId: "thr_0199a1b2c3d4", turnId: "turn_0199a1b2c3e1" };
    const err = (info: unknown, message: string) => ({ message, codexErrorInfo: info, additionalDetails: null });
    const tail: TranscriptEntry[] = [
      {
        dir: "recv",
        msg: { method: "error", params: { ...T, willRetry: true, error: err("serverOverloaded", "retry") } },
      },
      {
        dir: "recv",
        msg: { method: "error", params: { ...T, willRetry: false, error: err("usageLimitExceeded", "limit") } },
      },
      {
        dir: "recv",
        msg: {
          method: "turn/completed",
          params: {
            threadId: T.threadId,
            turn: { id: T.turnId, items: [], status: "failed", error: err("unauthorized", "401") },
          },
        },
      },
    ];
    const r = replay([...head, ...tail]);
    const { events, start, states } = session(
      { apiKey: "sk-test-fixture", clientVersion: "0.1.0", spawn: r.spawn, env: {} },
      { prompt: "Arregla el test que falla" },
    );
    const h = await start();
    await waitFor(() => states().includes("failed"));
    expect(r.state.mismatches).toEqual([]);
    expect(events.filter((e) => e.type === "error")).toEqual([
      { type: "error", code: "quota_exhausted", message: "limit" },
      { type: "error", code: "auth_required", message: "401" },
    ]);
    h.close();
    await h.done;
  });
});

describe("Codex adapter: launch and auth", () => {
  it("API key: an env-key provider, only allowlisted env, and no Codex login (nothing written to auth.json)", async () => {
    const fake = fakeCodex([[{ say: "ok" }]]);
    const { start, states } = session({
      apiKey: "sk-test",
      codexPath: "/opt/codex/bin/codex",
      spawn: fake.spawn,
      env: {
        PATH: "/usr/bin",
        LANG: "es_MX.UTF-8",
        LC_ALL: "es_MX.UTF-8",
        OPENAI_API_KEY: "other",
        CODEX_API_KEY: "x",
        ACCESS_TOKEN: "y",
        CHALITO_SECRETS_PASSPHRASE: "hunter2",
        ANTHROPIC_API_KEY: "sk-ant-x",
        XAI_API_KEY: "xai-x",
        SUPABASE_SECRET_KEY: "sb",
        OPENAI_BASE_URL: "https://evil.example",
      },
    });
    const h = await start();
    await waitFor(() => states().includes("idle"));
    h.close();
    await h.done;
    expect(fake.run.spawned).toEqual({
      command: "/opt/codex/bin/codex",
      args: KEY_LAUNCH_ARGS,
      env: {
        PATH: "/usr/bin",
        LANG: "es_MX.UTF-8",
        LC_ALL: "es_MX.UTF-8",
        CODEX_HOME: join(homedir(), ".chalito", "codex"),
        // The chalito CLI refuses key, trust, policy and Developer-mode changes under it.
        CHALITO_SESSION: "1",
        [BYO_KEY_ENV]: "sk-test",
      },
      cwd: "/ws",
    });
    expect(fake.run.received.some((m) => m.method === "account/login/start")).toBe(false);
    expect(fake.run.received.map((m) => m.method).slice(0, 3)).toEqual(["initialize", "initialized", "thread/start"]);
    expect(fake.run.violations).toEqual([]);
  });

  it("ChatGPT plan (SIWC): token in env, openai_chatgpt_plan overrides, no Codex login at all", async () => {
    const fake = fakeCodex([[{ say: "ok" }]]);
    const { start, states } = session({
      chatgptPlan: { accessToken: "siwc-access" },
      chatgptPlanEnabled: true,
      spawn: fake.spawn,
      env: { PATH: "/usr/bin", OPENAI_API_KEY: "other" },
    });
    const h = await start();
    await waitFor(() => states().includes("idle"));
    h.close();
    await h.done;
    expect(fake.run.spawned?.args).toEqual([
      "app-server",
      "--listen",
      "stdio://",
      ...HARDENING_OVERRIDES.flatMap((o) => ["-c", o]),
      ...CHATGPT_PLAN_OVERRIDES.flatMap((o) => ["-c", o]),
    ]);
    expect(fake.run.spawned?.env).toEqual({
      PATH: "/usr/bin",
      ACCESS_TOKEN: "siwc-access",
      CODEX_HOME: join(homedir(), ".chalito", "codex"),
      CHALITO_SESSION: "1",
    });
    expect(fake.run.received.some((m) => m.method?.startsWith("account/"))).toBe(false);
  });

  it("ChatGPT plan through the person's own `codex login`: no overrides, no token in env, login kept", async () => {
    const fake = fakeCodex([[{ say: "ok" }]]);
    const { start, states } = session({
      chatgptLogin: true,
      chatgptPlanEnabled: true,
      spawn: fake.spawn,
      env: { PATH: "/usr/bin", OPENAI_API_KEY: "other" },
    });
    const h = await start();
    await waitFor(() => states().includes("idle"));
    h.close();
    await h.done;
    expect(fake.run.spawned?.args).toEqual([
      "app-server",
      "--listen",
      "stdio://",
      ...HARDENING_OVERRIDES.flatMap((o) => ["-c", o]),
    ]);
    expect(fake.run.spawned?.env).toEqual({
      PATH: "/usr/bin",
      CODEX_HOME: join(homedir(), ".chalito", "codex"),
      CHALITO_SESSION: "1",
    });
    expect(fake.run.spawned?.keepLogin).toBe(true);
    expect(fake.run.received.some((m) => m.method?.startsWith("account/"))).toBe(false);
  });

  it("a `codex login` is used only when the plan is enabled for this person", async () => {
    const fake = fakeCodex([]);
    await expect(session({ chatgptLogin: true, spawn: fake.spawn, env: {} }).start()).rejects.toThrow(/not enabled/);
    expect(fake.run.spawned).toBeUndefined();
  });

  it("ChatGPT plan stays off unless the flag is on; no credentials at all is refused", async () => {
    const fake = fakeCodex([]);
    await expect(session({ chatgptPlan: { accessToken: "t" }, spawn: fake.spawn, env: {} }).start()).rejects.toThrow(
      /not enabled/,
    );
    await expect(session({ spawn: fake.spawn, env: {} }).start()).rejects.toThrow(/API key, a ChatGPT plan/);
    expect(fake.run.spawned).toBeUndefined();
  });

  it("a rejected login fails start with auth_required and stops the process", async () => {
    const r = replay([
      transcript[0]!,
      transcript[1]!,
      transcript[2]!,
      transcript[3]!,
      { dir: "recv", msg: { id: 1, error: { code: -32600, message: "Invalid API key (401)" } } },
    ]);
    const { start, events } = session({ apiKey: "sk-test-fixture", clientVersion: "0.1.0", spawn: r.spawn, env: {} });
    await expect(start()).rejects.toMatchObject({ code: "auth_required" });
    expect(r.state.mismatches).toEqual([]);
    expect(events).toEqual([]);
  });

  it("resumes a thread with thread/resume and reports its id", async () => {
    const fake = fakeCodex([[{ say: "ok" }]]);
    const { start, events, states } = session({ apiKey: "k", spawn: fake.spawn, env: {} }, { resume: "thr_old" });
    const h = await start();
    await waitFor(() => states().includes("idle"));
    h.close();
    await h.done;
    const resume = fake.run.received.find((m) => m.method === "thread/resume");
    expect(resume?.params).toMatchObject({
      threadId: "thr_old",
      sandbox: "workspace-write",
      approvalPolicy: "untrusted",
    });
    expect(fake.run.received.some((m) => m.method === "thread/start")).toBe(false);
    expect(events[0]).toEqual({ type: "started", providerSessionId: "thr_old" });
  });
});

describe("Codex adapter: approvals and sandbox", () => {
  it("never answers acceptForSession; every decision is a single accept or decline", async () => {
    const steps: FakeCodexStep[] = [{ command: "ls" }, { command: "rm -rf /" }, { edit: "/ws/a" }, { command: "pwd" }];
    const fake = fakeCodex([steps]);
    const { start, states } = session(
      { apiKey: "k", spawn: fake.spawn, env: {} },
      {},
      async (c) => c.input.command !== "rm -rf /",
    );
    const h = await start();
    await waitFor(() => states().includes("idle"));
    h.close();
    await h.done;
    expect(fake.run.decisions).toEqual(["accept", "decline", "accept", "accept"]);
  });

  it("gates every file of a multi-file patch; one denied path declines the whole patch", async () => {
    const fake = fakeCodex([[{ edit: ["/ws/a.ts", "/ws/.ssh/config", "/ws/b.ts"] }]]);
    const { calls, start, states } = session(
      { apiKey: "k", spawn: fake.spawn, env: {} },
      {},
      async (c) => !String(c.input.file_path).includes(".ssh"),
    );
    const h = await start();
    await waitFor(() => states().includes("idle"));
    h.close();
    await h.done;
    expect(calls.map((c) => c.input.file_path)).toEqual(["/ws/a.ts", "/ws/.ssh/config"]);
    expect(fake.run.decisions).toEqual(["decline"]);
    expect(fake.run.ran).toEqual([]);
  });

  it("a gate that throws is a denial", async () => {
    const fake = fakeCodex([[{ command: "make deploy" }]]);
    const { start, states } = session({ apiKey: "k", spawn: fake.spawn, env: {} }, {}, async () => {
      throw new Error("store down");
    });
    const h = await start();
    await waitFor(() => states().includes("idle"));
    h.close();
    await h.done;
    expect(fake.run.decisions).toEqual(["decline"]);
    expect(fake.run.ran).toEqual([]);
  });

  it("a gate still pending when the session closes never lets the tool run", async () => {
    const fake = fakeCodex([[{ command: "make deploy" }]]);
    const { calls, start, events } = session(
      { apiKey: "k", spawn: fake.spawn, env: {} },
      {},
      () => new Promise<boolean>(() => undefined),
    );
    const h = await start();
    await waitFor(() => calls.length === 1);
    h.close();
    await h.done;
    expect(fake.run.ran).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "state", state: "completed" });
  });

  it("maps permission modes to sandboxes and fails closed on anything else", async () => {
    expect(sandboxModeFor("plan")).toBe("read-only");
    expect(sandboxModeFor("default")).toBe("workspace-write");
    expect(sandboxModeFor("acceptEdits")).toBe("workspace-write");
    for (const bad of ["bypassPermissions", "dontAsk", "auto", "danger-full-access", ""]) {
      expect(sandboxModeFor(bad as RemotePermissionMode)).toBe("read-only");
      expect(sandboxPolicyFor(bad as RemotePermissionMode)).toEqual({ type: "readOnly", networkAccess: false });
    }
    const fake = fakeCodex([[{ say: "a" }], [{ say: "b" }]]);
    const { start, states } = session({ apiKey: "k", spawn: fake.spawn, env: {} }, { permissionMode: "acceptEdits" });
    const h = await start();
    await waitFor(() => states().filter((s) => s === "idle").length === 1);
    await h.setPermissionMode("bypassPermissions" as RemotePermissionMode);
    h.prompt("sigue", "client:phone1");
    await waitFor(() => states().filter((s) => s === "idle").length === 2);
    h.close();
    await h.done;
    expect(fake.run.sandboxes).toEqual([
      "workspace-write",
      {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      { type: "readOnly", networkAccess: false },
    ]);
  });

  it("queues a prompt sent mid-turn and runs it with its own origin", async () => {
    const fake = fakeCodex([[{ command: "ls" }], [{ command: "pwd" }]]);
    let release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    const { calls, start, states } = session({ apiKey: "k", spawn: fake.spawn, env: {} }, {}, async (c) => {
      if (c.input.command === "ls") await first;
      return true;
    });
    const h = await start();
    await waitFor(() => calls.length === 1);
    h.prompt("luego esto", "mcp:chatgpt");
    release();
    await waitFor(() => states().filter((s) => s === "idle").length === 2);
    h.close();
    await h.done;
    expect(calls.map((c) => [c.input.command, c.origin])).toEqual([
      ["ls", "client:phone1"],
      ["pwd", "mcp:chatgpt"],
    ]);
    expect(fake.run.received.filter((m) => m.method === "turn/start")).toHaveLength(2);
  });

  it("reports a crash when app-server exits on its own", async () => {
    const out = new InputQueue<string>();
    const transport: CodexTransport = {
      send: (line) => {
        const m = JSON.parse(line) as { id?: number; method?: string };
        if (m.id === undefined) return;
        const result =
          m.method === "thread/start"
            ? { thread: { id: "thr_1" } }
            : m.method === "turn/start"
              ? { turn: { id: "t1" } }
              : m.method === "mcpServerStatus/list"
                ? { data: [] }
                : m.method === "initialize"
                  ? { userAgent: "chalito/0.162.0 (Ubuntu 24.4.0; x86_64) xterm-256color (chalito; 0.0.0)" }
                  : {};
        out.push(JSON.stringify({ id: m.id, result }));
        if (m.method === "turn/start") setTimeout(() => out.close(), 5);
      },
      lines: out,
      close: () => out.close(),
    };
    const { start, events } = session({ apiKey: "k", spawn: () => transport, env: {} });
    const h = await start();
    await h.done;
    expect(events.slice(-2)).toEqual([
      { type: "error", code: "adapter_crash", message: "codex app-server exited" },
      { type: "state", state: "failed" },
    ]);
  });
});

describe("Codex adapter: approval policy", () => {
  it("sends approvalPolicy untrusted on every thread and turn, never a thread cwd, and runs in the session cwd", async () => {
    expect(APPROVAL_POLICY).toBe("untrusted");
    const fake = fakeCodex([[{ command: "ls" }], [{ edit: "/ws/a.ts" }]]);
    const { start, states } = session({ apiKey: "k", spawn: fake.spawn, env: {} }, { permissionMode: "plan" });
    const h = await start();
    await waitFor(() => states().filter((s) => s === "idle").length === 1);
    await h.setPermissionMode("acceptEdits");
    h.prompt("sigue", "client:phone1");
    await waitFor(() => states().filter((s) => s === "idle").length === 2);
    h.close();
    await h.done;
    expect(fake.run.policies).toEqual(["untrusted", "untrusted", "untrusted"]);
    const threadStart = fake.run.received.find((m) => m.method === "thread/start");
    expect(threadStart?.params).not.toHaveProperty("cwd");
    expect(fake.run.spawned?.cwd).toBe("/ws");
    expect(fake.run.violations).toEqual([]);
  });
});

describe("Codex adapter: isolated CODEX_HOME", () => {
  it("defaults to ~/.chalito/codex and is configurable", async () => {
    const fake = fakeCodex([[{ say: "ok" }]]);
    const { start, states } = session({ apiKey: "k", codexHome: "/srv/chalito/codex", spawn: fake.spawn, env: {} });
    const h = await start();
    await waitFor(() => states().includes("idle"));
    h.close();
    await h.done;
    expect(fake.run.spawned?.env.CODEX_HOME).toBe("/srv/chalito/codex");
  });

  it("the real spawn creates CODEX_HOME (0700), runs in the session cwd and never touches the user's ~/.codex", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chalito-codex-"));
    const home = join(dir, "home");
    const codexHome = join(dir, "chalito", "codex");
    const cwd = mkdtempSync(join(dir, "ws-"));
    const report = join(dir, "report");
    // A stand-in `codex` binary: records what it was started with, then exits without answering.
    const bin = join(dir, "codex");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' "$CODEX_HOME" "$(pwd)" "$*" > ${JSON.stringify(report)}\n`);
    chmodSync(bin, 0o755);
    const { start } = session(
      { apiKey: "k", codexPath: bin, codexHome, env: { PATH: process.env.PATH, HOME: home } },
      { cwd },
    );
    await expect(start()).rejects.toMatchObject({ code: "adapter_crash" });
    expect(readFileSync(report, "utf8").split("\n").slice(0, 3)).toEqual([codexHome, cwd, KEY_LAUNCH_ARGS.join(" ")]);
    expect(statSync(codexHome).mode & 0o777).toBe(0o700);
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  it("a stored key from earlier versions (CODEX_HOME/auth.json) is removed, and the key isn't on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chalito-codex-"));
    const codexHome = join(dir, "chalito", "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-old-leftover" }));
    const report = join(dir, "env");
    const bin = join(dir, "codex");
    writeFileSync(bin, `#!/bin/sh\nenv > ${JSON.stringify(report)}\n`);
    chmodSync(bin, 0o755);
    const { start } = session(
      {
        apiKey: "sk-live-in-env-only",
        codexPath: bin,
        codexHome,
        env: { PATH: process.env.PATH, CHALITO_SECRETS_PASSPHRASE: "p" },
      },
      { cwd: mkdtempSync(join(dir, "ws-")) },
    );
    await expect(start()).rejects.toMatchObject({ code: "adapter_crash" });
    expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
    const childEnv = readFileSync(report, "utf8");
    expect(childEnv).toContain(`${BYO_KEY_ENV}=sk-live-in-env-only`);
    expect(childEnv).not.toContain("CHALITO_SECRETS_PASSPHRASE");
  });
});

describe("Codex adapter: version pin", () => {
  it("reads the version from initialize's userAgent", () => {
    expect(codexVersionFromUserAgent("chalito/0.162.0 (Ubuntu 24.4.0; x86_64) xterm (chalito; 0.1.0)")).toBe("0.162.0");
    expect(codexVersionFromUserAgent("codex_cli_rs/0.162.0-alpha.11 (Mac OS 15.1.0; arm64) iTerm")).toBe(
      "0.162.0-alpha.11",
    );
    expect(codexVersionFromUserAgent("garbage")).toBeNull();
  });

  it("accepts the tested range and refuses anything else with a clear message", () => {
    const ua = (v: string) => `chalito/${v} (Ubuntu 24.4.0; x86_64) xterm (chalito; 0.1.0)`;
    for (const v of ["0.160.0", "0.161.3", "0.162.0-alpha.11"]) expect(() => checkCodexVersion(ua(v))).not.toThrow();
    for (const v of ["0.159.3", "0.163.0", "1.0.0", "0.0.0"])
      expect(() => checkCodexVersion(ua(v))).toThrow(
        new RegExp(`Codex ${v.replace(/\./g, "\\.")} is outside the tested range >=0\\.160\\.0 <0\\.163\\.0`),
      );
    expect(() => checkCodexVersion("garbage")).toThrow(/unrecognised version/);
    expect(() => checkCodexVersion(ua("0.170.1"), { min: "0.170.0", below: "0.171.0" })).not.toThrow();
  });

  it("an untested app-server fails start before any login and stops the process", async () => {
    const fake = fakeCodex([], undefined, {
      userAgent: "chalito/0.150.0 (Ubuntu 24.4.0; x86_64) xterm (chalito; 0.0.0)",
    });
    const { start, events } = session({ apiKey: "k", spawn: fake.spawn, env: {} });
    await expect(start()).rejects.toMatchObject({
      code: "unsupported_version",
      message: expect.stringMatching(/Codex 0\.150\.0 is outside the tested range/),
    });
    expect(fake.run.received.map((m) => m.method)).toEqual(["initialize"]);
    expect(events).toEqual([]);
  });
});

describe("Codex adapter: tools that skip approvals", () => {
  it("launches with web search, view_image and the MCP-backed and code-running features off", async () => {
    expect(HARDENING_OVERRIDES).toEqual(
      expect.arrayContaining([
        'web_search="disabled"',
        "features.view_image=false",
        "features.apps=false",
        "features.plugins=false",
        "features.enable_mcp_apps=false",
        "features.js_repl=false",
        "features.code_mode=false",
        "features.browser_use=false",
        "features.computer_use=false",
      ]),
    );
    const fake = fakeCodex([[{ say: "ok" }]]);
    const { start, states } = session({ apiKey: "k", spawn: fake.spawn, env: {} });
    const h = await start();
    await waitFor(() => states().includes("idle"));
    h.close();
    await h.done;
    const args = fake.run.spawned!.args;
    for (const o of HARDENING_OVERRIDES) expect(args[args.indexOf(o) - 1]).toBe("-c");
    expect(fake.run.received.map((m) => m.method).slice(2, 5)).toEqual([
      "thread/start",
      "mcpServerStatus/list",
      "turn/start",
    ]);
    expect(fake.run.received[3]?.params).toEqual({ threadId: "thr_fake_1", detail: "toolsAndAuthOnly" });
    expect(fake.run.violations).toEqual([]);
  });

  it("the fake flags a launch without the overrides", () => {
    const fake = fakeCodex([]);
    fake.spawn("codex", ["app-server", "--listen", "stdio://"], {}, "/ws").close();
    expect(fake.run.violations).toContain('missing -c web_search="disabled"');
    expect(fake.run.violations).toContain("missing -c features.view_image=false");
  });

  it("refuses to run when Codex has MCP servers configured, before any turn", async () => {
    const fake = fakeCodex([[{ say: "never" }]], undefined, { mcpServers: ["corp-db", "github"] });
    const { start, events } = session({ apiKey: "k", spawn: fake.spawn, env: {} });
    await expect(start()).rejects.toMatchObject({
      code: "mcp_not_allowed",
      message: expect.stringContaining("MCP servers configured outside Chalito (corp-db, github)"),
    });
    expect(fake.run.received.some((m) => m.method === "turn/start")).toBe(false);
    expect(events).toEqual([]);
  });

  it("the agent's own computer-control server is defined by -c overrides and allowed; others still refuse", async () => {
    const own = {
      chalito_computer: {
        command: "C:\\Program Files\\Chalito\\chalito-agent.exe",
        args: ["computer", "mcp"],
        env: { CHALITO_COMPUTER_SOCKET: "/s", CHALITO_COMPUTER_TOKEN: 't"ok' },
      },
    };
    expect(mcpServerOverrides(own)).toEqual([
      'mcp_servers.chalito_computer.command="C:\\\\Program Files\\\\Chalito\\\\chalito-agent.exe"',
      'mcp_servers.chalito_computer.args=["computer","mcp"]',
      'mcp_servers.chalito_computer.env={CHALITO_COMPUTER_SOCKET="/s",CHALITO_COMPUTER_TOKEN="t\\"ok"}',
      "mcp_servers.chalito_computer.startup_timeout_sec=20",
      "mcp_servers.chalito_computer.tool_timeout_sec=660",
    ]);
    expect(() => mcpServerOverrides({ "bad name": own.chalito_computer })).toThrow(/Refused/);
    expect(() => mcpServerOverrides({ x: { ...own.chalito_computer, env: { "A=B": "1" } } })).toThrow(/Refused/);

    const fake = fakeCodex([[{ say: "hola" }]], undefined, { mcpServers: ["chalito_computer"] });
    const ok = session({ apiKey: "k", spawn: fake.spawn, env: {} }, { mcpServers: own });
    const h = await ok.start();
    expect(fake.run.spawned!.args).toContain("mcp_servers.chalito_computer.tool_timeout_sec=660");
    h.close();

    const extra = fakeCodex([[{ say: "never" }]], undefined, { mcpServers: ["chalito_computer", "corp-db"] });
    await expect(
      session({ apiKey: "k", spawn: extra.spawn, env: {} }, { mcpServers: own }).start(),
    ).rejects.toMatchObject({ code: "mcp_not_allowed", message: expect.stringContaining("(corp-db)") });
  });
});
