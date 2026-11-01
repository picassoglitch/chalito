import { duplexPair, PassThrough, type Duplex } from "node:stream";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openJson } from "@chalito/crypto";
import { AgentEvent } from "@chalito/protocol";
import { NativeBridge } from "../src/native/bridge.js";
import {
  nativeHookInput,
  nativeHookOutput,
  nativeWorkspacePaths,
  nativeWorkspaceStatus,
  writeNativeWorkspaces,
  NATIVE_WORKSPACES_FILE,
  type NativeProvider,
} from "../src/native/protocol.js";
import { main } from "../src/cli.js";
import type { AgentStore } from "../src/store.js";
import { runNativeHook } from "../src/native/cli.js";
import { codeService } from "../src/code/service.js";
import { startCodeServer } from "../src/code/server.js";
import { agentFor, HOME, WS, tempDir, waitFor } from "./rc-harness.js";

const rig = async (
  opts: { ledger?: string; logs?: string[]; ws?: string; enabled?: () => boolean | "unreadable" } = {},
) => {
  const agent = await agentFor(opts.ws ? { ws: opts.ws } : {});
  const code = codeService(
    agent.core,
    () => agent.policy.get(),
    () => ({ adapters: [], labels: ["chalito"], workspaces: 1 }),
    "local:cli",
    HOME,
  );
  let enabled = true;
  const bridge = new NativeBridge({
    core: agent.core,
    store: agent.store,
    deviceId: agent.self.id,
    enabled: opts.enabled ?? (() => enabled),
    workspaceFor: code.workspaceFor,
    home: HOME,
    now: Date.now,
    locale: () => "en",
    ...(opts.ledger ? { ledger: opts.ledger } : {}),
    log: (event) => void opts.logs?.push(event),
  });
  return {
    ...agent,
    bridge,
    code,
    disable: () => {
      enabled = false;
    },
  };
};

