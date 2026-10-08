import { connect } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { Origin } from "@chalito/protocol";
import { brokerCall, startBroker } from "../src/computer/broker.js";
import {
  ComputerControl,
  ComputerError,
  type ComputerApprovalOutcome,
  type ComputerDeps,
} from "../src/computer/control.js";
import { downscaleRgba, encodePngRgb, fitSize } from "../src/computer/image.js";
import { handleMcpMessage, runMcpServer } from "../src/computer/mcp-server.js";
import {
  ComputerUnsupportedError,
  focusCommand,
  isWayland,
  loadNativeDriver,
  type DisplayInfo,
  type NativeDriver,
} from "../src/computer/native.js";
import { COMPUTER_COPY, disableComputer, enableComputer } from "../src/computer/toggle.js";
import { COMPUTER_TOOL_PREFIX, TOOL_NAMES, ToolArgs, mcpTools, parseCombo } from "../src/computer/tools.js";
import { DEFAULT_POLICY, applyRemoteTighten, isTighterOrEqual, type Policy } from "../src/policy/index.js";
import { PassThrough } from "node:stream";

// ---- fakes ---------------------------------------------------------------------------

type Op = [string, ...unknown[]];

const fakeDriver = (displays?: DisplayInfo[]) => {
  const ops: Op[] = [];
  /** Runs after each recorded native call (e.g. to press the kill switch mid-action). */
  const hooks: { after?: (op: Op) => void } = {};
  const record = (op: Op) => {
    ops.push(op);
    hooks.after?.(op);
  };
  const shown: DisplayInfo[] = displays ?? [
    { index: 0, name: "Built-in", x: 0, y: 0, width: 1440, height: 900, scaleFactor: 2, primary: true },
  ];
  const driver: NativeDriver = {
    displays: () => shown,
    capture: async (i) => {
      ops.push(["capture", i]);
      const d = shown[i]!;
      const w = d.width * d.scaleFactor;
      const h = d.height * d.scaleFactor;
      return { width: w, height: h, rgba: new Uint8Array(w * h * 4).fill(200) };
    },
    move: (x, y) => record(["move", x, y]),
    click: (b, dbl) => record(["click", b, dbl]),
    button: (down, b) => record(["button", down, b]),
    scroll: (dx, dy) => record(["scroll", dx, dy]),
    type: (t) => record(["type", t]),
    key: (k, m) => record(["key", k, m]),
    windows: () => [
      {
        id: 7,
        pid: 70,
        app: "Terminal",
        title: "secret title",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        focused: true,
        minimized: false,
      },
    ],
    focus: async (w) => void ops.push(["focus", w.id]),
  };
  return { driver, ops, hooks };
};

const ON: Policy["computer"] = { enabled: true, maxActionsPerMinute: 60 };

const setup = (
  o: {
    policy?: Policy["computer"];
    approve?: (sid: string) => Promise<ComputerApprovalOutcome>;
    launch?: boolean;
    apps?: ComputerDeps["apps"];
  } = {},
) => {
  let policy: Policy["computer"] = "policy" in o ? o.policy : ON;
  let t = 1_790_000_000_000;
  const audits: { type: string; meta: Record<string, unknown> }[] = [];
  const published: unknown[] = [];
  const interrupted: string[] = [];
  const asked: { sid: string; input: unknown }[] = [];
  const { driver, ops, hooks } = fakeDriver();
  let release: ((o: ComputerApprovalOutcome) => void) | null = null;
  const deps: ComputerDeps = {
    policy: () => policy,
    requestApproval: async (sid, input) => {
      asked.push({ sid, input });
      if (o.approve) return o.approve(sid);
      return new Promise((r) => (release = r));
    },
    interrupt: async (sid) => void interrupted.push(sid),
    driver: () => driver,
    audit: (type, meta) => void audits.push({ type, meta }),
    publish: (s) => void published.push(s),
    mcpLaunch: () =>
      o.launch === false ? null : { command: "/opt/chalito/chalito-agent", args: ["computer", "mcp"], socket: "/s" },
    now: () => t,
    // Time only moves when the code waits.
    sleep: async (ms) => {
      t += ms;
      await Promise.resolve();
    },
    newToken: () => "tok_1",
    ...(o.apps ? { apps: o.apps } : {}),
  };
  const c = new ComputerControl(deps);
  return {
    c,
    ops,
    hooks,
    audits,
    published,
    interrupted,
    asked,
    setPolicy: (p: Policy["computer"]) => (policy = p),
    advance: (ms: number) => (t += ms),
    allow: (allow = true) =>
      release?.({ allow, reason: allow ? "signed_allow" : "signed_deny", byDeviceId: "dev_phone" }),
    actions: () => audits.filter((a) => a.type === "computer.action"),
  };
};

