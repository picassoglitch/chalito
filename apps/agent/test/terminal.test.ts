import { describe, expect, it } from "vitest";
import { CommandPayload, type AgentEvent, type Origin, type SealedEnvelope } from "@chalito/protocol";
import { driverFactory, registerDriver } from "../src/drivers/registry.js";
import { applyRemoteTighten, DEFAULT_POLICY, isTighterOrEqual, type Policy } from "../src/policy/index.js";
import { TerminalControl, type TerminalApprovalOutcome, type TerminalDeps } from "../src/terminal/control.js";
import { rawShellLaunch, resolveProgram, terminalDriverFactory, type TerminalLaunch } from "../src/terminal/driver.js";
import { OutputStream, TokenBucket } from "../src/terminal/output.js";
import {
  PtyUnavailableError,
  bunBackend,
  loadPtyBackend,
  type PtyBackend,
  type PtySpawnOptions,
} from "../src/terminal/pty.js";
import {
  RAW_SHELL_COPY,
  TERMINAL_COPY,
  disableRawShell,
  disableRemoteTerminal,
  enableRawShell,
  enableRemoteTerminal,
  type TerminalPrompter,
} from "../src/terminal/toggle.js";

// ---- fakes ---------------------------------------------------------------------------

interface Spawned {
  file: string;
  args: string[];
  o: PtySpawnOptions;
  writes: string[];
  resizes: [number, number][];
  kills: (string | undefined)[];
  paused: number;
  resumed: number;
}

/** A PTY that echoes what's typed; `exit` ends the program. */
const fakePty = () => {
  const spawned: Spawned[] = [];
  const backend: PtyBackend = {
    name: "fake",
    spawn: (file, args, o) => {
      const rec: Spawned = { file, args, o, writes: [], resizes: [], kills: [], paused: 0, resumed: 0 };
      spawned.push(rec);
      return {
        pid: 4242,
        write: (d) => {
          rec.writes.push(d);
          o.onData(`echo:${d}`);
        },
        resize: (c, r) => void rec.resizes.push([c, r]),
        kill: (s) => void rec.kills.push(s),
        pause: () => void rec.paused++,
        resume: () => void rec.resumed++,
      };
    },
  };
  return { backend, spawned };
};

const APPS: Record<string, TerminalLaunch> = {
  aider: { appId: "aider", name: "Aider", command: ["aider", "--no-auto-commits"], rawShell: false },
};

const ON: NonNullable<Policy["remoteTerminal"]> = {
  enabled: true,
  rawShell: false,
  maxSessions: 2,
  maxInputPerMinute: 1000,
};

/** Every sealed value, by its fake ciphertext, so the tests can open what the agent sealed. */
const sealedBox = () => {
  const opened = new Map<string, { value: unknown; aad: string }>();
  let n = 0;
  const seal = async (value: unknown, aad: string): Promise<SealedEnvelope> => {
    const ct = `ct${++n}`;
    opened.set(ct, { value, aad });
    return { alg: "xchacha20poly1305+sealedbox", nonce: "A".repeat(32), ct, keys: { dev_phone: "A".repeat(107) } };
  };
  return { seal, open: (e: SealedEnvelope) => opened.get(e.ct)! };
};

const setup = (o: { policy?: Policy["remoteTerminal"]; approve?: () => Promise<TerminalApprovalOutcome> } = {}) => {
  let policy: Policy["remoteTerminal"] = "policy" in o ? o.policy : ON;
  let t = 1_790_000_000_000;
  const audits: { type: string; meta: Record<string, unknown> }[] = [];
  const events: AgentEvent[] = [];
  const sessions = new Map<string, Record<string, unknown>>();
  const published: unknown[] = [];
  const asked: { tid: string; input: unknown }[] = [];
  const timers: { fn: () => void; at: number; cleared: boolean }[] = [];
  const { backend, spawned } = fakePty();
  const box = sealedBox();
  let release: ((o: TerminalApprovalOutcome) => void) | null = null;
  let ids = 0;
  const deps: TerminalDeps = {
    deviceId: "dev_agent",
    policy: () => policy,
    workspaces: () => [{ label: "chalito", path: "/home/aldo/code/chalito" }],
    launch: (appId) => APPS[appId] ?? null,
    rawShell: () => rawShellLaunch({ SHELL: "/bin/zsh" }, "linux"),
    pty: () => backend,
    resolve: (p) => (p.startsWith("/") ? p : `/usr/bin/${p}`),
    env: () => ({ PATH: "/usr/bin", HOME: "/home/aldo", CHALITO_IPC_SECRET: "s3cret", SUPABASE_KEY: "k", LANG: "es" }),
    requestApproval: async (tid, input, onRequested) => {
      asked.push({ tid, input });
      onRequested("apr_1", t + 600_000);
      if (o.approve) return o.approve();
      return new Promise((r) => (release = r));
    },
    seal: box.seal,
    writeEvent: async (e) => void events.push(e),
    upsertSession: async (tid, data) => void sessions.set(tid, { ...sessions.get(tid), ...data }),
    audit: (type, meta) => void audits.push({ type, meta }),
    publish: (s) => void published.push(s),
    now: () => t,
    // Time only moves when the code waits.
    sleep: async (ms) => {
      t += ms;
      await Promise.resolve();
    },
    setTimer: (fn, ms) => {
      const timer = { fn, at: t + ms, cleared: false };
      timers.push(timer);
      return { clear: () => void (timer.cleared = true) };
    },
    newId: () => `term_${++ids}`,
  };
  const c = new TerminalControl(deps);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    c,
    deps,
    spawned,
    audits,
    events,
    sessions,
    published,
    asked,
    box,
    setPolicy: (p: Policy["remoteTerminal"]) => (policy = p),
    advance: (ms: number) => (t += ms),
    settle,
    allow: async (allow = true) => {
      release?.({ allow, reason: allow ? "signed_allow" : "signed_deny", byDeviceId: "dev_phone" });
      await settle();
      await settle();
    },
    /** Runs every due timer (output flushes, kill escalation). */
    flush: async (ms = 50) => {
      t += ms;
      for (const x of timers.splice(0)) if (!x.cleared && x.at <= t) x.fn();
      await settle();
      await settle();
    },
    output: () =>
      events.filter((e) => e.type === "terminal.output").map((e) => box.open((e as { dataCt: SealedEnvelope }).dataCt)),
    types: () => events.map((e) => e.type),
  };
};

