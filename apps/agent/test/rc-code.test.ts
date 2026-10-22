// ADR 0031 §1–2: sessions typed at the computer. `chalito code` runs against a real code.sock served
// by a real AgentCore (gate, approvals, sealing); the phone side signs real commands and decisions.
import { mkdtempSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough, duplexPair } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { openJson } from "@chalito/crypto";
import type { DeviceSetup } from "@chalito/protocol";
import { runCode } from "../src/code/cli.js";
import { codePath, startCodeServer, type CodeServer } from "../src/code/server.js";
import { onlyUserAndSystem, pipeLockedTo, pipeSddl, type WinPipeSecurity } from "../src/code/winpipe.js";
import { LinkTools } from "../src/links/index.js";
import { LOCAL_CLI_RECORD_MAX, pruneRecords } from "../src/session-registry.js";
import { codeService } from "../src/code/service.js";
import { ipcHandlers } from "../src/ipc-handlers.js";
import { WS, agentFor, waitFor } from "./rc-harness.js";

const SETUP: DeviceSetup = { adapters: ["claude-code"], workspaces: 1, labels: ["chalito"] };
const servers: CodeServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const rig = async (o: { maxLive?: number } = {}) => {
  const a = await agentFor(o);
  const code = codeService(
    a.core,
    () => a.policy.get(),
    () => SETUP,
    "local:cli",
  );
  const panel = codeService(
    a.core,
    () => a.policy.get(),
    () => SETUP,
    "local",
  );
  const path = join(mkdtempSync(join(tmpdir(), "chalito-code-")), "code.sock");
  servers.push(await startCodeServer({ path, code }));
  return { ...a, code, panel, path };
};

/** `chalito code` with a typed-in stdin and a captured terminal. */
const cli = (path: string, args: string[], o: { env?: Record<string, string>; cwd?: string } = {}) => {
  const input = new PassThrough();
  let out = "";
  let err = "";
  let sigint: (() => void) | null = null;
  const done = runCode(
    {
      input,
      out: (s) => void (out += s),
      err: (s) => void (err += s),
      env: o.env ?? {},
      cwd: o.cwd ?? WS,
      onSigint: (fn) => ((sigint = fn), () => (sigint = null)),
    },
    path,
    args,
    "es",
  );
  return {
    type: (l: string) => input.write(`${l}\n`),
    end: () => input.end(),
    out: () => out,
    err: () => err,
    ctrlC: () => sigint?.(),
    done,
  };
};

/** Raw client for the socket (another process of the same user). */
const raw = (path: string) => {
  const sock = connect(path);
  const lines: Record<string, unknown>[] = [];
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (c: string) => {
    buf += c;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      buf = buf.slice(nl + 1);
    }
  });
  let id = 0;
  return {
    lines,
    call: async (method: string, params?: unknown) => {
      const my = ++id;
      sock.write(`${JSON.stringify({ id: my, method, params })}\n`);
      await waitFor(() => lines.some((l) => l.id === my));
      return lines.find((l) => l.id === my)!;
    },
    send: (text: string) => void sock.write(text),
    close: () => sock.end(),
  };
};