const attached = (h: ReturnType<typeof setup>, origin: Origin = "client:dev_phone") => {
  const spec = h.c.attach("s1", { label: "chalito", adapter: "claude-code", origin });
  h.c.heartbeat(true);
  return spec;
};

/** Grants the session through the approval (first call), then returns the first call's result. */
const granted = async (h: ReturnType<typeof setup>, tool = "mouse_move", args: unknown = { x: 1, y: 1 }) => {
  attached(h);
  const first = h.c.call("tok_1", tool, args);
  await new Promise((r) => setTimeout(r, 0));
  h.allow();
  return first;
};

// ---- tools and schemas --------------------------------------------------------------------

describe("computer MCP tool schemas", () => {
  it("lists every tool with an object JSON schema, prefixed for Claude Code", () => {
    const tools = mcpTools();
    expect(tools.map((t) => t.name)).toEqual([
      "screenshot",
      "mouse_move",
      "click",
      "double_click",
      "drag",
      "scroll",
      "type_text",
      "key",
      "list_windows",
      "focus_window",
      "wait",
      "list_apps",
      "launch_app",
      "open_web_app",
    ]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema).not.toHaveProperty("$schema");
      expect(t.description.length).toBeGreaterThan(10);
    }
    expect(tools.find((t) => t.name === "click")!.inputSchema.properties).toHaveProperty("button");
    expect(COMPUTER_TOOL_PREFIX).toBe("mcp__chalito_computer__");
  });

  it("validates arguments strictly", () => {
    const ok = (n: keyof typeof ToolArgs, a: unknown) => ToolArgs[n].safeParse(a).success;
    expect(ok("click", {})).toBe(true);
    expect(ok("click", { x: 3, y: 4, button: "right" })).toBe(true);
    expect(ok("click", { x: 3 })).toBe(false);
    expect(ok("click", { x: -1, y: 0 })).toBe(false);
    expect(ok("click", { x: 1, y: 1, extra: 1 })).toBe(false);
    expect(ok("type_text", { text: "" })).toBe(false);
    expect(ok("type_text", { text: "a".repeat(2001) })).toBe(false);
    expect(ok("key", { keys: "ctrl+shift+t" })).toBe(true);
    expect(ok("key", { keys: "ctrl+rm -rf" })).toBe(false);
    expect(ok("wait", { ms: 10_001 })).toBe(false);
    expect(ok("scroll", { dy: 3 })).toBe(true);
    expect(ok("drag", { fromX: 1, fromY: 1, toX: 2, toY: 2 })).toBe(true);
    expect(ok("launch_app", { appId: "chatgpt-desktop" })).toBe(true);
    expect(ok("launch_app", { appId: "../etc" })).toBe(false);
    expect(ok("launch_app", { appId: "x", path: "/bin/sh" })).toBe(false);
    expect(ok("open_web_app", { appId: "chatgpt", url: "https://chatgpt.com/" })).toBe(true);
    expect(TOOL_NAMES).toHaveLength(14);
  });

  it("parses key combos into robotjs names", () => {
    expect(parseCombo("ctrl+shift+T")).toEqual({ key: "t", modifiers: ["control", "shift"] });
    expect(parseCombo("cmd+space")).toEqual({ key: "space", modifiers: ["command"] });
    expect(parseCombo("Return")).toEqual({ key: "enter", modifiers: [] });
    expect(parseCombo("option+f4")).toEqual({ key: "f4", modifiers: ["alt"] });
    expect(parseCombo("ctrl+ctrl+a")).toBeNull();
    expect(parseCombo("hyper+a")).toBeNull();
    expect(parseCombo("ctrl+")).toBeNull();
  });
});