const PHONE: Origin = "client:dev_phone";

/** Opened, approved and running. */
const running = async (h: ReturnType<typeof setup>, appId = "aider") => {
  h.c.heartbeat(true);
  const r = await h.c.open({ appId, workspaceLabel: "chalito", cols: 100, rows: 30 }, PHONE);
  expect(r).toMatchObject({ ok: true });
  await h.settle();
  await h.allow();
  return (r as { tid: string }).tid;
};

// ---- the gate ---------------------------------------------------------------------------

describe("remote terminal: who may open one", () => {
  it("is off by default: nothing opens, nothing runs", async () => {
    const h = setup({ policy: undefined });
    h.c.heartbeat(true);
    expect(await h.c.open({ appId: "aider", workspaceLabel: "chalito", cols: 80, rows: 24 }, PHONE)).toEqual({
      ok: false,
      reason: "terminal_disabled",
    });
    expect(h.asked).toHaveLength(0);
    expect(h.spawned).toHaveLength(0);
    expect(h.audits.map((a) => a.type)).toEqual(["terminal.refused"]);
  });

  it("only signed, trusted clients: never mcp:/call: origins (or local)", async () => {
    const h = setup();
    h.c.heartbeat(true);
    for (const origin of ["mcp:claude", "call:CAxyz", "local"] as Origin[])
      expect(await h.c.open({ appId: "aider", workspaceLabel: "chalito", cols: 80, rows: 24 }, origin)).toEqual({
        ok: false,
        reason: "origin_disabled",
      });
    expect(h.asked).toHaveLength(0);
  });

  it("only known recipes with a terminal driver, in an allowed workspace, with the program installed", async () => {
    const h = setup();
    h.c.heartbeat(true);
    const open = (appId: string, workspaceLabel = "chalito") =>
      h.c.open({ appId, workspaceLabel, cols: 80, rows: 24 }, PHONE);
    expect(await open("unknown-app")).toEqual({ ok: false, reason: "unknown_app" });
    expect(await open("aider", "elsewhere")).toEqual({ ok: false, reason: "unknown_workspace" });
    h.deps.resolve = () => null;
    expect(await open("aider")).toEqual({ ok: false, reason: "app_not_installed" });
    expect(h.spawned).toHaveLength(0);
  });

  it("refuses without the desktop app (no indicator heartbeat) or without a PTY layer", async () => {
    const h = setup();
    expect(await h.c.open({ appId: "aider", workspaceLabel: "chalito", cols: 80, rows: 24 }, PHONE)).toEqual({
      ok: false,
      reason: "terminal_unavailable",
    });
    const noPty = setup();
    noPty.deps.pty = () => {
      throw new PtyUnavailableError("nope");
    };
    noPty.c.heartbeat(true);
    expect(await noPty.c.open({ appId: "aider", workspaceLabel: "chalito", cols: 80, rows: 24 }, PHONE)).toEqual({
      ok: false,
      reason: "terminal_unavailable",
    });
  });

  it("the raw shell is a separate gate: off unless rawShell is on too", async () => {
    const h = setup();
    h.c.heartbeat(true);
    const shell = () => h.c.open({ appId: "shell", workspaceLabel: "chalito", cols: 80, rows: 24 }, PHONE);
    expect(await shell()).toEqual({ ok: false, reason: "raw_shell_disabled" });
    // rawShell without remote terminal on counts as off.
    h.setPolicy({ ...ON, enabled: false, rawShell: true });
    expect(await shell()).toEqual({ ok: false, reason: "terminal_disabled" });
    h.setPolicy({ ...ON, rawShell: true });
    const r = await shell();
    expect(r).toMatchObject({ ok: true });
    await h.settle();
    expect(h.asked[0]!.input).toMatchObject({
      details: { toolName: "raw_shell", input: { appId: "shell", command: "/bin/zsh -l" } },
    });
    // A recipe can't pose as the shell.
    h.deps.launch = () => ({ appId: "shell", name: "x", command: ["sh"], rawShell: true });
    expect(await h.c.open({ appId: "fake-shell", workspaceLabel: "chalito", cols: 80, rows: 24 }, PHONE)).toEqual({
      ok: false,
      reason: "unknown_app",
    });
  });

  it("limits open terminals and opens per minute", async () => {
    const h = setup({ approve: async () => ({ allow: true, reason: "signed_allow" }) });
    h.c.heartbeat(true);
    const open = () => h.c.open({ appId: "aider", workspaceLabel: "chalito", cols: 80, rows: 24 }, PHONE);
    expect(await open()).toMatchObject({ ok: true });
    expect(await open()).toMatchObject({ ok: true });
    expect(await open()).toEqual({ ok: false, reason: "terminal_limit" });
    h.setPolicy({ ...ON, maxSessions: 10 });
    for (let i = 0; i < 4; i++) expect(await open()).toMatchObject({ ok: true });
    expect(await open()).toEqual({ ok: false, reason: "rate_limited" });
  });
});