describe("chalito code (ADR 0031 §1)", () => {
  it("starts a local:cli session in the folder's workspace, mirrored to the hub, and streams it here", async () => {
    const r = await rig();
    const c = cli(r.path, ["claude", "arregla", "el", "login"]);
    await waitFor(() => r.adapter.runs.length === 1);
    const run = r.adapter.runs[0]!;
    expect(run.opts.origin).toBe("local:cli");
    expect(run.opts.cwd).toBe(WS);
    expect(run.prompts[0]).toEqual({ text: "arregla el login", origin: "local:cli" });
    // Mirrored: the hub sees the session row and its sealed events, like any session.
    const sid = run.opts.sid;
    await waitFor(() => r.store.events.some((e) => e.sid === sid && e.type === "session.started"));
    expect(r.store.events.find((e) => e.type === "session.started")).toMatchObject({ origin: "local:cli" });

    run.emit({ type: "state", state: "running" });
    run.emit({ type: "assistant_delta", text: "Lo " });
    run.emit({ type: "assistant_delta", text: "reviso." });
    run.emit({ type: "assistant_text", text: "Lo reviso." });
    run.emit({ type: "state", state: "idle" });
    await waitFor(() => c.out().includes("Lo reviso."));
    const stored = r.store.events.find((e) => e.sid === sid && e.type === "message.assistant") as unknown as {
      ct: never;
    };
    expect(await openJson(stored.ct, r.phone.id, r.phone.box, `event:${sid}`)).toEqual({ text: "Lo reviso." });

    c.type("ahora corre las pruebas");
    await waitFor(() => run.prompts.length === 2);
    expect(run.prompts[1]).toEqual({ text: "ahora corre las pruebas", origin: "local:cli" });
    // Its own prompts aren't echoed back as someone else's (security review).
    expect(c.out()).not.toContain("ahora corre las pruebas");
    await r.panel.prompt(sid, "desde el panel");
    await waitFor(() => c.out().includes("[panel de esta computadora] desde el panel"));
    c.type("/salir");
    expect(await c.done).toBe(0);
    expect(c.out()).toContain("La sesión sigue en tu teléfono.");
  });

  it("strips terminal escape sequences and control characters from everything the session sends (security review)", async () => {
    const r = await rig();
    const c = cli(r.path, ["claude", "x"]);
    await waitFor(() => r.adapter.runs.length === 1);
    const run = r.adapter.runs[0]!;
    run.emit({ type: "assistant_delta", text: "\u001b]0;pwned\u0007ho" });
    run.emit({ type: "assistant_delta", text: "la\u001b[2J\u009b31m\r\n\tfin" });
    run.emit({ type: "assistant_text", text: "hola" });
    run.emit({
      type: "tool_started",
      toolUseId: "t1",
      toolName: "Read\u001b[8m",
      input: { file_path: `${WS}/\u001b[31ma.ts` },
    });
    run.emit({ type: "state", state: "idle" });
    await waitFor(() => c.out().includes("fin"));
    await waitFor(() => c.out().includes("a.ts"));
    expect(c.out()).toContain("hola\n\tfin");
    // eslint-disable-next-line no-control-regex -- asserting none reached the terminal
    expect(c.out()).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    c.type("/salir");
    await c.done;
  });

  it("shows what the session says before its id is known, only to the connection that started it", async () => {
    const r = await rig();
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    const other = raw(r.path);
    await other.call("sessions");
    r.adapter.onStart = (run) => {
      run.emit({ type: "state", state: "running" });
      run.emit({ type: "assistant_delta", text: "temprano" });
    };
    const c = cli(r.path, ["claude", "hola"]);
    await waitFor(() => c.out().includes("temprano"));
    expect(other.lines.some((l) => "event" in l)).toBe(false);
    other.close();
    c.type("/salir");
    await c.done;
  });

  it("says so and exits non-zero when the agent goes away", async () => {
    const r = await rig();
    const c = cli(r.path, ["claude", "hola"]);
    await waitFor(() => c.out().includes("Sesión "));
    await servers.splice(0)[0]!.close();
    expect(await c.done).toBe(1);
    expect(c.err()).toContain("Se perdió la conexión");
  });

  it("a burst of small requests isn't cut off by the line limit", async () => {
    const r = await rig();
    const s = raw(r.path);
    const many = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ id: 10_000 + i, method: "sessions" }));
    expect(many.join("\n").length).toBeGreaterThan(64 * 1024);
    s.send(`${many.join("\n")}\n`);
    await waitFor(() => s.lines.filter((l) => typeof l.id === "number" && (l.id as number) >= 10_000).length === 2000);
    s.close();
  });

  it("shows the phone's prompts here, and the phone can stop a session started here", async () => {
    const r = await rig();
    const c = cli(r.path, ["claude", "hola"]);
    await waitFor(() => r.adapter.runs.length === 1);
    const run = r.adapter.runs[0]!;
    const sid = run.opts.sid;
    run.emit({ type: "state", state: "idle" });
    const sent = await r.command(async (seal) => ({
      type: "session.prompt",
      sid,
      promptCt: await seal("desde el tel"),
    }));
    expect(sent).toMatchObject({ ok: true });
    await waitFor(() => c.out().includes("[teléfono] desde el tel"));
    expect(run.prompts.at(-1)!.origin).toBe(`client:${r.phone.id}`);
    expect((await r.command({ type: "session.interrupt", sid })).ok).toBe(true);
    expect(run.interrupts).toBe(1);
    await waitFor(() => c.out().includes("[detenido]"));
    c.end();
    expect(await c.done).toBe(0);
  });

  it("answers no approval, not even for its own session: the panel or phone does (security review)", async () => {
    const r = await rig();
    const c = cli(r.path, ["claude", "instala"]);
    await waitFor(() => r.adapter.runs.length === 1);
    const sid = r.adapter.runs[0]!.opts.sid;
    const med = r.adapter.tool(sid, "Bash", { command: "npm install left-pad" });
    await waitFor(() => c.out().includes("Apruébala en el panel de Chalito o en tu teléfono"));
    // The session's own process holds this connection's rights and still can't answer.
    const self = raw(r.path);
    expect(await self.call("decide", { sid, aid: r.store.pendingApprovals()[0]!.aid, allow: true })).toMatchObject({
      ok: false,
      error: "unknown_method",
    });
    c.type("s");
    await new Promise((res) => setTimeout(res, 30));
    expect(r.store.pendingApprovals()).toHaveLength(1);
    await r.answer(true);
    expect(await med).toMatchObject({ allow: true });
    await waitFor(() => c.out().includes("aprobado"));
    self.close();
    c.type("/salir");
    await c.done;
  });

  it("is unsigned: no acceptEdits, no Developer mode, and no LOW auto-allow beyond reads (no laundering)", async () => {
    const r = await rig();
    const s = raw(r.path);
    // An unsigned start can't ask for acceptEdits at all (it would carry over to signed turns).
    expect(
      await s.call("start", {
        appId: "claude-code",
        workspaceLabel: "chalito",
        prompt: "x",
        permissionMode: "acceptEdits",
      }),
    ).toMatchObject({ ok: false, error: "permission_mode_above_ceiling" });
    const started = (await s.call("start", {
      appId: "claude-code",
      workspaceLabel: "chalito",
      prompt: "x",
      permissionMode: "default",
    })) as { result: { sid: string } };
    const sid = started.result.sid;
    // A workspace edit: the panel's (signed, acceptEdits) session takes it, the terminal's asks.
    const edit = r.adapter.tool(sid, "Write", { file_path: `${WS}/a.txt`, content: "x" });
    await waitFor(() => r.store.pendingApprovals().length === 1);
    await r.answer(false);
    expect(await edit).toMatchObject({ allow: false });
    const panel = (await r.panel.start({
      appId: "claude-code",
      workspaceLabel: "chalito",
      prompt: "y",
      permissionMode: "acceptEdits",
    })) as { sid: string };
    expect(await r.adapter.tool(panel.sid, "Write", { file_path: `${WS}/b.txt`, content: "x" })).toMatchObject({
      allow: true,
    });
    s.close();
  });

  it("a deny on the phone denies the tool and shows here", async () => {
    const r = await rig();
    const c = cli(r.path, ["claude", "x"]);
    await waitFor(() => r.adapter.runs.length === 1);
    const sid = r.adapter.runs[0]!.opts.sid;
    const med = r.adapter.tool(sid, "Write", { file_path: `${WS}/a.txt`, content: "x" });
    await waitFor(() => r.store.pendingApprovals().length === 1);
    await r.answer(false);
    expect(await med).toMatchObject({ allow: false });
    await waitFor(() => c.out().includes("rechazado (signed_deny)"));
    c.type("/salir");
    await c.done;
  });

  it("another connection sees nothing of it and can't prompt, stop or answer for it", async () => {
    const r = await rig();
    const c = cli(r.path, ["claude", "mío"]);
    await waitFor(() => r.adapter.runs.length === 1);
    const sid = r.adapter.runs[0]!.opts.sid;
    const other = raw(r.path);
    expect(await other.call("prompt", { sid, text: "rm -rf" })).toMatchObject({ ok: false, error: "not_yours" });
    expect(await other.call("stop", { sid })).toMatchObject({ ok: false, error: "not_yours" });
    const med = r.adapter.tool(sid, "Bash", { command: "npm install left-pad" });
    await waitFor(() => r.store.pendingApprovals().length === 1);
    const aid = r.store.pendingApprovals()[0]!.aid;
    expect(await other.call("decide", { sid, aid, allow: true })).toMatchObject({ ok: false, error: "unknown_method" });
    expect(other.lines.some((l) => "event" in l)).toBe(false);
    expect(await other.call("sessions")).toMatchObject({ ok: true, result: { sids: [] } });
    expect(r.adapter.runs[0]!.interrupts).toBe(0);
    await r.answer(false);
    await med;
    other.close();
    c.type("/salir");
    await c.done;
  });

  it("goes through the same checks as a phone start", async () => {
    const r = await rig();
    const s = raw(r.path);
    const start = (o: Record<string, unknown>) =>
      s.call("start", { appId: "claude-code", workspaceLabel: "chalito", prompt: "x", ...o });
    expect(await start({ workspaceLabel: "otro" })).toMatchObject({ ok: false, error: "unknown_workspace" });
    expect(await start({ permissionMode: "bypassPermissions" })).toMatchObject({ ok: false, error: "bad_params" });
    r.setPolicy({ ...r.policy.get(), remote: { ...r.policy.get().remote, maxPermissionMode: "default" } });
    expect(await start({ permissionMode: "acceptEdits" })).toMatchObject({
      ok: false,
      error: "permission_mode_above_ceiling",
    });
    r.setPolicy({ ...r.policy.get(), origins: { ...r.policy.get().origins, local: false } });
    expect(await start({})).toMatchObject({ ok: false, error: "origin_disabled" });
    expect(r.adapter.runs).toHaveLength(0);
    s.close();
  });

  it("Ctrl-C stops the turn; a second Ctrl-C leaves and the session keeps going", async () => {
    const r = await rig();
    const c = cli(r.path, ["claude", "largo"]);
    await waitFor(() => r.adapter.runs.length === 1);
    const run = r.adapter.runs[0]!;
    run.emit({ type: "state", state: "running" });
    await waitFor(() => c.out().includes("Sesión "));
    c.ctrlC();
    await waitFor(() => run.interrupts === 1);
    c.ctrlC();
    expect(await c.done).toBe(0);
    expect(r.core.sessions.has(run.opts.sid)).toBe(true);
  });

  it("refuses inside a session, without the agent, on Windows, and outside the owner's folders", async () => {
    const r = await rig();
    let winErr = "";
    const inSession = cli(r.path, ["claude", "x"], { env: { CHALITO_SESSION: "s1" } });
    expect(await inSession.done).toBe(1);
    expect(inSession.err()).toContain("dentro de una sesión");
    const noAgent = cli(join(tmpdir(), "nope", "code.sock"), ["claude", "x"]);
    expect(await noAgent.done).toBe(1);
    expect(noAgent.err()).toContain("no está corriendo");
    const elsewhere = cli(r.path, ["claude", "x"], { cwd: "/tmp" });
    expect(await elsewhere.done).toBe(1);
    expect(elsewhere.err()).toContain("--workspace");
    // Named by the user's SID (a renamed or look-alike account name can't collide); no SID, no pipe.
    expect(codePath("C:\\x", "win32", "S-1-5-21-1-2-3-1001")).toBe("\\\\.\\pipe\\chalito-code-S-1-5-21-1-2-3-1001");
    expect(codePath("C:\\x", "win32")).toBeNull();
    expect(codePath("C:\\x", "win32", "Ana María")).toBeNull();
    const onWindows = runCode(
      { input: new PassThrough(), out: () => undefined, err: (e) => void (winErr += e), env: {}, cwd: WS },
      null,
      ["claude", "x"],
      "es",
    );
    expect(await onWindows).toBe(1);
    expect(winErr).toContain("desde el panel");
    const unknown = cli(r.path, ["copilot", "x"]);
    expect(await unknown.done).toBe(1);
    expect(unknown.err()).toContain("claude-code");
    expect(r.adapter.runs).toHaveLength(0);
  });

  it("reads piped input, waits for the turn and leaves", async () => {
    const r = await rig();
    const c = cli(r.path, ["claude", "--workspace", "chalito"]);
    c.type("resume el repo");
    c.end();
    await waitFor(() => r.adapter.runs.length === 1);
    const run = r.adapter.runs[0]!;
    run.emit({ type: "state", state: "running" });
    run.emit({ type: "assistant_text", text: "Es un monorepo." });
    run.emit({ type: "state", state: "idle" });
    expect(await c.done).toBe(0);
    expect(c.out()).toContain("Es un monorepo.");
  });
});