describe("computer MCP server (stdio)", () => {
  const call = async () => ({ ok: true as const, result: { text: "ok" } });

  it("negotiates the protocol version and lists the tools", async () => {
    const init = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { call },
    );
    expect(init).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
    const odd = await handleMcpMessage({ id: 2, method: "initialize", params: { protocolVersion: "1999" } }, { call });
    expect((odd as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-11-25");
    const list = (await handleMcpMessage({ id: 3, method: "tools/list" }, { call })) as {
      result: { tools: { name: string }[] };
    };
    expect(list.result.tools).toHaveLength(14);
    expect(await handleMcpMessage({ method: "notifications/initialized" }, { call })).toBeNull();
    expect(await handleMcpMessage({ id: 4, method: "resources/list" }, { call })).toMatchObject({
      error: { code: -32601 },
    });
  });

  it("maps broker replies: images first, refusals as tool errors", async () => {
    const shot = await handleMcpMessage(
      { id: 1, method: "tools/call", params: { name: "screenshot", arguments: {} } },
      { call: async () => ({ ok: true, result: { text: "{}", image: { data: "AAAA", mimeType: "image/png" } } }) },
    );
    expect(shot).toMatchObject({
      result: {
        content: [
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "text", text: "{}" },
        ],
      },
    });
    const refused = await handleMcpMessage(
      { id: 2, method: "tools/call", params: { name: "click", arguments: {} } },
      {
        call: async () => ({
          ok: false,
          error: "denied",
          message: "The person denied computer control for this session.",
        }),
      },
    );
    expect(refused).toMatchObject({ result: { isError: true, content: [{ type: "text", text: /denied/ }] } });
  });

  it("runs over newline-delimited stdio until stdin closes", async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    const done = runMcpServer({ input, write: (l) => void lines.push(l), call });
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    input.write("not json\n");
    input.end('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"wait","arguments":{"ms":5}}}\n');
    await done;
    const msgs = lines.map((l) => JSON.parse(l) as { id: unknown; error?: { code: number } });
    expect(msgs.find((m) => m.id === 1)).toMatchObject({ result: {} });
    expect(msgs.find((m) => m.id === null)).toMatchObject({ error: { code: -32700 } });
    expect(msgs.find((m) => m.id === 2)).toMatchObject({ result: { content: [{ text: "ok" }] } });
  });
});

describe("computer broker socket", () => {
  it("drops a connection that never sends its request line", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "chalito-cb-")), "computer.sock");
    const broker = await startBroker({ path, call: async () => ({ text: "ok" }), requestTimeoutMs: 50 });
    try {
      const closed = await new Promise<boolean>((resolve) => {
        const sock = connect(path);
        sock.on("error", () => undefined);
        sock.on("close", () => resolve(true));
        setTimeout(() => resolve(false), 2000);
      });
      expect(closed).toBe(true);
    } finally {
      await broker.close();
    }
  });

  it("answers bad_request to a line that parses to null or a non-object, and keeps serving", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "chalito-cb-")), "computer.sock");
    const broker = await startBroker({ path, call: async () => ({ text: "ok" }) });
    const raw = (line: string) =>
      new Promise<string>((resolve, reject) => {
        const sock = connect(path);
        let buf = "";
        sock.setEncoding("utf8");
        sock.on("connect", () => sock.write(line));
        sock.on("data", (c: string) => void (buf += c));
        sock.on("close", () => resolve(buf));
        sock.on("error", reject);
      });
    try {
      for (const line of ["null\n", "42\n", "[]\n"])
        expect(JSON.parse(await raw(line))).toMatchObject({ ok: false, error: "bad_request" });
      expect(await brokerCall(path, "t", "screenshot", {})).toMatchObject({ ok: true });
    } finally {
      await broker.close();
    }
  });

  it("carries one call per connection, with the session token; unknown tokens are refused", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "chalito-cb-")), "computer.sock");
    const seen: unknown[] = [];
    const broker = await startBroker({
      path,
      call: async (token, tool, args) => {
        seen.push({ token, tool, args });
        if (token !== "good") throw new ComputerError("unknown_session", "This session has no computer control.");
        return { text: "ok", image: { data: "x".repeat(200_000), mimeType: "image/png" } };
      },
    });
    try {
      const ok = await brokerCall(path, "good", "screenshot", {});
      expect(ok).toMatchObject({ ok: true, result: { text: "ok" } });
      expect((ok as { result: { image: { data: string } } }).result.image.data).toHaveLength(200_000);
      expect(await brokerCall(path, "bad", "click", {})).toEqual({
        ok: false,
        error: "unknown_session",
        message: "This session has no computer control.",
      });
      expect(seen).toHaveLength(2);
    } finally {
      await broker.close();
    }
    expect(await brokerCall(path, "good", "click", {})).toMatchObject({ ok: false, error: "agent_unavailable" });
  });
});