describe("remote terminal: approval per terminal", () => {
  it("nothing runs before the person approves; the request names the app, folder and command", async () => {
    const h = setup();
    h.c.heartbeat(true);
    const r = await h.c.open({ appId: "aider", workspaceLabel: "chalito", cols: 100, rows: 30 }, PHONE);
    expect(r).toEqual({ ok: true, tid: "term_1" });
    await h.settle();
    expect(h.spawned).toHaveLength(0);
    expect(h.c.status().pending).toEqual([{ sid: "term_1", label: "Terminal · Aider · chalito" }]);
    expect(h.sessions.get("term_1")).toMatchObject({
      kind: "terminal",
      appId: "aider",
      state: "waiting_approval",
      deviceId: "dev_agent",
    });
    expect(h.asked).toEqual([
      {
        tid: "term_1",
        input: {
          origin: PHONE,
          details: {
            toolName: "terminal",
            input: { app: "Aider", appId: "aider", workspace: "chalito", command: "aider --no-auto-commits" },
            reasons: expect.any(Array),
          },
        },
      },
    ]);
    expect(h.types()).toContain("approval.requested");
    await h.allow();
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]).toMatchObject({
      file: "/usr/bin/aider",
      args: ["--no-auto-commits"],
      o: { cols: 100, rows: 30, cwd: "/home/aldo/code/chalito" },
    });
    expect(h.types()).toEqual(["approval.requested", "approval.resolved", "terminal.started"]);
    expect(h.sessions.get("term_1")).toMatchObject({ state: "running" });
    expect(h.c.status().active).toEqual([
      { sid: "term_1", label: "Terminal · Aider · chalito", since: expect.any(Number) },
    ]);
  });

  it("a deny (or an expiry) ends it and nothing runs", async () => {
    const h = setup();
    h.c.heartbeat(true);
    await h.c.open({ appId: "aider", workspaceLabel: "chalito", cols: 80, rows: 24 }, PHONE);
    await h.settle();
    await h.allow(false);
    expect(h.spawned).toHaveLength(0);
    expect(h.events.at(-1)).toMatchObject({ type: "terminal.closed", reason: "denied" });
    expect(h.c.status()).toMatchObject({ active: [], pending: [] });
    expect(h.audits.map((a) => a.type)).toEqual(["terminal.requested", "terminal.denied", "terminal.closed"]);
  });

  it("doesn't start unless the desktop app shows the indicator", async () => {
    const h = setup();
    h.c.heartbeat(false);
    // Heartbeat present but the indicator isn't on screen: approved, then given up.
    await h.c.open({ appId: "aider", workspaceLabel: "chalito", cols: 80, rows: 24 }, PHONE);
    await h.settle();
    await h.allow();
    for (let i = 0; i < 5; i++) await h.settle();
    expect(h.spawned).toHaveLength(0);
    expect(h.events.at(-1)).toMatchObject({ type: "terminal.closed", reason: "indicator" });
  });

  it("an approval that arrives after the kill switch starts nothing", async () => {
    const h = setup();
    h.c.heartbeat(true);
    await h.c.open({ appId: "aider", workspaceLabel: "chalito", cols: 80, rows: 24 }, PHONE);
    await h.settle();
    expect(await h.c.kill("hotkey")).toBe(1);
    await h.allow();
    expect(h.spawned).toHaveLength(0);
    expect(h.events.filter((e) => e.type === "terminal.closed")).toEqual([
      expect.objectContaining({ reason: "killed" }),
    ]);
  });
});