describe("the panel's Nueva sesión over its IPC (ADR 0031 §1)", () => {
  it("starts, prompts and stops a local-origin session", async () => {
    const r = await rig();
    const h = ipcHandlers({ code: r.panel } as never);
    expect(await h.codeApps!({})).toEqual({ apps: ["claude-code"], workspaces: ["chalito"] });
    const { sid } = (await h.codeStart!({ appId: "claude-code", workspaceLabel: "chalito", prompt: "hola" })) as {
      sid: string;
    };
    const run = r.adapter.run(sid);
    expect(run.opts.origin).toBe("local");
    run.emit({ type: "state", state: "idle" });
    await h.codePrompt!({ sid, text: "sigue" });
    expect(run.prompts.at(-1)).toEqual({ text: "sigue", origin: "local" });
    await h.codeStop!({ sid });
    expect(run.interrupts).toBe(1);
    await expect(h.codeStart!({ appId: "claude-code", workspaceLabel: "nope", prompt: "x" })).rejects.toMatchObject({
      code: "unknown_workspace",
    });
    await expect(h.codePrompt!({ sid: "nope", text: "x" })).rejects.toMatchObject({ code: "unknown_session" });
  });
});

describe("chalito code from the command line", () => {
  it("is routed before any secret is opened, with its own flags intact", async () => {
    const { main } = await import("../src/cli.js");
    let err = "";
    const io = {
      out: () => undefined,
      err: (s: string) => void (err += s),
      tty: { input: new PassThrough(), output: new PassThrough() },
      env: { CHALITO_SESSION: "s1" },
      home: mkdtempSync(join(tmpdir(), "chalito-home-")),
      platform: "linux",
      secrets: {
        get: async () => {
          throw new Error("secrets opened");
        },
      },
    } as never;
    expect(await main(["code", "claude", "--workspace", "chalito", "hola"], io)).toBe(1);
    expect(err).toContain("dentro de una sesión");
  });
});