describe("native apps → Chalito approvals (no provider keys or inference)", () => {
  it.each(["codex", "claude", "cursor"] as const)(
    "round-trips a %s hook through the real socket protocol and signed human decision",
    async (provider) => {
      const s = await rig();
      let accept!: (stream: Duplex) => void;
      const server = await startCodeServer({
        path: "native-test",
        platform: "win32",
        code: s.code,
        native: (request, signal) => s.bridge.handle(request, signal),
        listen: (_path, onStream) => {
          accept = onStream;
          return { close: () => undefined };
        },
      });
      const input = new PassThrough();
      let output = "";
      const event = provider === "cursor" ? "preToolUse" : "PreToolUse";
      input.end(
        JSON.stringify({
          hook_event_name: event,
          session_id: "real-native-session",
          cwd: WS,
          tool_name: provider === "cursor" ? "Shell" : "Bash",
          tool_input: { command: "npm install left-pad" },
        }),
      );
      try {
        const hook = runNativeHook(
          {
            input,
            out: (text) => {
              output += text;
            },
            openPipe: () => {
              const [client, native] = duplexPair();
              accept(native);
              return { ok: true, stream: client };
            },
          },
          "native-test",
          provider,
          event,
          "en",
        );
        await waitFor(() => s.store.pendingApprovals().length === 1);
        const pending = s.store.pendingApprovals()[0]!;
        expect(s.store.sessions.get(pending.sid)).toMatchObject({ control: "approvals", kind: "agent" });
        expect(s.adapter.runs).toHaveLength(0);
        await s.answer(true);
        expect(await hook).toBe(0);
        const reply = JSON.parse(output);
        // Codex rejects an explicit allow as a hook failure, so its approval is "no objection".
        if (provider === "codex") expect(reply).toEqual({});
        else
          expect(provider === "cursor" ? reply.permission : reply.hookSpecificOutput.permissionDecision).toBe("allow");
        expect(s.store.pendingApprovals()).toHaveLength(0);
        expect(s.store.events.every((event) => AgentEvent.safeParse(event).success)).toBe(true);
        expect(JSON.stringify([...s.store.sessions.values()])).not.toContain("real-native-session");
      } finally {
        s.bridge.close();
        await server.close();
      }
    },
  );

  it("mirrors native prompt/reply events encrypted for the same signed-in clients", async () => {
    const s = await rig();
    const signal = new AbortController().signal;
    const start = await s.bridge.handle(
      { provider: "claude", event: "start", nativeSessionId: "native", cwd: WS },
      signal,
    );
    await s.bridge.handle(
      { provider: "claude", event: "prompt", nativeSessionId: "native", cwd: WS, text: "fix this" },
      signal,
    );
    await s.bridge.handle(
      { provider: "claude", event: "stop", nativeSessionId: "native", cwd: WS, text: "done" },
      signal,
    );
    const events = s.store.events.filter(
      (event) => event.sid === start.sid && (event.type === "message.user" || event.type === "message.assistant"),
    );
    const texts = await Promise.all(
      events.map((event) => {
        if (event.type !== "message.user" && event.type !== "message.assistant") throw new Error("unexpected event");
        return openJson<{ text: string }>(event.ct, s.phone.id, s.phone.box, `event:${start.sid}`);
      }),
    );
    expect(texts).toEqual([{ text: "fix this" }, { text: "done" }]);
    expect(JSON.stringify(s.store.events)).not.toContain("fix this");
    s.bridge.close();
  });

  it("denies a tool when the connector is disabled or its connection is cancelled", async () => {
    const s = await rig();
    const abort = new AbortController();
    const ask = s.bridge.handle(
      {
        provider: "codex",
        event: "tool",
        nativeSessionId: "native",
        cwd: WS,
        toolName: "Bash",
        input: { command: "npm install x" },
      },
      abort.signal,
    );
    await waitFor(() => s.store.pendingApprovals().length === 1);
    abort.abort();
    expect((await ask).allow).toBe(false);
    s.disable();
    expect(
      await s.bridge.handle(
        { provider: "codex", event: "start", nativeSessionId: "other", cwd: WS },
        new AbortController().signal,
      ),
    ).toMatchObject({ ok: false, reason: "connector_disabled" });
    s.bridge.close();
  });

  it("gives no decision outside workspaces and blocks protected files even when the native app asks", async () => {
    const s = await rig();
    const signal = new AbortController().signal;
    expect(
      await s.bridge.handle(
        { provider: "claude", event: "start", nativeSessionId: "outside", cwd: "/not-allowed" },
        signal,
      ),
    ).toEqual({ ok: true, pass: true });
    expect(
      await s.bridge.handle(
        {
          provider: "claude",
          event: "tool",
          nativeSessionId: "outside",
          cwd: "/not-allowed",
          toolName: "Read",
          input: { file_path: "/not-allowed/a.txt" },
        },
        signal,
      ),
    ).toEqual({ ok: true, pass: true });
    const deny = await s.bridge.handle(
      {
        provider: "claude",
        event: "tool",
        nativeSessionId: "inside",
        cwd: WS,
        toolName: "Write",
        input: { file_path: join(HOME, ".chalito", "trusted-clients.json"), content: "{}" },
      },
      signal,
    );
    expect(deny.allow).toBe(false);
    expect(s.store.pendingApprovals()).toHaveLength(0);
    s.bridge.close();
  });

  it("returns a vendor denial when the local agent is unavailable or the hook payload is malformed", async () => {
    for (const provider of ["codex", "claude", "cursor"] as const) {
      const event = provider === "cursor" ? "preToolUse" : "PreToolUse";
      const input = new PassThrough();
      input.end("not JSON");
      let output = "";
      await runNativeHook(
        {
          input,
          out: (text) => {
            output += text;
          },
        },
        null,
        provider,
        event,
        "en",
      );
      const reply = JSON.parse(output);
      expect(provider === "cursor" ? reply.permission : reply.hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });

  it("normalizes all three vendor payloads without reading transcripts or accepting event substitutions", () => {
    for (const provider of ["codex", "claude", "cursor"] as NativeProvider[]) {
      const event = provider === "cursor" ? "preToolUse" : "PreToolUse";
      const raw = JSON.stringify({
        hook_event_name: event,
        conversation_id: "session",
        cwd: WS,
        tool_name: "Read",
        tool_input: { path: "a.txt" },
        transcript_path: "/never/read/this",
      });
      const parsed = nativeHookInput(provider, event, raw)!;
      expect(parsed).toMatchObject({ provider, event: "tool", nativeSessionId: "session" });
      expect(JSON.stringify(parsed)).not.toContain("transcript");
      expect(nativeHookInput(provider, "PermissionRequest", raw)).toBeNull();
      expect(JSON.stringify(nativeHookOutput(provider, event, { ok: false, allow: true }))).not.toContain('"allow"');
    }
  });
});

/** The real code.sock server in front of a bridge, reached the way the hook reaches it on Windows. */
const serve = async (s: Awaited<ReturnType<typeof rig>>) => {
  let accept!: (stream: Duplex) => void;
  const server = await startCodeServer({
    path: "native-test",
    platform: "win32",
    code: s.code,
    native: (request, signal) => s.bridge.handle(request, signal),
    listen: (_path, onStream) => {
      accept = onStream;
      return { close: () => undefined };
    },
  });
  return {
    openPipe: () => {
      const [client, native] = duplexPair();
      accept(native);
      return { ok: true as const, stream: client };
    },
    close: () => server.close(),
  };
};
const hookPayload = (provider: NativeProvider, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    hook_event_name: provider === "cursor" ? "preToolUse" : "PreToolUse",
    session_id: "s1",
    cwd: WS,
    tool_name: "Bash",
    tool_input: { command: "npm install left-pad" },
    ...extra,
  });
const runHook = async (
  provider: NativeProvider,
  payload: string,
  opts: {
    path?: string | null;
    openPipe?: () => { ok: true; stream: Duplex };
    status?: (cwd: string) => "inside" | "outside" | "unknown";
    locale?: "es" | "en";
    input?: PassThrough;
    idleMs?: number;
  } = {},
) => {
  const input = opts.input ?? new PassThrough();
  if (!opts.input) input.end(payload);
  let output = "";
  const code = await runNativeHook(
    {
      input,
      out: (text) => {
        output += text;
      },
      ...(opts.openPipe ? { openPipe: opts.openPipe } : {}),
      ...(opts.status ? { workspaceStatus: opts.status } : {}),
      home: HOME,
    },
    opts.path === undefined ? "native-test" : opts.path,
    provider,
    provider === "cursor" ? "preToolUse" : "PreToolUse",
    opts.locale ?? "en",
    { connectMs: 500, ...(opts.idleMs ? { idleMs: opts.idleMs } : {}) },
  );
  return { code, reply: JSON.parse(output) as Record<string, unknown> };
};
const decisionOf = (provider: NativeProvider, reply: Record<string, unknown>) =>
  provider === "cursor"
    ? { decision: reply.permission, message: reply.user_message }
    : {
        decision: (reply.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision,
        message: (reply.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecisionReason,
      };

describe("native hook review fixes (owner decisions 2026-10-31)", () => {
  it("passes outside workspaces through the real socket: every app gets no decision", async () => {
    const s = await rig();
    const server = await serve(s);
    try {
      for (const provider of ["codex", "claude", "cursor"] as const) {
        const { code, reply } = await runHook(provider, hookPayload(provider, { cwd: "/tmp" }), {
          openPipe: server.openPipe,
        });
        expect(code).toBe(0);
        expect(reply).toEqual({});
      }
      expect(s.store.pendingApprovals()).toHaveLength(0);
    } finally {
      await s.bridge.close();
      await server.close();
    }
  });

  it("names the reason for a denial: a signed human 'no' reads as denied by you", async () => {
    for (const provider of ["codex", "claude", "cursor"] as const) {
      const s = await rig();
      const server = await serve(s);
      try {
        const hook = runHook(provider, hookPayload(provider), { openPipe: server.openPipe });
        await waitFor(() => s.store.pendingApprovals().length === 1);
        await s.answer(false);
        expect(decisionOf(provider, (await hook).reply)).toEqual({
          decision: "deny",
          message: "You denied this action in Chalito.",
        });
      } finally {
        await s.bridge.close();
        await server.close();
      }
    }
  });

  it("maps each deny reason to its own message, in Spanish too, and allows only ok && allow", () => {
    const cases: [string | undefined, string][] = [
      ["not_running", "Chalito isn't running on this computer. Open Chalito to approve this action."],
      ["signed_deny", "You denied this action in Chalito."],
      ["policy_block", "Chalito's rules for this folder block this action."],
      ["outside_workspace", "Chalito's rules for this folder block this action."],
      ["busy", "Chalito has too many requests waiting. Try again in a moment."],
      [
        "connector_disabled",
        "Chalito's connector for this app is turned off. Turn it on in Chalito's Connected AI tab.",
      ],
      ["too_large", "This request is too large for Chalito to review, so it was denied."],
      ["ambiguous_path", "This request names two different files, so Chalito denied it."],
      [undefined, "Chalito did not approve this action. Check Chalito on this computer or on your phone."],
    ];
    for (const [reason, text] of cases)
      expect(nativeHookOutput("claude", "PreToolUse", { ok: false, reason })).toEqual({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: text },
      });
    expect(nativeHookOutput("cursor", "preToolUse", { ok: false, reason: "not_running" }, "es")).toMatchObject({
      permission: "deny",
      user_message: "Chalito no está abierto en esta computadora. Abre Chalito para aprobar esta acción.",
    });
    expect(nativeHookOutput("claude", "PreToolUse", { ok: true, allow: true })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    expect(nativeHookOutput("cursor", "preToolUse", { ok: true, allow: true })).toEqual({ permission: "allow" });
    expect(nativeHookOutput("codex", "PreToolUse", { ok: true, allow: true })).toEqual({});
    // Neither a pass nor an allow survives ok !== true.
    for (const provider of ["codex", "claude", "cursor"] as const) {
      const event = provider === "cursor" ? "preToolUse" : "PreToolUse";
      expect(JSON.stringify(nativeHookOutput(provider, event, { ok: false, pass: true }))).toContain('"deny"');
      expect(JSON.stringify(nativeHookOutput(provider, event, { ok: false, allow: true }))).toContain('"deny"');
      expect(nativeHookOutput(provider, event, { ok: true, pass: true })).toEqual({});
    }
  });

  it("denies a Cursor request whose path and file_path name different files", async () => {
    const s = await rig();
    const reply = await s.bridge.handle(
      {
        provider: "cursor",
        event: "tool",
        nativeSessionId: "c1",
        cwd: WS,
        toolName: "Write",
        input: { path: join(WS, "a.txt"), file_path: join(HOME, ".bashrc"), content: "x" },
      },
      new AbortController().signal,
    );
    expect(reply).toMatchObject({ ok: true, allow: false, reason: "ambiguous_path" });
    expect(s.store.pendingApprovals()).toHaveLength(0);
    const same = await s.bridge.handle(
      {
        provider: "cursor",
        event: "tool",
        nativeSessionId: "c1",
        cwd: WS,
        toolName: "Read",
        input: { path: join(WS, "a.txt"), file_path: join(WS, "a.txt") },
      },
      new AbortController().signal,
    );
    expect(same).toMatchObject({ allow: true });
    await s.bridge.close();
  });

  it("classifies Codex's argv shell commands as run, and refuses shell input it can't read", async () => {
    const s = await rig();
    const req = (input: Record<string, unknown>, id = "x1") => ({
      provider: "codex" as const,
      event: "tool" as const,
      nativeSessionId: id,
      cwd: WS,
      toolName: "Bash",
      input,
    });
    // A read-only argv still reads as read-only once joined.
    expect(await s.bridge.handle(req({ command: ["ls", "-la"] }), new AbortController().signal)).toMatchObject({
      allow: true,
    });
    // A destructive argv must reach a human, never auto-allow as an "empty" command.
    const abort = new AbortController();
    const waiting = s.bridge.handle(req({ command: ["rm", "-rf", join(WS, "src")] }), abort.signal);
    await vi.waitFor(() => expect(s.store.pendingApprovals()).toHaveLength(1));
    abort.abort();
    expect(await waiting).toMatchObject({ allow: false });
    for (const command of [undefined, 5, [], ["rm", 1], "   "])
      expect(await s.bridge.handle(req({ command }, "x2"), new AbortController().signal)).toMatchObject({
        allow: false,
        reason: "unsupported_input",
      });
    // Two folder fields that disagree are refused instead of picking one.
    expect(
      await s.bridge.handle(req({ command: "ls", cwd: WS, workdir: HOME }, "x3"), new AbortController().signal),
    ).toMatchObject({ allow: false, reason: "ambiguous_path" });
    await s.bridge.close();
  });

  it("asks a human when a read names its file under a key Chalito doesn't read", async () => {
    const s = await rig();
    const abort = new AbortController();
    const waiting = s.bridge.handle(
      {
        provider: "cursor",
        event: "tool",
        nativeSessionId: "hidden",
        cwd: WS,
        toolName: "Read",
        input: { target_file: join(HOME, ".chalito", "trusted-clients.json") },
      },
      abort.signal,
    );
    await vi.waitFor(() => expect(s.store.pendingApprovals()).toHaveLength(1));
    abort.abort();
    expect(await waiting).toMatchObject({ allow: false });
    await s.bridge.close();
  });

  it("allows ten parallel read-only tool calls from one session (Claude's normal fan-out)", async () => {
    const s = await rig();
    const signal = new AbortController().signal;
    const replies = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        s.bridge.handle(
          {
            provider: "claude",
            event: "tool",
            nativeSessionId: "parallel",
            cwd: WS,
            toolName: "Read",
            input: { file_path: join(WS, `file-${i}.ts`) },
          },
          signal,
        ),
      ),
    );
    expect(replies.map((r) => r.allow)).toEqual(Array(10).fill(true));
    await s.bridge.close();
  });

  it("keeps an approved decision when the store fails while recording the session state", async () => {
    const logs: string[] = [];
    const s = await rig({ logs });
    const ask = s.bridge.handle(
      {
        provider: "claude",
        event: "tool",
        nativeSessionId: "flaky",
        cwd: WS,
        toolName: "Bash",
        input: { command: "npm install left-pad" },
      },
      new AbortController().signal,
    );
    await waitFor(() => s.store.pendingApprovals().length === 1);
    const store = s.store as AgentStore;
    store.upsertSession = async () => {
      throw new Error("db down");
    };
    store.writeEvent = async () => {
      throw new Error("db down");
    };
    await s.answer(true);
    expect(await ask).toMatchObject({ ok: true, allow: true });
    await vi.waitFor(() => expect(logs).toContain("native.state_write_failed"));
  });

  it("awaits interrupted writes on close and sweeps sessions an earlier run left live", async () => {
    const dir = tempDir("chalito-native-ledger-");
    const ledger = join(dir, "native-sessions.json");
    const s = await rig({ ledger });
    const start = await s.bridge.handle(
      { provider: "codex", event: "start", nativeSessionId: "n1", cwd: WS },
      new AbortController().signal,
    );
    expect(JSON.parse(readFileSync(ledger, "utf8")).sids).toEqual([start.sid]);
    if (process.platform !== "win32") expect(statSync(ledger).mode & 0o777).toBe(0o600);
    await s.bridge.close();
    expect(s.store.sessions.get(start.sid!)).toMatchObject({ state: "interrupted", live: false });
    expect(JSON.parse(readFileSync(ledger, "utf8")).sids).toEqual([]);

    // A crash: the ledger still names a live session, and one non-native id that must be ignored.
    writeFileSync(ledger, JSON.stringify({ v: 1, sids: ["native-ghost", "managed-1"] }));
    const next = await rig({ ledger });
    await next.bridge.sweep();
    expect(next.store.sessions.get("native-ghost")).toMatchObject({ state: "interrupted", live: false });
    expect(next.store.sessions.has("managed-1")).toBe(false);
    expect(JSON.parse(readFileSync(ledger, "utf8")).sids).toEqual([]);
    await next.bridge.close();
  });

  describe("agent not running", () => {
    const dir = tempDir("chalito-native-down-");
    const missingSocket = join(dir, "code.sock");
    const outside = tempDir("chalito-native-outside-");

    it("denies in a workspace and passes elsewhere, using the agent's workspace file", async () => {
      writeNativeWorkspaces(dir, nativeWorkspacePaths([{ path: WS }], HOME));
      if (process.platform !== "win32") expect(statSync(join(dir, NATIVE_WORKSPACES_FILE)).mode & 0o777).toBe(0o600);
      const status = (cwd: string) => nativeWorkspaceStatus(dir, cwd);
      for (const provider of ["codex", "claude", "cursor"] as const) {
        const inside = await runHook(provider, hookPayload(provider, { cwd: join(WS, "src") }), {
          path: missingSocket,
          status,
        });
        expect(decisionOf(provider, inside.reply)).toEqual({
          decision: "deny",
          message: "Chalito isn't running on this computer. Open Chalito to approve this action.",
        });
        const es = await runHook(provider, hookPayload(provider), { path: missingSocket, status, locale: "es" });
        expect(decisionOf(provider, es.reply).message).toBe(
          "Chalito no está abierto en esta computadora. Abre Chalito para aprobar esta acción.",
        );
        const away = await runHook(provider, hookPayload(provider, { cwd: outside }), { path: missingSocket, status });
        expect(away.reply).toEqual({});
      }
    });

    it("matches workspaces on a path-segment boundary, by real path", () => {
      writeNativeWorkspaces(dir, nativeWorkspacePaths([{ path: WS }], HOME));
      expect(nativeWorkspaceStatus(dir, WS)).toBe("inside");
      expect(nativeWorkspaceStatus(dir, join(WS, "a", "b"))).toBe("inside");
      expect(nativeWorkspaceStatus(dir, `${WS}-evil`)).toBe("outside");
      expect(nativeWorkspaceStatus(dir, join(WS, "..", "chalito-other"))).toBe("outside");
    });

    it("denies a malformed payload unless it names a folder outside every workspace", async () => {
      writeNativeWorkspaces(dir, nativeWorkspacePaths([{ path: WS }], HOME));
      const status = (cwd: string) => nativeWorkspaceStatus(dir, cwd);
      const noSession = (cwd: string) => JSON.stringify({ hook_event_name: "PreToolUse", cwd, tool_name: "Bash" });
      const inside = await runHook("claude", noSession(WS), { path: missingSocket, status });
      expect(decisionOf("claude", inside.reply).decision).toBe("deny");
      expect((await runHook("claude", noSession(outside), { path: missingSocket, status })).reply).toEqual({});
      expect(decisionOf("claude", (await runHook("claude", "not JSON", { status })).reply).decision).toBe("deny");
    });

    it("fails closed when the workspace file is missing or malformed", async () => {
      const empty = tempDir("chalito-native-nofile-");
      const status = (cwd: string) => nativeWorkspaceStatus(empty, cwd);
      expect(status(outside)).toBe("unknown");
      const missing = await runHook("claude", hookPayload("claude", { cwd: outside }), { path: missingSocket, status });
      expect(decisionOf("claude", missing.reply).decision).toBe("deny");
      writeFileSync(join(empty, NATIVE_WORKSPACES_FILE), "{not json");
      expect(status(outside)).toBe("unknown");
      writeFileSync(join(empty, NATIVE_WORKSPACES_FILE), JSON.stringify({ v: 1, paths: "nope" }));
      const bad = await runHook("cursor", hookPayload("cursor", { cwd: outside }), { path: missingSocket, status });
      expect(bad.reply).toMatchObject({ permission: "deny" });
    });

    it("denies an oversized request in a workspace and passes it elsewhere", async () => {
      writeNativeWorkspaces(dir, nativeWorkspacePaths([{ path: WS }], HOME));
      const status = (cwd: string) => nativeWorkspaceStatus(dir, cwd);
      const big = { tool_name: "Write", tool_input: { file_path: join(WS, "a.txt"), content: "x".repeat(70_000) } };
      const inside = await runHook("claude", hookPayload("claude", big), { path: missingSocket, status });
      expect(decisionOf("claude", inside.reply)).toEqual({
        decision: "deny",
        message: "This request is too large for Chalito to review, so it was denied.",
      });
      // Outside means the file too: a workspace file_path from an outside cwd is still a workspace action.
      const awayBig = { ...big, tool_input: { ...big.tool_input, file_path: join(outside, "a.txt") } };
      const away = await runHook("claude", hookPayload("claude", { ...awayBig, cwd: outside }), {
        path: missingSocket,
        status,
      });
      expect(away.reply).toEqual({});
    });
  });

  describe("chalito native-hook entry point", () => {
    const cliIo = (opts: { platform?: NodeJS.Platform; stdin?: string; winFails?: boolean } = {}) => {
      const out: string[] = [];
      const err: string[] = [];
      const input = new PassThrough();
      input.end(opts.stdin ?? "");
      return {
        out,
        err,
        io: {
          out: (t: string) => void out.push(t),
          err: (t: string) => void err.push(t),
          tty: { input, output: new PassThrough() },
          env: {},
          home: tempDir("chalito-native-cli-"),
          platform: opts.platform ?? ("linux" as NodeJS.Platform),
          runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
          fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
          now: Date.now,
          execPath: "/x",
          tmpdir: tempDir("chalito-native-tmp-"),
          ...(opts.winFails
            ? {
                winPipeSecurity: async () => {
                  throw new Error("pipe helper crashed");
                },
              }
            : {}),
        },
      };
    };

    it("blocks on a crash: exit 2 with a deny for Claude and Cursor, the JSON deny alone for Codex", async () => {
      for (const [provider, event, exit] of [
        ["claude", "PreToolUse", 2],
        ["cursor", "preToolUse", 2],
        ["codex", "PreToolUse", 0],
      ] as const) {
        const c = cliIo({ platform: "win32", winFails: true, stdin: hookPayload(provider) });
        expect(await main(["native-hook", provider, event], c.io as never)).toBe(exit);
        expect(decisionOf(provider, JSON.parse(c.out.join(""))).decision).toBe("deny");
        expect(c.err.join("")).toContain("Chalito");
      }
    });

    it("denies an unknown event and rejects an unknown app instead of passing", async () => {
      for (const [provider, exit] of [
        ["claude", 2],
        ["cursor", 2],
        ["codex", 0],
      ] as const) {
        const c = cliIo();
        expect(await main(["native-hook", provider, "NotAnEvent"], c.io as never)).toBe(exit);
        expect(decisionOf(provider, JSON.parse(c.out.join(""))).decision).toBe("deny");
        const missing = cliIo();
        expect(await main(["native-hook", provider], missing.io as never)).toBe(exit);
      }
      const unknown = cliIo();
      expect(await main(["native-hook", "gemini", "PreToolUse"], unknown.io as never)).toBe(2);
      expect(unknown.out.join("")).toBe("");
    });

    it("denies in a workspace when the agent isn't running, via the real CLI and workspace file", async () => {
      const c = cliIo({ stdin: hookPayload("claude") });
      const dir = join(c.io.home, ".chalito");
      mkdirSync(dir, { recursive: true });
      writeNativeWorkspaces(dir, [WS]);
      expect(await main(["native-hook", "claude", "PreToolUse"], c.io as never)).toBe(0);
      // No configured locale: the hook speaks Spanish, the product default.
      expect(decisionOf("claude", JSON.parse(c.out.join("")))).toEqual({
        decision: "deny",
        message: "Chalito no está abierto en esta computadora. Abre Chalito para aprobar esta acción.",
      });
      const away = cliIo({ stdin: hookPayload("claude", { cwd: tempDir("chalito-native-away-") }) });
      mkdirSync(join(away.io.home, ".chalito"), { recursive: true });
      writeNativeWorkspaces(join(away.io.home, ".chalito"), [WS]);
      expect(await main(["native-hook", "claude", "PreToolUse"], away.io as never)).toBe(0);
      expect(JSON.parse(away.out.join(""))).toEqual({});
    });
  });
});

describe("native hook review fixes, round 2", () => {
  const down = tempDir("chalito-native-r2-");
  const missingSocket = join(down, "code.sock");
  const outside = tempDir("chalito-native-r2-outside-");
  const status = (cwd: string) => nativeWorkspaceStatus(down, cwd);
  const signal = () => new AbortController().signal;
  const tool = (provider: NativeProvider, fields: Record<string, unknown>) =>
    JSON.stringify({
      hook_event_name: provider === "cursor" ? "preToolUse" : "PreToolUse",
      session_id: "r2",
      ...fields,
    });
  /** Runs the hook against a live agent and reports whether Chalito asked a human (then denies it). */
  const askedUp = async (provider: NativeProvider, payload: string, ws?: string) => {
    const s = await rig(ws ? { ws } : {});
    const server = await serve(s);
    try {
      const hook = runHook(provider, payload, { openPipe: server.openPipe });
      const asked = await Promise.race([
        waitFor(() => s.store.pendingApprovals().length === 1).then(() => true),
        hook.then(() => false),
      ]);
      if (asked) await s.answer(false);
      return { asked, reply: (await hook).reply };
    } finally {
      await s.bridge.close();
      await server.close();
    }
  };

  it("matches a `~` workspace with the agent up and down", async () => {
    const asked = await askedUp("claude", hookPayload("claude", { cwd: join(WS, "src") }), "~/code/chalito");
    expect(asked.asked).toBe(true);
    expect(decisionOf("claude", asked.reply).decision).toBe("deny");
    const s = await rig({ ws: "~/code/chalito" });
    expect(s.code.workspaceFor(WS)).toBe("chalito");
    expect(s.code.workspaceFor(outside)).toBeNull();
    const home = codeService(
      s.core,
      () => ({ ...s.policy.get(), workspaces: [{ label: "home", path: "~" }] }),
      () => ({ adapters: [], labels: ["home"], workspaces: 1 }),
      "local:cli",
      HOME,
    );
    expect(home.workspaceFor(join(HOME, "x"))).toBe("home");
    await s.bridge.close();
    writeNativeWorkspaces(down, nativeWorkspacePaths([{ path: "~/code/chalito" }], HOME));
    const off = await runHook("claude", hookPayload("claude", { cwd: join(WS, "src") }), {
      path: missingSocket,
      status,
    });
    expect(decisionOf("claude", off.reply).decision).toBe("deny");
  });

  describe("gates where the action lands, not where the app opened", () => {
    const edit = tool("claude", {
      cwd: HOME,
      tool_name: "Edit",
      tool_input: { file_path: join(WS, "src", "a.ts"), old_string: "a", new_string: "b" },
    });
    const codexShell = tool("codex", {
      cwd: HOME,
      tool_name: "Bash",
      tool_input: { command: "npm install left-pad", workdir: WS },
    });
    const cursorRoots = tool("cursor", {
      workspace_roots: [outside, WS],
      tool_name: "Shell",
      tool_input: { command: "ls" },
    });

    it("asks a human with the agent up", async () => {
      for (const [provider, payload] of [
        ["claude", edit],
        ["codex", codexShell],
        ["cursor", cursorRoots],
      ] as const) {
        const { asked, reply } = await askedUp(provider, payload);
        expect(asked, provider).toBe(true);
        expect(decisionOf(provider, reply).decision).toBe("deny");
      }
    });

    it("denies with the agent down", async () => {
      writeNativeWorkspaces(down, nativeWorkspacePaths([{ path: WS }], HOME));
      for (const [provider, payload] of [
        ["claude", edit],
        ["codex", codexShell],
        ["cursor", cursorRoots],
      ] as const) {
        const { reply } = await runHook(provider, payload, { path: missingSocket, status });
        expect(decisionOf(provider, reply).decision, provider).toBe("deny");
      }
    });

    it("still gives no decision when every target is outside", async () => {
      writeNativeWorkspaces(down, nativeWorkspacePaths([{ path: WS }], HOME));
      const away = [
        ["claude", tool("claude", { cwd: HOME, tool_name: "Edit", tool_input: { file_path: join(outside, "a.ts") } })],
        ["codex", tool("codex", { cwd: HOME, tool_name: "Bash", tool_input: { command: "ls", workdir: outside } })],
        ["cursor", tool("cursor", { workspace_roots: [outside], tool_name: "Shell", tool_input: { command: "ls" } })],
      ] as const;
      for (const [provider, payload] of away) {
        expect((await askedUp(provider, payload)).reply, provider).toEqual({});
        expect((await runHook(provider, payload, { path: missingSocket, status })).reply, provider).toEqual({});
      }
    });

    it("refuses one request whose targets are in two different workspaces", async () => {
      const s = await rig();
      const other = join(HOME, "code", "other");
      mkdirSync(other, { recursive: true });
      await s.policy.set(
        {
          ...s.policy.get(),
          workspaces: [...s.policy.get().workspaces, { label: "other", path: other }],
        },
        "local",
      );
      const reply = await s.bridge.handle(
        {
          provider: "codex",
          event: "tool",
          nativeSessionId: "two",
          cwd: WS,
          toolName: "Bash",
          input: { command: "ls", workdir: other },
        },
        signal(),
      );
      expect(reply).toMatchObject({ ok: false, reason: "ambiguous_path" });
      expect(s.store.pendingApprovals()).toHaveLength(0);
      await s.bridge.close();
    });
  });

  it("makes room by ending the oldest idle session, and refuses only when all 32 are busy", async () => {
    const s = await rig();
    const start = (id: string) =>
      s.bridge.handle({ provider: "claude", event: "start", nativeSessionId: id, cwd: WS }, signal());
    const first = await start("s0");
    for (let i = 1; i < 32; i++) await start(`s${i}`);
    const extra = await start("s32");
    expect(extra).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(s.store.sessions.get(first.sid!)).toMatchObject({ state: "completed", live: false }));

    const busy = await rig();
    const aborts = Array.from({ length: 32 }, () => new AbortController());
    const waiting = aborts.map((abort, i) =>
      busy.bridge.handle(
        {
          provider: "claude",
          event: "tool",
          nativeSessionId: `b${i}`,
          cwd: WS,
          toolName: "Bash",
          input: { command: "npm install left-pad" },
        },
        abort.signal,
      ),
    );
    await waitFor(() => busy.store.pendingApprovals().length === 32, 10_000);
    const refused = await busy.bridge.handle(
      { provider: "claude", event: "start", nativeSessionId: "b32", cwd: WS },
      signal(),
    );
    expect(refused).toEqual({ ok: false, reason: "session_limit" });
    expect(nativeHookOutput("claude", "PreToolUse", refused)).toMatchObject({
      hookSpecificOutput: {
        permissionDecisionReason: "Chalito is already following too many active sessions. Finish one, then try again.",
      },
    });
    for (const abort of aborts) abort.abort();
    await Promise.all(waiting);
    await s.bridge.close();
    await busy.bridge.close();
  });

  it("returns the decision while a store write hangs", async () => {
    const s = await rig();
    const ask = s.bridge.handle(
      {
        provider: "claude",
        event: "tool",
        nativeSessionId: "hung",
        cwd: WS,
        toolName: "Bash",
        input: { command: "npm install left-pad" },
      },
      signal(),
    );
    await waitFor(() => s.store.pendingApprovals().length === 1);
    const store = s.store as AgentStore;
    store.upsertSession = () => new Promise(() => undefined);
    store.writeEvent = () => new Promise(() => undefined);
    await s.answer(true);
    const reply = await Promise.race([ask, new Promise<"hung">((done) => setTimeout(() => done("hung"), 2000))]);
    expect(reply).toMatchObject({ ok: true, allow: true });
  });

  it("ends a session whose row was written but whose start event failed", async () => {
    const s = await rig();
    const store = s.store as AgentStore;
    const write = store.writeEvent.bind(store);
    store.writeEvent = async () => {
      throw new Error("db down");
    };
    await expect(
      s.bridge.handle({ provider: "codex", event: "start", nativeSessionId: "half", cwd: WS }, signal()),
    ).rejects.toThrow("db down");
    store.writeEvent = write;
    const rows = [...s.store.sessions.values()].filter((row) => row.control === "approvals");
    expect(rows).toHaveLength(1);
    await vi.waitFor(() => expect(rows[0]).toMatchObject({ state: "interrupted", live: false }));
  });

  it("tells a waiting tool call that its session ended", async () => {
    const s = await rig();
    const ask = s.bridge.handle(
      {
        provider: "claude",
        event: "tool",
        nativeSessionId: "ending",
        cwd: WS,
        toolName: "Bash",
        input: { command: "npm install left-pad" },
      },
      signal(),
    );
    await waitFor(() => s.store.pendingApprovals().length === 1);
    await s.bridge.handle({ provider: "claude", event: "end", nativeSessionId: "ending", cwd: WS }, signal());
    const reply = await ask;
    expect(reply).toMatchObject({ allow: false, reason: "session_ended" });
    expect(nativeHookOutput("claude", "PreToolUse", reply)).toMatchObject({
      hookSpecificOutput: {
        permissionDecisionReason: "This session ended in Chalito before the action was reviewed, so it was denied.",
      },
    });
    await s.bridge.close();
  });

  it("names an unreadable connector config apart from a disabled one", async () => {
    const s = await rig({ enabled: () => "unreadable" });
    const reply = await s.bridge.handle(
      { provider: "claude", event: "start", nativeSessionId: "u", cwd: WS },
      signal(),
    );
    expect(reply).toEqual({ ok: false, reason: "connector_unreadable" });
    expect(nativeHookOutput("claude", "PreToolUse", reply)).toMatchObject({
      hookSpecificOutput: {
        permissionDecisionReason:
          "Chalito can't read Claude Code settings, so it denied this action. Check the settings file in Chalito's Connected AI tab.",
      },
    });
    await s.bridge.close();
  });

  describe("hook stdin", () => {
    const big = (cwd: string) =>
      hookPayload("claude", {
        cwd,
        tool_name: "Write",
        tool_input: { file_path: join(cwd, "a.txt"), content: "x".repeat(1_200_000) },
      });

    it("passes an oversized (>1 MB) request outside workspaces and denies it inside as too large", async () => {
      writeNativeWorkspaces(down, nativeWorkspacePaths([{ path: WS }], HOME));
      expect((await runHook("claude", big(outside), { path: missingSocket, status })).reply).toEqual({});
      expect(decisionOf("claude", (await runHook("claude", big(WS), { path: missingSocket, status })).reply)).toEqual({
        decision: "deny",
        message: "This request is too large for Chalito to review, so it was denied.",
      });
      // An oversized request that edits a workspace file from outside it is still inside.
      const fromHome = hookPayload("claude", {
        cwd: HOME,
        tool_name: "Write",
        tool_input: { file_path: join(WS, "a.txt"), content: "x".repeat(1_200_000) },
      });
      expect(
        decisionOf("claude", (await runHook("claude", fromHome, { path: missingSocket, status })).reply).decision,
      ).toBe("deny");
    });

    it("keeps reading while chunks keep arriving, past one second in total", async () => {
      writeNativeWorkspaces(down, nativeWorkspacePaths([{ path: WS }], HOME));
      const payload = hookPayload("claude", { cwd: outside });
      const input = new PassThrough();
      const run = runHook("claude", payload, { path: missingSocket, status, input });
      const third = Math.ceil(payload.length / 3);
      for (let i = 0; i < 3; i++) {
        input.write(payload.slice(i * third, (i + 1) * third));
        await new Promise((done) => setTimeout(done, 600));
      }
      input.end();
      expect((await run).reply).toEqual({});
    });

    it("judges what was read when the writer stalls", async () => {
      writeNativeWorkspaces(down, nativeWorkspacePaths([{ path: WS }], HOME));
      for (const [cwd, expected] of [
        [outside, "pass"],
        [WS, "deny"],
      ] as const) {
        const payload = hookPayload("claude", { cwd });
        const input = new PassThrough();
        input.write(payload.slice(0, payload.indexOf('"tool_name"')));
        const { reply } = await runHook("claude", "", { path: missingSocket, status, input, idleMs: 200 });
        if (expected === "pass") expect(reply).toEqual({});
        else expect(decisionOf("claude", reply).decision).toBe("deny");
      }
    });
  });
});