describe("remote terminal: sealed I/O", () => {
  it("input reaches the PTY; output comes back sealed per chunk, in seq order, bound to tid and seq", async () => {
    const h = setup();
    const tid = await running(h);
    expect(h.c.input(tid, "ls -la\r", PHONE)).toEqual({ ok: true });
    expect(h.spawned[0]!.writes).toEqual(["ls -la\r"]);
    await h.flush();
    const out = h.events.filter((e) => e.type === "terminal.output");
    expect(out).toHaveLength(1);
    const chunk = out[0] as Extract<AgentEvent, { type: "terminal.output" }>;
    expect(chunk).toMatchObject({ sid: tid, tid, deviceId: "dev_agent" });
    expect(h.box.open(chunk.dataCt)).toEqual({ value: { data: "echo:ls -la\r" }, aad: `terminal:${tid}:${chunk.seq}` });
    // Nothing in plaintext carries the bytes.
    expect(JSON.stringify(h.events)).not.toContain("ls -la");
    const seqs = h.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("coalesces output into chunks and keeps the order across many writes", async () => {
    const h = setup();
    const tid = await running(h);
    const emit = h.spawned[0]!.o.onData;
    for (let i = 0; i < 100; i++) emit(`line ${i}\n`);
    await h.flush();
    const text = h
      .output()
      .map((o) => (o.value as { data: string }).data)
      .join("");
    expect(text).toBe(Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join(""));
    expect(h.output().length).toBe(1);
    expect(h.c.status().active[0]!.sid).toBe(tid);
  });

  it("resize goes to the PTY; before the start it sets the opening size", async () => {
    const h = setup();
    h.c.heartbeat(true);
    const { tid } = (await h.c.open({ appId: "aider", workspaceLabel: "chalito", cols: 80, rows: 24 }, PHONE)) as {
      tid: string;
    };
    await h.settle();
    expect(h.c.resize(tid, 120, 40, PHONE)).toEqual({ ok: true });
    await h.allow();
    expect(h.spawned[0]!.o).toMatchObject({ cols: 120, rows: 40 });
    expect(h.c.resize(tid, 90, 20, PHONE)).toEqual({ ok: true });
    expect(h.spawned[0]!.resizes).toEqual([[90, 20]]);
    // The wire format bounds sizes.
    for (const [cols, rows] of [
      [1, 24],
      [501, 24],
      [80, 0],
      [80, 201],
    ])
      expect(CommandPayload.safeParse({ type: "terminal.resize", tid, cols, rows }).success).toBe(false);
  });

  it("input is refused before the start, from unsigned origins, without the indicator, and over the rate", async () => {
    const h = setup();
    h.c.heartbeat(true);
    const { tid } = (await h.c.open({ appId: "aider", workspaceLabel: "chalito", cols: 80, rows: 24 }, PHONE)) as {
      tid: string;
    };
    expect(h.c.input(tid, "x", PHONE)).toEqual({ ok: false, reason: "terminal_not_running" });
    await h.settle();
    await h.allow();
    expect(h.c.input(tid, "x", "mcp:claude")).toEqual({ ok: false, reason: "origin_disabled" });
    expect(h.c.input("nope", "x", PHONE)).toEqual({ ok: false, reason: "unknown_session" });
    expect(h.c.input(tid, "a".repeat(4097), PHONE)).toEqual({ ok: false, reason: "invalid" });
    h.c.heartbeat(false);
    expect(h.c.input(tid, "x", PHONE)).toEqual({ ok: false, reason: "terminal_unavailable" });
    h.c.heartbeat(true);
    // maxInputPerMinute = 1000 characters.
    expect(h.c.input(tid, "a".repeat(900), PHONE)).toEqual({ ok: true });
    expect(h.c.input(tid, "a".repeat(200), PHONE)).toEqual({ ok: false, reason: "rate_limited" });
    h.advance(60_000);
    h.c.heartbeat(true);
    expect(h.c.input(tid, "a".repeat(200), PHONE)).toEqual({ ok: true });
    expect(h.spawned[0]!.writes).toEqual(["a".repeat(900), "a".repeat(200)]);
  });

  it("starts the program without Chalito's secrets and with CHALITO_SESSION set", async () => {
    const h = setup();
    await running(h);
    const env = h.spawned[0]!.o.env;
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/aldo", LANG: "es", TERM: "xterm-256color" });
    expect(env.CHALITO_SESSION).toBe("term_1");
    expect(env).not.toHaveProperty("CHALITO_IPC_SECRET");
    expect(env).not.toHaveProperty("SUPABASE_KEY");
  });

  it("an exit flushes the last output and closes with the exit code", async () => {
    const h = setup();
    const tid = await running(h);
    const o = h.spawned[0]!.o;
    o.onData("bye\n");
    o.onExit({ exitCode: 3 });
    for (let i = 0; i < 5; i++) await h.settle();
    expect(h.output().map((x) => (x.value as { data: string }).data)).toEqual(["bye\n"]);
    expect(h.events.at(-1)).toMatchObject({ type: "terminal.closed", tid, reason: "exited", exitCode: 3 });
    expect(h.sessions.get(tid)).toMatchObject({ state: "failed" });
    expect(h.c.has(tid)).toBe(false);
  });

  it("close from a trusted client hangs the program up, then kills it if it lingers", async () => {
    const h = setup();
    const tid = await running(h);
    expect(await h.c.close(tid, PHONE)).toEqual({ ok: true });
    expect(h.spawned[0]!.kills).toEqual(["SIGHUP"]);
    await h.flush(2500);
    expect(h.spawned[0]!.kills).toEqual(["SIGHUP", "SIGKILL"]);
    expect(h.events.at(-1)).toMatchObject({ type: "terminal.closed", reason: "closed" });
    expect(await h.c.close(tid, PHONE)).toEqual({ ok: false, reason: "unknown_session" });
  });

  it("a program that exits on the hang-up isn't killed again later", async () => {
    const h = setup();
    const tid = await running(h);
    await h.c.close(tid, PHONE);
    h.spawned[0]!.o.onExit({ exitCode: 129 });
    await h.flush(2500);
    expect(h.spawned[0]!.kills).toEqual(["SIGHUP"]);
  });
});

describe("remote terminal: kill switch, policy and indicator", () => {
  it("the kill switch closes every terminal (running and pending) at once", async () => {
    const h = setup();
    const tid = await running(h);
    const { tid: pending } = (await h.c.open(
      { appId: "aider", workspaceLabel: "chalito", cols: 80, rows: 24 },
      PHONE,
    )) as {
      tid: string;
    };
    await h.settle();
    expect(await h.c.kill("tray")).toBe(2);
    expect(h.spawned[0]!.kills).toEqual(["SIGHUP"]);
    expect(h.c.status()).toMatchObject({ active: [], pending: [] });
    expect(h.c.input(tid, "x", PHONE)).toEqual({ ok: false, reason: "unknown_session" });
    const closed = h.events
      .filter((e) => e.type === "terminal.closed")
      .map((e) => [e.sid, (e as { reason: string }).reason]);
    expect(closed).toEqual(
      expect.arrayContaining([
        [tid, "killed"],
        [pending, "killed"],
      ]),
    );
    expect(h.audits.find((a) => a.type === "terminal.killed")?.meta).toEqual({ by: "tray", sessions: 2 });
    expect(h.published.at(-1)).toEqual({ enabled: true, rawShell: false, activeSessions: 0, by: "tray" });
    expect(await h.c.kill("tray")).toBe(0);
  });

  it("turning it off closes everything; turning the raw shell off closes only shells", async () => {
    const h = setup({ policy: { ...ON, rawShell: true, maxSessions: 5 } });
    const app = await running(h, "aider");
    const shell = await running(h, "shell");
    h.setPolicy({ ...ON, rawShell: false, maxSessions: 5 });
    await h.c.onPolicyChange();
    expect(h.c.has(shell)).toBe(false);
    expect(h.c.has(app)).toBe(true);
    h.setPolicy({ ...ON, enabled: false });
    await h.c.onPolicyChange();
    expect(h.c.has(app)).toBe(false);
    expect(h.events.filter((e) => e.type === "terminal.closed").map((e) => (e as { reason: string }).reason)).toEqual([
      "disabled",
      "disabled",
    ]);
  });

  it("closes open terminals when the indicator has been gone for the grace period", async () => {
    const h = setup();
    const tid = await running(h);
    await h.c.tick();
    expect(h.c.has(tid)).toBe(true);
    h.advance(5000); // the heartbeat goes stale
    await h.c.tick();
    expect(h.c.has(tid)).toBe(true);
    h.advance(10_000);
    await h.c.tick();
    expect(h.c.has(tid)).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ type: "terminal.closed", reason: "indicator" });
  });

  it("audits metadata only: never what was typed or printed", async () => {
    const h = setup();
    const tid = await running(h);
    h.c.input(tid, "export TOKEN=hunter2\r", PHONE);
    h.spawned[0]!.o.onData("secret output\n");
    await h.flush();
    await h.c.close(tid, PHONE);
    const all = JSON.stringify(h.audits) + JSON.stringify(h.published) + JSON.stringify(h.sessions.get(tid));
    expect(all).not.toContain("hunter2");
    expect(all).not.toContain("secret output");
    expect(h.audits.find((a) => a.type === "terminal.closed")?.meta).toMatchObject({
      tid,
      appId: "aider",
      reason: "closed",
      inputChars: 21,
      outputChars: expect.any(Number),
    });
  });
});