describe("link tools (ADR 0031 §6a)", () => {
  it("are never attached to a terminal-started session", () => {
    const tools = new LinkTools({
      links: { senderLinks: () => [{ id: "l1" }] } as never,
      mcpLaunch: () => ({ command: "chalito", args: ["link", "mcp"], socket: "/tmp/x.sock" }),
      audit: () => undefined,
      now: Date.now,
    });
    expect(tools.attach("s1", "local:cli")).toBeNull();
    expect(tools.attach("s2", "local")).not.toBeNull();
  });
});

describe("code.sock limits (review)", () => {
  const start = (s: ReturnType<typeof raw>, prompt = "x") =>
    s.call("start", { appId: "claude-code", workspaceLabel: "chalito", prompt });

  it("terminal sessions have their own cap and never evict the owner's other sessions", async () => {
    const r = await rig({ maxLive: 3 });
    const phone = await r.command(async (seal) => ({
      type: "session.start",
      appId: "claude-code",
      workspaceLabel: "chalito",
      permissionMode: "default",
      promptCt: await seal("del teléfono"),
    }));
    expect(phone).toMatchObject({ ok: true });
    r.adapter.run(phone.sid!).emit({ type: "state", state: "idle" });
    const s1 = (await start(raw(r.path))) as { result: { sid: string } };
    const s2 = (await start(raw(r.path))) as { result: { sid: string } };
    r.adapter.run(s1.result.sid).emit({ type: "state", state: "running" });
    r.adapter.run(s2.result.sid).emit({ type: "state", state: "running" });
    // Both terminal sessions busy and the device full: refused; the phone's idle session untouched.
    expect(await start(raw(r.path))).toMatchObject({ ok: false, error: "session_limit" });
    expect(r.core.sessions.has(phone.sid!)).toBe(true);
    // One terminal session idle: a third evicts it, still not the phone's.
    r.adapter.run(s1.result.sid).emit({ type: "state", state: "idle" });
    expect(await start(raw(r.path))).toMatchObject({ ok: true });
    expect(r.core.sessions.has(s1.result.sid)).toBe(false);
    expect(r.core.sessions.has(phone.sid!)).toBe(true);
  });

  it("limits starts per connection and per minute", async () => {
    const r = await rig({ maxLive: 20 });
    const c = raw(r.path);
    for (let i = 0; i < 3; i++) {
      expect(await start(c)).toMatchObject({ ok: true });
      r.adapter.runs.at(-1)!.emit({ type: "state", state: "idle" });
    }
    expect(await start(c)).toMatchObject({ ok: false, error: "rate_limited" });
    const d = raw(r.path);
    for (let i = 0; i < 3; i++) await start(d);
    expect(await start(raw(r.path))).toMatchObject({ ok: false, error: "rate_limited" });
  });

  it("buffers a bounded number of early events, and drops a reader that stops reading", async () => {
    const r = await rig();
    r.adapter.onStart = (run) => {
      for (let i = 0; i < 700; i++) run.emit({ type: "assistant_delta", text: `p${i} ` });
    };
    const s = raw(r.path);
    await start(s);
    await new Promise((res) => setTimeout(res, 30));
    expect(s.lines.filter((l) => "event" in l).length).toBeLessThanOrEqual(500);
    r.adapter.onStart = undefined;
    const stuck = connect(r.path);
    await new Promise((res) => stuck.once("connect", res));
    stuck.pause();
    stuck.write(
      `${JSON.stringify({ id: 1, method: "start", params: { appId: "claude-code", workspaceLabel: "chalito", prompt: "y" } })}\n`,
    );
    await waitFor(() => r.adapter.runs.length === 2);
    const run = r.adapter.runs[1]!;
    let closed = false;
    stuck.on("close", () => (closed = true));
    for (let i = 0; i < 200 && !closed; i++) {
      run.emit({ type: "assistant_delta", text: "x".repeat(60_000) });
      await new Promise((res) => setTimeout(res, 2));
    }
    stuck.resume();
    await waitFor(() => closed, 5000);
  });

  it("the hub gets the first prompt of a session started here, sealed, with its origin", async () => {
    const r = await rig();
    const s = raw(r.path);
    const { result } = (await start(s, "arregla el login")) as { result: { sid: string } };
    const first = r.store.events.find((e) => e.sid === result.sid && e.type === "message.user") as unknown as {
      origin: string;
      ct: never;
    };
    expect(first.origin).toBe("local:cli");
    expect(await openJson(first.ct, r.phone.id, r.phone.box, `event:${result.sid}`)).toEqual({
      text: "arregla el login",
    });
  });

  it("writes the owner's audit trail for commands typed here, with their origin", async () => {
    const r = await rig();
    const s = raw(r.path);
    await start(s);
    await s.call("start", { appId: "claude-code", workspaceLabel: "otro", prompt: "x" });
    await waitFor(() => r.store.audits.filter((a) => a.type.startsWith("command.")).length >= 2);
    const rows = r.store.audits.filter((a) => a.type.startsWith("command.")).map((a) => [a.type, a.meta]);
    expect(rows[0]).toEqual([
      "command.accepted",
      expect.objectContaining({ origin: "local:cli", command: "session.start" }),
    ]);
    expect(rows[1]).toEqual([
      "command.rejected",
      expect.objectContaining({ origin: "local:cli", reason: "unknown_workspace" }),
    ]);
  });

  it("tells the terminal when the AI asks a question, and piped input doesn't hang on it", async () => {
    const r = await rig();
    const c = cli(r.path, ["claude", "--workspace", "chalito"]);
    c.type("pregúntame algo");
    c.end();
    await waitFor(() => r.adapter.runs.length === 1);
    r.adapter.runs[0]!.emit({ type: "state", state: "running" });
    r.adapter.runs[0]!.emit({ type: "state", state: "waiting_input" });
    expect(await c.done).toBe(0);
    expect(c.out()).toContain("Contéstala en el panel o en tu teléfono");
  });
});