describe("screenshots", () => {
  it("fit in 1280×800 without upscaling", () => {
    expect(fitSize(2880, 1800)).toEqual({ width: 1280, height: 800 });
    expect(fitSize(3840, 2160)).toEqual({ width: 1280, height: 720 });
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("downscale by area average and encode a valid PNG", () => {
    // 2×2 RGBA: red, green / blue, white → 1×1 average.
    const src = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    expect([...downscaleRgba(src, 2, 2, 1, 1)]).toEqual([128, 128, 128]);
    expect([...downscaleRgba(new Uint8Array([1, 2, 3, 4]), 1, 1, 1, 1, "bgra")]).toEqual([3, 2, 1]);
    const png = encodePngRgb(Buffer.from([10, 20, 30, 40, 50, 60]), 2, 1);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(2);
    const idatLen = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect([...raw]).toEqual([0, 10, 20, 30, 40, 50, 60]);
  });
});

describe("native layer", () => {
  it("refuses Wayland with a clear message, and unknown platforms", () => {
    expect(isWayland({ XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, "linux")).toBe(true);
    expect(isWayland({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toBe(true);
    expect(isWayland({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" }, "linux")).toBe(false);
    expect(isWayland({ XDG_SESSION_TYPE: "wayland" }, "darwin")).toBe(false);
    const runner = { run: async () => ({ code: 0, stdout: "", stderr: "" }) };
    expect(() => loadNativeDriver({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland" }, runner })).toThrow(/X11/);
    expect(() => loadNativeDriver({ platform: "freebsd", env: {}, runner })).toThrow(ComputerUnsupportedError);
  });

  it("raises windows with a fixed command per OS and only numeric ids", () => {
    const w = {
      id: 4660,
      pid: 321,
      app: "a",
      title: "t",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      focused: false,
      minimized: false,
    };
    expect(focusCommand("darwin", w, {}).args.join(" ")).toContain("unix id is 321");
    expect(focusCommand("win32", w, {}).args.at(-1)).toContain("AppActivate(321)");
    expect(() => focusCommand("linux", w, { PATH: "" })).toThrow(/xdotool/);
    expect(() => focusCommand("darwin", { ...w, pid: Number.NaN }, {})).toThrow();
  });
});

// ---- gating -------------------------------------------------------------------------------

describe("computer control gating", () => {
  it("is off by default: nothing is attached and calls are refused", async () => {
    const h = setup({ policy: undefined });
    expect(h.c.attach("s1", { label: "x", adapter: "claude-code", origin: "local" })).toBeNull();
    expect(h.c.gate("s1", "local")).toEqual({ allow: false, reason: "computer_disabled" });
    await expect(h.c.call("tok_1", "screenshot", {})).rejects.toMatchObject({ code: "unknown_session" });
    expect(DEFAULT_POLICY.computer).toBeUndefined();
  });

  it("is never attached for unsigned origins or without the desktop app's broker", () => {
    expect(setup().c.attach("s1", { label: "x", adapter: "codex", origin: "mcp:claude" })).toBeNull();
    expect(setup().c.attach("s1", { label: "x", adapter: "codex", origin: `call:CA${"a".repeat(32)}` })).toBeNull();
    expect(setup({ launch: false }).c.attach("s1", { label: "x", adapter: "codex", origin: "local" })).toBeNull();
    const spec = setup().c.attach("s1", { label: "x", adapter: "codex", origin: "client:p" });
    expect(spec).toEqual({
      name: "chalito_computer",
      command: "/opt/chalito/chalito-agent",
      args: ["computer", "mcp"],
      env: { CHALITO_COMPUTER_SOCKET: "/s", CHALITO_COMPUTER_TOKEN: "tok_1" },
    });
  });

  it("needs the session's computer_control approval before anything native runs", async () => {
    const h = setup();
    attached(h);
    const a = h.c.call("tok_1", "screenshot", {});
    const b = h.c.call("tok_1", "click", { x: 10, y: 10 });
    await new Promise((r) => setTimeout(r, 0));
    // One approval for the session, however many calls are waiting.
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatchObject({
      sid: "s1",
      input: { origin: "client:dev_phone", details: { toolName: "computer_control" } },
    });
    expect(h.ops).toEqual([]);
    expect(h.c.status().pending).toEqual([{ sid: "s1", label: "chalito" }]);
    h.allow();
    await expect(a).resolves.toMatchObject({ image: { mimeType: "image/png" } });
    await expect(b).resolves.toEqual({ text: "ok" });
    expect(h.c.status().active).toEqual([{ sid: "s1", label: "chalito", since: expect.any(Number) }]);
    expect(h.audits.map((x) => x.type)).toEqual([
      "computer.requested",
      "computer.granted",
      "computer.action",
      "computer.action",
    ]);
    // Later calls don't ask again.
    await h.c.call("tok_1", "key", { keys: "enter" });
    expect(h.asked).toHaveLength(1);
  });

  it("a deny sticks for the session and nothing runs", async () => {
    const h = setup({ approve: async () => ({ allow: false, reason: "signed_deny" }) });
    attached(h);
    await expect(h.c.call("tok_1", "click", {})).rejects.toMatchObject({ code: "denied" });
    await expect(h.c.call("tok_1", "click", {})).rejects.toMatchObject({ code: "denied" });
    expect(h.asked).toHaveLength(1);
    expect(h.c.gate("s1", "client:dev_phone")).toEqual({ allow: false, reason: "computer_denied" });
    expect(h.ops).toEqual([]);
    expect(h.audits.some((a) => a.type === "computer.denied")).toBe(true);
  });

  it("refuses without the desktop app (no heartbeat), and before asking anyone", async () => {
    const h = setup();
    h.c.attach("s1", { label: "x", adapter: "claude-code", origin: "local" });
    await expect(h.c.call("tok_1", "click", {})).rejects.toMatchObject({ code: "no_desktop" });
    h.c.heartbeat(true);
    h.advance(5_000);
    await expect(h.c.call("tok_1", "click", {})).rejects.toMatchObject({ code: "no_desktop" });
    expect(h.asked).toEqual([]);
  });

  it("does nothing unless the indicator is on screen", async () => {
    const h = setup({ approve: async () => ({ allow: true, reason: "signed_allow" }) });
    h.c.attach("s1", { label: "x", adapter: "claude-code", origin: "local" });
    h.c.heartbeat(false);
    await expect(h.c.call("tok_1", "click", {})).rejects.toMatchObject({ code: "indicator" });
    expect(h.ops).toEqual([]);
    h.c.heartbeat(true);
    await expect(h.c.call("tok_1", "click", {})).resolves.toEqual({ text: "ok" });
  });

  it("the Claude Code gate refuses unsigned turns, ended or disabled control", async () => {
    const h = setup({ approve: async () => ({ allow: true, reason: "signed_allow" }) });
    attached(h);
    expect(h.c.gate("s1", "client:dev_phone")).toEqual({ allow: true });
    expect(h.c.gate("s1", "mcp:claude")).toEqual({ allow: false, reason: "computer_unsigned_origin" });
    expect(h.c.gate("other", "local")).toEqual({ allow: false, reason: "computer_not_attached" });
    h.c.end("s1");
    await expect(h.c.call("tok_1", "click", {})).rejects.toMatchObject({ code: "unknown_session" });
  });

  it("rate-limits actions per session (wait doesn't count) and audits the limit once a minute", async () => {
    const h = setup({ policy: { enabled: true, maxActionsPerMinute: 3 } });
    await granted(h);
    await h.c.call("tok_1", "click", {});
    await h.c.call("tok_1", "click", {});
    await expect(h.c.call("tok_1", "click", {})).rejects.toMatchObject({ code: "rate_limited" });
    await expect(h.c.call("tok_1", "click", {})).rejects.toMatchObject({ code: "rate_limited" });
    await h.c.call("tok_1", "wait", { ms: 100 });
    expect(h.actions().filter((a) => a.meta.reason === "rate_limited")).toHaveLength(1);
    h.advance(20_000);
    h.c.heartbeat(true);
    await expect(h.c.call("tok_1", "click", {})).resolves.toEqual({ text: "ok" });
  });

  it("maps screenshot pixels back to the screen (HiDPI downscale)", async () => {
    const h = setup();
    await granted(h, "screenshot", {});
    // 1440×900 points captured at 2880×1800 → shown at 1280×800.
    await h.c.call("tok_1", "click", { x: 640, y: 400 });
    expect(h.ops).toContainEqual(["move", 720, 450]);
    await h.c.call("tok_1", "scroll", { dy: 3 });
    expect(h.ops).toContainEqual(["scroll", 0, -3]);
  });
});

describe("computer control audit", () => {
  it("records metadata only: no typed text, image or window titles", async () => {
    const h = setup();
    await granted(h, "screenshot", {});
    await h.c.call("tok_1", "type_text", { text: "hunter2 my password" });
    await h.c.call("tok_1", "list_windows", {});
    await h.c.call("tok_1", "focus_window", { id: 7 });
    await expect(h.c.call("tok_1", "focus_window", { id: 99 })).rejects.toMatchObject({ code: "no_window" });
    const dump = JSON.stringify(h.audits);
    expect(dump).not.toContain("hunter2");
    expect(dump).not.toContain("secret title");
    expect(dump).not.toMatch(/iVBOR|base64|"data"/);
    expect(h.actions().map((a) => [a.meta.tool, a.meta.ok])).toEqual([
      ["screenshot", true],
      ["type_text", true],
      ["list_windows", true],
      ["focus_window", true],
      ["focus_window", false],
    ]);
    expect(h.actions()[1]!.meta).toMatchObject({ sid: "s1", textLength: 19 });
    expect(
      h.ops
        .filter((o) => o[0] === "type")
        .map((o) => o[1])
        .join(""),
    ).toBe("hunter2 my password");
  });

  it("bad arguments and unknown tools are refused and audited, never run", async () => {
    const h = setup();
    await granted(h);
    await expect(h.c.call("tok_1", "rm", {})).rejects.toMatchObject({ code: "bad_tool" });
    await expect(h.c.call("tok_1", "click", { x: 1 })).rejects.toMatchObject({ code: "bad_args" });
    expect(h.actions().filter((a) => a.meta.ok === false)).toHaveLength(2);
  });
});

describe("kill switch", () => {
  it("ends control now: grants revoked, sessions interrupted, later calls refused", async () => {
    const h = setup();
    await granted(h);
    expect(await h.c.kill("hotkey")).toBe(1);
    expect(h.interrupted).toEqual(["s1"]);
    expect(h.c.status().active).toEqual([]);
    await expect(h.c.call("tok_1", "click", {})).rejects.toMatchObject({ code: "revoked" });
    expect(h.c.gate("s1", "local")).toEqual({ allow: false, reason: "computer_revoked" });
    expect(h.audits.find((a) => a.type === "computer.killed")).toMatchObject({ meta: { by: "hotkey", sessions: 1 } });
    expect(h.published.at(-1)).toEqual({ enabled: true, activeSessions: 0, by: "hotkey" });
  });

  it("stops typing mid-text and releases a held button", async () => {
    const h = setup();
    await granted(h);
    h.hooks.after = (op) => {
      if (op[0] === "type") void h.c.kill("tray");
    };
    const typing = h.c.call("tok_1", "type_text", { text: "x".repeat(200) });
    await expect(typing).rejects.toMatchObject({ code: "revoked" });
    const typed = h.ops
      .filter((o) => o[0] === "type")
      .map((o) => o[1] as string)
      .join("");
    expect(typed.length).toBeGreaterThan(0);
    expect(typed.length).toBeLessThan(200);

    const h2 = setup();
    await granted(h2);
    h2.hooks.after = (op) => {
      if (op[0] === "button" && op[1] === true) void h2.c.kill("hotkey");
    };
    const drag = h2.c.call("tok_1", "drag", { fromX: 0, fromY: 0, toX: 100, toY: 100 });
    await expect(drag).rejects.toMatchObject({ code: "revoked" });
    expect(h2.ops.filter((o) => o[0] === "button")).toEqual([
      ["button", true, "left"],
      ["button", false, "left"],
    ]);
  });

  it("an approval that arrives after the kill grants nothing", async () => {
    const h = setup();
    attached(h);
    const call = h.c.call("tok_1", "click", {});
    await new Promise((r) => setTimeout(r, 0));
    await h.c.kill("panel");
    h.allow();
    await expect(call).rejects.toMatchObject({ code: "revoked" });
    expect(h.ops).toEqual([]);
    expect(h.audits.some((a) => a.type === "computer.granted")).toBe(false);
  });

  it("turning it off in the policy kills active control", async () => {
    const h = setup();
    await granted(h);
    h.setPolicy({ enabled: false, maxActionsPerMinute: 60 });
    await h.c.onPolicyChange();
    expect(h.interrupted).toEqual(["s1"]);
    await expect(h.c.call("tok_1", "click", {})).rejects.toMatchObject({ code: "disabled" });
  });
});

describe("enabling is local-only (OS auth + confirmations)", () => {
  const holder = (initial: Policy = DEFAULT_POLICY) => {
    let p = initial;
    return { get: () => p, set: async (n: Policy) => void (p = n) };
  };
  const answers = (o: { os?: boolean; first?: boolean; second?: boolean; typed?: string } = {}) => {
    const asked: string[] = [];
    return {
      asked,
      osAuth: { verify: async () => (asked.push("os"), o.os ?? true) },
      prompter: {
        first: async () => (asked.push("first"), o.first ?? true),
        second: async () => (asked.push("second"), o.second ?? true),
        typed: async () => (asked.push("typed"), o.typed ?? COMPUTER_COPY.es.phrase),
      },
    };
  };

  it("OS auth first, then two confirmations and the typed phrase", async () => {
    const policy = holder();
    const a = answers();
    const events: string[] = [];
    expect(await enableComputer({ policy, ...a, locale: "es", emit: (t) => void events.push(t) })).toEqual({
      ok: true,
    });
    expect(a.asked).toEqual(["os", "first", "second", "typed"]);
    expect(policy.get().computer).toEqual({ enabled: true, maxActionsPerMinute: 60 });
    expect(events).toEqual(["computer.enabled"]);
    expect(await disableComputer({ policy, emit: () => undefined }, "cli")).toBe(true);
    expect(policy.get().computer).toEqual({ enabled: false, maxActionsPerMinute: 60 });
  });

  for (const [step, o, reason] of [
    ["OS auth", { os: false }, "os_auth_failed"],
    ["first confirmation", { first: false }, "cancelled"],
    ["second confirmation", { second: false }, "cancelled"],
    ["wrong phrase", { typed: "controlar" }, "cancelled"],
  ] as const) {
    it(`a failed ${step} changes nothing`, async () => {
      const policy = holder();
      const res = await enableComputer({ policy, ...answers(o), locale: "es", emit: () => undefined });
      expect(res).toEqual({ ok: false, reason });
      expect(policy.get().computer).toBeUndefined();
    });
  }

  it("remote tightening can turn it off or slow it down, never on or faster", () => {
    const off = DEFAULT_POLICY;
    const on: Policy = { ...DEFAULT_POLICY, computer: { enabled: true, maxActionsPerMinute: 60 } };
    expect(applyRemoteTighten(off, { computer: { enabled: true, maxActionsPerMinute: 60 } })).toEqual({
      ok: false,
      reason: "would_loosen",
    });
    expect(applyRemoteTighten(on, { computer: { enabled: true, maxActionsPerMinute: 600 } })).toMatchObject({
      ok: false,
    });
    expect(applyRemoteTighten(on, { computer: { enabled: false } })).toMatchObject({
      ok: true,
      policy: { computer: { enabled: false, maxActionsPerMinute: 60 } },
    });
    expect(applyRemoteTighten(on, { computer: { maxActionsPerMinute: 10 } })).toMatchObject({ ok: true });
    expect(isTighterOrEqual(on, off)).toBe(false);
    expect(isTighterOrEqual(off, on)).toBe(true);
  });
});

// ---- app control (engine contract: AI driving desktop / web apps) -------------------------

describe("app control through the computer MCP", () => {
  const appsFake = () => {
    const launched: { appId: string; opts: unknown }[] = [];
    const apps: NonNullable<ComputerDeps["apps"]> = {
      list: () => [
        { id: "chatgpt", name: "ChatGPT", kind: "web-app" },
        { id: "claude-desktop", name: "Claude", kind: "desktop-app" },
      ],
      has: (id, kind) =>
        (id === "chatgpt" && (!kind || kind === "web-app")) || (id === "claude-desktop" && kind !== "web-app"),
      launch: async (appId, opts) => {
        launched.push({ appId, opts });
        if (opts?.url && !opts.url.startsWith("https://chatgpt.com/"))
          return { ok: false, reason: "origin_not_allowed" };
        return { ok: true };
      },
    };
    return { apps, launched };
  };

  it("each app needs its own app_control approval (HIGH via the core); it also grants control", async () => {
    const { apps, launched } = appsFake();
    const h = setup({ apps });
    attached(h);
    const first = h.c.call("tok_1", "launch_app", { appId: "claude-desktop" });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatchObject({
      sid: "s1",
      input: {
        kind: "app_control",
        origin: "client:dev_phone",
        details: { toolName: "app_control", input: { app: "claude-desktop" } },
      },
    });
    expect(launched).toEqual([]);
    h.allow();
    await expect(first).resolves.toEqual({ text: "ok" });
    expect(launched).toEqual([{ appId: "claude-desktop", opts: {} }]);
    // Approving the app grants the session control: screenshots and clicks don't ask again.
    await h.c.call("tok_1", "click", { x: 1, y: 1 });
    expect(h.asked).toHaveLength(1);
    // Another app asks again.
    const second = h.c.call("tok_1", "open_web_app", { appId: "chatgpt", url: "https://chatgpt.com/c/42?q=secret" });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.asked).toHaveLength(2);
    h.allow();
    await expect(second).resolves.toEqual({ text: "ok" });
    const audit = h.actions().find((a) => a.meta.tool === "open_web_app")!;
    expect(audit.meta).toMatchObject({ appId: "chatgpt", urlOrigin: "https://chatgpt.com" });
    expect(JSON.stringify(h.audits)).not.toContain("secret");
    expect(h.audits.map((a) => a.type)).toContain("computer.app_granted");
  });

  it("only the person's recipes; other sites refused; a deny sticks for that app", async () => {
    const { apps, launched } = appsFake();
    const h = setup({ apps, approve: async () => ({ allow: false, reason: "signed_deny" }) });
    attached(h);
    await expect(h.c.call("tok_1", "launch_app", { appId: "notion" })).rejects.toMatchObject({ code: "unknown_app" });
    await expect(h.c.call("tok_1", "open_web_app", { appId: "claude-desktop" })).rejects.toMatchObject({
      code: "unknown_app",
    });
    await expect(h.c.call("tok_1", "launch_app", { appId: "chatgpt" })).rejects.toMatchObject({ code: "app_denied" });
    await expect(h.c.call("tok_1", "launch_app", { appId: "chatgpt" })).rejects.toMatchObject({ code: "app_denied" });
    expect(h.asked).toHaveLength(1);
    expect(launched).toEqual([]);

    const ok = setup({ apps, approve: async () => ({ allow: true, reason: "signed_allow" }) });
    attached(ok);
    await expect(
      ok.c.call("tok_1", "open_web_app", { appId: "chatgpt", url: "https://evil.example/" }),
    ).rejects.toMatchObject({ code: "origin_not_allowed" });
  });

  it("honors every computer-control gate: off, unsigned, no desktop, kill", async () => {
    const { apps, launched } = appsFake();
    const off = setup({ apps, policy: undefined });
    off.c.attach("s1", { label: "x", adapter: "claude-code", origin: "client:p" });
    await expect(off.c.call("tok_1", "launch_app", { appId: "chatgpt" })).rejects.toMatchObject({
      code: "unknown_session",
    });
    const h = setup({ apps });
    h.c.attach("s1", { label: "x", adapter: "claude-code", origin: "client:p" });
    await expect(h.c.call("tok_1", "launch_app", { appId: "chatgpt" })).rejects.toMatchObject({ code: "no_desktop" });
    h.c.heartbeat(true);
    const pending = h.c.call("tok_1", "launch_app", { appId: "chatgpt" });
    await new Promise((r) => setTimeout(r, 0));
    await h.c.kill("hotkey");
    h.allow();
    await expect(pending).rejects.toMatchObject({ code: "revoked" });
    expect(launched).toEqual([]);
  });

  it("list_apps needs no grant and lists only recipes", async () => {
    const { apps } = appsFake();
    const h = setup({ apps });
    attached(h);
    const r = await h.c.call("tok_1", "list_apps", {});
    expect(JSON.parse(r.text)).toEqual(apps.list());
    expect(h.asked).toEqual([]);
  });
});