// ---- output stream ------------------------------------------------------------------------

describe("terminal output stream", () => {
  const stream = (
    o: { take?: () => boolean; pause?: boolean; send?: (c: { data: string; dropped: number }) => Promise<void> } = {},
  ) => {
    const sent: { data: string; dropped: number }[] = [];
    const timers: (() => void)[] = [];
    const flow = { paused: 0, resumed: 0 };
    const s = new OutputStream({
      send: o.send ?? (async (c) => void sent.push(c)),
      take: o.take ?? (() => true),
      schedule: (fn) => {
        timers.push(fn);
        return { clear: () => undefined };
      },
      ...(o.pause === false ? {} : { pause: () => void flow.paused++, resume: () => void flow.resumed++ }),
      onError: () => undefined,
      limits: { chunkChars: 10, scrollbackChars: 50, highWater: 30, lowWater: 5, maxInflight: 2 },
    });
    const tick = async () => {
      for (const fn of timers.splice(0)) fn();
      await new Promise((r) => setTimeout(r, 0));
    };
    return { s, sent, tick, flow };
  };

  it("chunks without splitting surrogate pairs", async () => {
    const { s, sent, tick } = stream();
    s.push("123456789😀abc");
    await tick();
    await tick();
    expect(sent.map((c) => c.data)).toEqual(["123456789", "😀abc"]);
  });

  it("holds at most the scrollback limit and says how much it dropped", async () => {
    let budget = false;
    const { s, sent, tick } = stream({ take: () => budget, pause: false });
    s.push("x".repeat(80));
    expect(s.pending).toBe(50);
    expect(s.droppedChars).toBe(30);
    await tick();
    expect(sent).toEqual([]);
    budget = true;
    for (let i = 0; i < 6; i++) await tick();
    expect(sent[0]).toEqual({ data: "x".repeat(10), dropped: 30 });
    expect(sent.slice(1).every((c) => c.dropped === 0)).toBe(true);
    expect(sent.map((c) => c.data).join("")).toBe("x".repeat(50));
  });

  it("pauses the PTY above the high-water mark and resumes once drained", async () => {
    let release: (() => void)[] = [];
    const { s, flow, tick } = stream({ send: () => new Promise<void>((r) => release.push(r)) });
    s.push("z".repeat(45));
    expect(flow.paused).toBe(1);
    // Only maxInflight (2) chunks in flight at a time.
    expect(release).toHaveLength(2);
    for (let i = 0; i < 10 && release.length; i++) {
      const now = release;
      release = [];
      now.forEach((r) => r());
      await tick();
    }
    expect(s.pending).toBe(0);
    expect(flow.resumed).toBe(1);
  });

  it("the token bucket refills over time", () => {
    let t = 0;
    const b = new TokenBucket(
      () => 2,
      () => 60,
      () => t,
    );
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    t += 1000;
    expect(b.take()).toBe(true);
    expect(b.take(5)).toBe(false);
  });
});