describe("sessions.json (review)", () => {
  it("terminal-started records never push the owner's other sessions out", () => {
    const now = 1_000_000_000;
    const rec = (i: number, startedBy: string) => ({
      sid: `s${i}`,
      adapter: "claude-code" as const,
      workspaceLabel: "w",
      label: "w",
      permissionMode: "default" as const,
      startedBy,
      seq: 0,
      state: "idle" as const,
      lastActiveAt: now - i,
      live: false,
    });
    const cli = Array.from({ length: 300 }, (_, i) => rec(i, "local:cli"));
    const own = Array.from({ length: 190 }, (_, i) => rec(1000 + i, "client:phone"));
    const kept = pruneRecords([...cli, ...own], now);
    expect(kept.filter((r) => r.startedBy === "client:phone")).toHaveLength(190);
    expect(kept.filter((r) => r.startedBy === "local:cli")).toHaveLength(10);
    expect(pruneRecords(cli, now)).toHaveLength(LOCAL_CLI_RECORD_MAX);
  });
});

describe("chalito code on Windows (owner 2026-10-22)", () => {
  const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

  it("accepts only a protected DACL for this user and SYSTEM", () => {
    expect(pipeSddl(SID)).toBe(`O:${SID}D:P(D;;GA;;;NU)(A;;GA;;;${SID})(A;;GA;;;SY)`);
    const ok = `D:P(D;;FA;;;NU)(A;;FA;;;${SID})(A;;FA;;;SY)`;
    expect(onlyUserAndSystem(ok, SID)).toBe(true);
    // Network logons must be denied explicitly (SMB from another machine as the same account).
    expect(onlyUserAndSystem(`D:P(A;;FA;;;${SID})(A;;FA;;;SY)`, SID)).toBe(false);
    // Not protected, Everyone, Administrators, another user, or no allow at all: refused.
    expect(onlyUserAndSystem(`D:(D;;FA;;;NU)(A;;FA;;;${SID})`, SID)).toBe(false);
    expect(onlyUserAndSystem(`D:P(D;;FA;;;NU)(A;;FA;;;${SID})(A;;FR;;;WD)`, SID)).toBe(false);
    expect(onlyUserAndSystem(`D:P(D;;FA;;;NU)(A;;FA;;;${SID})(A;;FA;;;BA)`, SID)).toBe(false);
    expect(onlyUserAndSystem(`D:P(D;;FA;;;NU)(A;;FA;;;S-1-5-21-9-9-9-1002)`, SID)).toBe(false);
    expect(onlyUserAndSystem("D:P(D;;FA;;;NU)", SID)).toBe(false);
    // The built-in Administrator account reads back as its alias.
    expect(onlyUserAndSystem("D:P(D;;FA;;;NU)(A;;FA;;;LA)(A;;FA;;;SY)", "S-1-5-21-1-2-3-500", "LA")).toBe(true);
    expect(onlyUserAndSystem("D:P(D;;FA;;;NU)(A;;FA;;;LA)(A;;FA;;;SY)", "S-1-5-21-1-2-3-500")).toBe(false);
    // The owner counts too: this user (or its alias), never someone else, never missing.
    expect(pipeLockedTo(`O:${SID}${ok}`, SID)).toBe(true);
    expect(pipeLockedTo("O:LAD:P(D;;FA;;;NU)(A;;FA;;;LA)(A;;FA;;;SY)", "S-1-5-21-1-2-3-500", "LA")).toBe(true);
    expect(pipeLockedTo(`O:BA${ok}`, SID)).toBe(false);
    expect(pipeLockedTo(`O:SY${ok}`, SID)).toBe(false);
    expect(pipeLockedTo(ok, SID)).toBe(false);
  });

  it("serves nothing when the pipe can't be created locked (squatted name, refused DACL)", async () => {
    const r = await rig();
    const path = "\\\\.\\pipe\\chalito-code-test";
    await expect(
      startCodeServer({
        path,
        code: r.code,
        listen: () => {
          throw new Error("pipe_create_failed_5");
        },
      }),
    ).rejects.toThrow("pipe_create_failed_5");
  });

  it("serves through the Windows listener: same rules, every stream it hands over", async () => {
    const r = await rig();
    let hand: ((s: Duplex) => void) | null = null;
    let closed = false;
    const server = await startCodeServer({
      path: "\\\\.\\pipe\\chalito-code-test",
      code: r.code,
      listen: (_p, on) => ((hand = on), { close: () => void (closed = true), sddl: "" }),
    });
    const [a, b] = duplexPair();
    hand!(a);
    let got = "";
    b.setEncoding("utf8");
    b.on("data", (c: string) => void (got += c));
    b.write(`${JSON.stringify({ id: 1, method: "apps" })}\n`);
    await waitFor(() => got.includes('"id":1'));
    expect(JSON.parse(got.split("\n")[0]!)).toMatchObject({ ok: true, result: { apps: ["claude-code"] } });
    b.write(`${JSON.stringify({ id: 2, method: "decide", params: {} })}\n`);
    await waitFor(() => got.includes('"id":2'));
    expect(got).toContain("unknown_method");
    await server.close();
    expect(closed).toBe(true);
  });

  it("the CLI sends nothing to a pipe another user serves", async () => {
    const r = await rig();
    const seen: string[] = [];
    const tapped = r.code.tap((_sid, e) => void seen.push(e.type));
    let err = "";
    const code = await runCode(
      {
        input: new PassThrough(),
        out: () => undefined,
        err: (e) => void (err += e),
        env: {},
        cwd: WS,
        openPipe: () => ({ ok: false, reason: "not_mine" }),
      },
      r.path,
      ["claude", "borra todo"],
      "es",
    );
    tapped();
    expect(code).toBe(1);
    expect(err).toContain("no es tu Chalito");
    expect(r.adapter.runs).toHaveLength(0);
  });

  it("a write that fails after the agent closed is a disconnect, not a crash", async () => {
    const r = await rig();
    let answered = 0;
    // Answers the CLI's setup like the agent, then the agent is gone: the next write fails.
    const stream = new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        const req = JSON.parse(chunk.toString()) as { id: number; method: string };
        if (answered++ >= 3) return cb(new Error("EPIPE"));
        const result =
          req.method === "apps"
            ? { apps: ["claude-code"], workspaces: ["chalito"] }
            : req.method === "workspaceFor"
              ? { label: "chalito" }
              : { sid: "s1" };
        setImmediate(() => this.push(`${JSON.stringify({ id: req.id, ok: true, result })}\n`));
        cb();
      },
    });
    const input = new PassThrough();
    let err = "";
    const done = runCode(
      {
        input,
        out: () => undefined,
        err: (x) => void (err += x),
        env: {},
        cwd: WS,
        openPipe: () => ({ ok: true, stream }),
      },
      r.path,
      ["claude", "hola"],
      "es",
    );
    await waitFor(() => answered === 3);
    input.write("otra cosa\n");
    expect(await done).toBe(1);
    expect(err).toContain("Se perdió la conexión");
  });

  it("the CLI runs all its traffic over the one connection it checked", async () => {
    const r = await rig();
    let opened = 0;
    const input = new PassThrough();
    let out = "";
    const done = runCode(
      {
        input,
        out: (x) => void (out += x),
        err: () => undefined,
        env: {},
        cwd: WS,
        openPipe: () => (opened++, { ok: true, stream: connect(r.path) }),
        connect: () => {
          throw new Error("a second connection was opened");
        },
      },
      r.path,
      ["claude", "hola"],
      "es",
    );
    await waitFor(() => r.adapter.runs.length === 1);
    r.adapter.runs[0]!.emit({ type: "assistant_text", text: "por el mismo tubo" });
    await waitFor(() => out.includes("por el mismo tubo"));
    input.write("/salir\n");
    expect(await done).toBe(0);
    expect(opened).toBe(1);
  });

  it("on Windows the command line checks who serves the pipe, and without that check says to use the panel", async () => {
    const { main } = await import("../src/cli.js");
    const home = mkdtempSync(join(tmpdir(), "chalito-home-"));
    const io = (winPipeSecurity: () => Promise<WinPipeSecurity | null>, sink: { err: string }) =>
      ({
        out: () => undefined,
        err: (s: string) => void (sink.err += s),
        tty: { input: new PassThrough(), output: new PassThrough() },
        env: {},
        home,
        platform: "win32",
        winPipeSecurity,
      }) as never;
    const none = { err: "" };
    expect(
      await main(
        ["code", "claude", "hola"],
        io(async () => null, none),
      ),
    ).toBe(1);
    expect(none.err).toContain("Chalito instalado");
    const other = { err: "" };
    const sec: WinPipeSecurity = {
      userSid: SID,
      listen: () => {
        throw new Error("not in this test");
      },
      connect: () => ({ ok: false, reason: "not_mine" }),
    };
    expect(
      await main(
        ["code", "claude", "hola"],
        io(async () => sec, other),
      ),
    ).toBe(1);
    expect(other.err).toContain("no es tu Chalito");
  });
});