// ---- drivers, PTY layer ------------------------------------------------------------------------

describe("terminal driver", () => {
  it("registers under the engine's registry and reads only driver.terminal.command", () => {
    registerDriver("terminal", terminalDriverFactory);
    const f = driverFactory("terminal")!;
    expect(f({ id: "aider", name: "Aider", driver: { terminal: { command: ["aider"] } } })).toEqual({
      appId: "aider",
      name: "Aider",
      command: ["aider"],
      rawShell: false,
    });
    expect(f({ id: "chatgpt", driver: { web: { startUrl: "https://chatgpt.com" } } })).toBeNull();
    expect(f({ id: "x", driver: { terminal: { command: [] } } })).toBeNull();
    // "shell" is never a recipe: the raw shell is built in and has its own toggle.
    expect(f({ id: "shell", driver: { terminal: { command: ["bash"] } } })).toBeNull();
  });

  it("resolves a program by PATH or absolute path; never a relative path", async () => {
    expect(resolveProgram("sh", { PATH: "/usr/bin:/bin" }, "linux")).toMatch(/\/sh$/);
    expect(resolveProgram("/bin/sh", {}, "linux")).toBe("/bin/sh");
    expect(resolveProgram("/nope/aider", {}, "linux")).toBeNull();
    expect(resolveProgram("no-such-program-xyz", { PATH: "/usr/bin" }, "linux")).toBeNull();
    const h = setup();
    h.c.heartbeat(true);
    h.deps.launch = () => ({ appId: "evil", name: "Evil", command: ["./run.sh"], rawShell: false });
    expect(await h.c.open({ appId: "evil", workspaceLabel: "chalito", cols: 80, rows: 24 }, PHONE)).toEqual({
      ok: false,
      reason: "app_not_installed",
    });
  });

  it("the raw shell is the person's login shell (PowerShell on Windows)", () => {
    expect(rawShellLaunch({ SHELL: "/bin/bash" }, "linux").command).toEqual(["/bin/bash", "-l"]);
    expect(rawShellLaunch({ SHELL: "/opt/nu" }, "darwin").command).toEqual(["/opt/nu"]);
    expect(rawShellLaunch({ SHELL: "relative" }, "linux").command).toEqual(["/bin/sh", "-l"]);
    expect(rawShellLaunch({}, "win32").command).toEqual(["powershell.exe", "-NoLogo"]);
  });

  it("picks Bun's built-in PTY under Bun on macOS/Linux, node-pty otherwise", () => {
    const fakeBun = { spawn: () => ({}) };
    expect(loadPtyBackend({ platform: "linux", bun: fakeBun }).name).toBe("bun");
    expect(loadPtyBackend({ platform: "darwin", bun: fakeBun }).name).toBe("bun");
    const nodePty = { spawn: () => ({}) };
    expect(loadPtyBackend({ platform: "win32", bun: fakeBun, requireFn: () => nodePty }).name).toBe("node-pty");
    expect(loadPtyBackend({ platform: "linux", bun: undefined, requireFn: () => nodePty }).name).toBe("node-pty");
    expect(() =>
      loadPtyBackend({
        platform: "linux",
        bun: undefined,
        requireFn: () => {
          throw new Error("Cannot find module");
        },
      }),
    ).toThrow(PtyUnavailableError);
    expect(() => loadPtyBackend({ platform: "freebsd", bun: undefined })).toThrow(PtyUnavailableError);
  });

  it.skipIf(process.platform === "win32")(
    "a real PTY round-trips under Node (node-pty): size, input, exit",
    async () => {
      const backend = loadPtyBackend();
      expect(backend.name).toBe("node-pty");
      const out = await new Promise<string>((resolve, reject) => {
        let buf = "";
        const timer = setTimeout(() => reject(new Error(`timeout: ${JSON.stringify(buf)}`)), 5000);
        const p = backend.spawn("/bin/sh", ["-c", "read x; stty size; echo got:$x"], {
          cols: 81,
          rows: 23,
          cwd: "/",
          env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
          onData: (d) => void (buf += d),
          onExit: () => {
            clearTimeout(timer);
            resolve(buf);
          },
        });
        p.write("ping\r");
      });
      expect(out).toContain("23 81");
      expect(out).toContain("got:ping");
    },
  );

  it("Bun backend: argv, size, input, resize and exit through Bun.spawn's terminal", async () => {
    const calls: unknown[] = [];
    let data: ((t: unknown, d: Uint8Array) => void) | null = null;
    let exit: (code: number) => void = () => undefined;
    const term = {
      write: (s: string) => (calls.push(["write", s]), s.length),
      resize: (c: number, r: number) => void calls.push(["resize", c, r]),
      close: () => void calls.push(["close"]),
    };
    const bun = {
      spawn: (argv: string[], opts: { terminal: { cols: number; rows: number; data: typeof data } }) => {
        calls.push(["spawn", argv, opts.terminal.cols, opts.terminal.rows]);
        data = opts.terminal.data;
        return {
          pid: 7,
          exited: new Promise<number>((r) => (exit = r)),
          signalCode: null,
          terminal: term,
          kill: (s: string) => void calls.push(["kill", s]),
        };
      },
    };
    const got: string[] = [];
    let exited: unknown = null;
    const p = bunBackend(bun as never).spawn("/usr/bin/aider", ["--x"], {
      cols: 80,
      rows: 24,
      cwd: "/w",
      env: {},
      onData: (d) => void got.push(d),
      onExit: (e) => void (exited = e),
    });
    data!(term, new TextEncoder().encode("héllo"));
    p.write("ls\r");
    p.resize(100, 30);
    p.kill();
    p.kill("SIGKILL");
    exit(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(got.join("")).toBe("héllo");
    expect(exited).toEqual({ exitCode: 0, signal: null });
    expect(calls).toEqual([
      ["spawn", ["/usr/bin/aider", "--x"], 80, 24],
      ["write", "ls\r"],
      ["resize", 100, 30],
      ["kill", "SIGHUP"],
      ["kill", "SIGKILL"],
      ["close"],
    ]);
  });
});

// ---- local-only enable --------------------------------------------------------------------

describe("enabling is local-only (OS auth + confirmations)", () => {
  const holder = (initial?: Policy["remoteTerminal"]) => {
    let p: Policy = { ...DEFAULT_POLICY, ...(initial ? { remoteTerminal: initial } : {}) };
    return { get: () => p, set: async (n: Policy) => void (p = n) };
  };
  const prompter = (o: Partial<Record<keyof TerminalPrompter, unknown>> = {}) => {
    const seen: string[] = [];
    const p: TerminalPrompter = {
      first: async () => (seen.push("first"), (o.first as boolean) ?? true),
      second: async () => (seen.push("second"), (o.second as boolean) ?? true),
      typed: async (phrase) => (seen.push("typed"), (o.typed as string) ?? phrase),
      final: async () => (seen.push("final"), (o.final as boolean) ?? true),
    };
    return { p, seen };
  };
  const deps = (h: ReturnType<typeof holder>, p: TerminalPrompter, os = true) => {
    const emitted: string[] = [];
    return {
      d: {
        policy: h,
        osAuth: { verify: async () => os },
        prompter: p,
        locale: "en" as const,
        emit: (t: string) => void emitted.push(t),
      },
      emitted,
    };
  };

  it("remote terminal: OS auth, two confirmations and the phrase; it never carries the raw shell over", async () => {
    const h = holder({ ...ON, enabled: false, rawShell: true });
    const { p, seen } = prompter();
    const { d, emitted } = deps(h, p);
    expect(await enableRemoteTerminal(d)).toEqual({ ok: true });
    expect(seen).toEqual(["first", "second", "typed"]);
    expect(h.get().remoteTerminal).toEqual({ ...ON, enabled: true, rawShell: false });
    expect(emitted).toEqual(["terminal.enabled"]);
    expect(await enableRemoteTerminal(d)).toEqual({ ok: false, reason: "already_on" });
  });

  for (const [what, o, os] of [
    ["failed OS auth", {}, false],
    ["a no", { first: false }, true],
    ["a second no", { second: false }, true],
    ["a wrong phrase", { typed: "remote terminal" }, true],
  ] as const)
    it(`remote terminal: ${what} changes nothing`, async () => {
      const h = holder();
      const { d } = deps(h, prompter(o).p, os);
      expect((await enableRemoteTerminal(d)).ok).toBe(false);
      expect(h.get().remoteTerminal).toBeUndefined();
    });

  it("raw shell: needs remote terminal on, then four steps and its own longer phrase", async () => {
    const off = holder();
    expect(await enableRawShell(deps(off, prompter().p).d)).toEqual({ ok: false, reason: "terminal_off" });
    const h = holder(ON);
    const { p, seen } = prompter();
    const { d, emitted } = deps(h, p);
    expect(await enableRawShell(d)).toEqual({ ok: true });
    expect(seen).toEqual(["first", "second", "typed", "final"]);
    expect(h.get().remoteTerminal?.rawShell).toBe(true);
    expect(emitted).toEqual(["terminal.raw_shell_enabled"]);
    expect(RAW_SHELL_COPY.en.phrase.length).toBeGreaterThan(TERMINAL_COPY.en.phrase.length);
    expect(RAW_SHELL_COPY.es.warning).toBeTruthy();
    for (const o of [{ final: false }, { typed: TERMINAL_COPY.en.phrase }]) {
      const again = holder(ON);
      expect((await enableRawShell(deps(again, prompter(o).p).d)).ok).toBe(false);
      expect(again.get().remoteTerminal?.rawShell).toBe(false);
    }
  });

  it("turning off needs no OS auth; turning remote terminal off turns the raw shell off too", async () => {
    const h = holder({ ...ON, rawShell: true });
    const emitted: string[] = [];
    const d = { policy: h, emit: (t: string) => void emitted.push(t) };
    expect(await disableRawShell(d, "cli")).toBe(true);
    expect(h.get().remoteTerminal).toMatchObject({ enabled: true, rawShell: false });
    expect(await disableRawShell(d, "cli")).toBe(false);
    await h.set({ ...h.get(), remoteTerminal: { ...ON, rawShell: true } });
    expect(await disableRemoteTerminal(d, "cli")).toBe(true);
    expect(h.get().remoteTerminal).toMatchObject({ enabled: false, rawShell: false });
    expect(emitted).toEqual(["terminal.raw_shell_disabled", "terminal.disabled"]);
  });

  it("remote tightening can turn them off or lower the limits, never on, never stage the raw shell", () => {
    const cur: Policy = { ...DEFAULT_POLICY, remoteTerminal: ON };
    const off: Policy = { ...DEFAULT_POLICY };
    const rt = (p: Partial<NonNullable<Policy["remoteTerminal"]>>) => ({ remoteTerminal: { ...ON, ...p } });
    expect(applyRemoteTighten(off, rt({})).ok).toBe(false);
    expect(applyRemoteTighten(off, rt({ enabled: false, rawShell: true })).ok).toBe(false);
    expect(applyRemoteTighten(off, rt({ enabled: false, maxSessions: 10 })).ok).toBe(false);
    expect(applyRemoteTighten(cur, { remoteTerminal: { rawShell: true } })).toEqual({
      ok: false,
      reason: "would_loosen",
    });
    expect(applyRemoteTighten(cur, { remoteTerminal: { maxInputPerMinute: 2000 } }).ok).toBe(false);
    const down = applyRemoteTighten(cur, { remoteTerminal: { enabled: false } });
    expect(down).toMatchObject({ ok: true, policy: { remoteTerminal: { ...ON, enabled: false } } });
    expect(isTighterOrEqual({ ...cur, remoteTerminal: { ...ON, maxSessions: 1 } }, cur)).toBe(true);
    const shellOn: Policy = { ...DEFAULT_POLICY, remoteTerminal: { ...ON, rawShell: true } };
    expect(applyRemoteTighten(shellOn, { remoteTerminal: { rawShell: false } }).ok).toBe(true);
  });
});
