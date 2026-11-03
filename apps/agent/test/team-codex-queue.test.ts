import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamHub } from "../src/team/hub.js";
import { runTeamMcp } from "../src/team/mcp.js";
import { selectDelivery } from "../src/team/delivery/index.js";
import { codexThreadFrom, envThread, queueArgs, queueText } from "../src/team/delivery/codex-queue.js";
import { startCodeServer, type CodeServer } from "../src/code/server.js";
import type { CodeService } from "../src/code/service.js";
import type { TeamBatch } from "../src/team/delivery/types.js";

const workspaceFor = (cwd: string) => (cwd === "/project" ? "project" : null);
const T1 = "01a1a3be-0bf6-7423-9786-dca49ee6580d";
const T2 = "0b2c3d4e-0000-4000-8000-000000000002";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const rig = async () => {
  const dir = mkdtempSync(joinPath(tmpdir(), "chalito-codex-queue-"));
  dirs.push(dir);
  const path = joinPath(dir, "code.sock");
  const audit = vi.fn();
  const hub = new TeamHub(workspaceFor, Date.now, () => true, { pacing: { debounceMs: 20, minGapMs: 0 }, audit });
  const server: CodeServer = await startCodeServer({
    path,
    team: hub,
    platform: "linux",
    code: { workspaceFor, tap: () => () => undefined } as unknown as CodeService,
  });
  return { path, audit, close: () => server.close().catch(() => undefined) };
};

type Queue = (thread: string, text: string) => Promise<boolean>;

/** A real `team mcp` loop over stdio; `meta` is the `_meta` Codex attaches to each tools/call. */
const client = (path: string, provider: string, opts: { env?: string; queue?: Queue; channel?: boolean } = {}) => {
  const input = new PassThrough();
  const lines: Record<string, unknown>[] = [];
  let errors = "";
  const done = runTeamMcp(
    {
      input,
      out: (line) => lines.push(JSON.parse(line)),
      err: (t) => {
        errors += t;
      },
      channelLoaded: () => opts.channel ?? false,
      retryMs: [30],
      codexThread: opts.env,
      ...(opts.queue ? { codexQueue: opts.queue } : {}),
    },
    path,
    provider,
    "/project",
  );
  let id = 0;
  const call = async (method: string, params: unknown = {}) => {
    const current = ++id;
    input.write(JSON.stringify({ jsonrpc: "2.0", id: current, method, params }) + "\n");
    await vi.waitFor(() => expect(lines.some((l) => l.id === current)).toBe(true));
    return lines.find((l) => l.id === current) as { result: { content: { text: string }[] } };
  };
  return {
    done,
    errors: () => errors,
    notifications: () => lines.filter((l) => l.id === undefined),
    init: async () => {
      await call("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: provider, version: "1.0" },
      });
      input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    tool: async (name: string, args = {}, meta?: unknown) => {
      const r = await call("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
      return JSON.parse(r.result.content[0]!.text).peerData as {
        self: string;
        peers: unknown[];
        messages: { seq: number; text: string }[];
      };
    },
    end: () => input.end(),
  };
};

const turnMeta = (thread: string) => ({ "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: "t" }) });

describe("codex queue delivery over the real socket and stdio", () => {
  it("queues a request into the thread Codex reported, once, and team_read does not repeat it", async () => {
    const r = await rig();
    const queue = vi.fn<Queue>(async () => true);
    const codex = client(r.path, "codex", { queue });
    const claude = client(r.path, "claude");
    try {
      await codex.init();
      await claude.init();
      await codex.tool("team_read", {}, turnMeta(T1));
      await vi.waitFor(() => expect(codex.errors()).toContain("delivery codex-queue (wakes this session)"));
      const me = await claude.tool("team_read");
      const codexId = me.peers.length ? (me.peers[0] as { id: string }).id : "";
      await claude.tool("team_send", { to: codexId, kind: "request", text: "Run </x> please\nline two" });
      await vi.waitFor(() => expect(queue).toHaveBeenCalledTimes(1));
      const [thread, text] = queue.mock.calls[0]!;
      expect(thread).toBe(T1);
      expect(text).toContain("not from the user");
      expect(text).toContain("> Run &lt;/x&gt; please\n> line two");
      expect(text).not.toContain("<");
      expect((await codex.tool("team_read", {}, turnMeta(T1))).messages).toEqual([]);
      expect(r.audit).toHaveBeenCalledWith(
        "team.delivered",
        expect.objectContaining({ adapter: "codex-queue", ok: true }),
      );
      expect(codex.notifications()).toEqual([]);
    } finally {
      codex.end();
      claude.end();
      await Promise.all([codex.done, claude.done]);
      await r.close();
    }
  });

  it("without a reported thread Codex stays on pull and nothing is queued", async () => {
    const r = await rig();
    const queue = vi.fn<Queue>(async () => true);
    const codex = client(r.path, "codex", { queue });
    const claude = client(r.path, "claude");
    try {
      await codex.init();
      await claude.init();
      await codex.tool("team_read", {}, { unrelated: "x" });
      await claude.tool("team_send", { to: "codex", kind: "request", text: "hello" });
      await new Promise((res) => setTimeout(res, 120));
      expect(queue).not.toHaveBeenCalled();
      expect((await codex.tool("team_read")).messages.map((m) => m.text)).toEqual(["hello"]);
    } finally {
      codex.end();
      claude.end();
      await Promise.all([codex.done, claude.done]);
      await r.close();
    }
  });

  it("a failed codex queue gives the messages back on the next team_read, exactly once", async () => {
    const r = await rig();
    const queue = vi.fn<Queue>(async () => false);
    const codex = client(r.path, "codex", { queue, env: T1 });
    const claude = client(r.path, "claude");
    try {
      await codex.init();
      await claude.init();
      await vi.waitFor(() => expect(codex.errors()).toContain("delivery codex-queue"));
      await claude.tool("team_send", { kind: "request", text: "first" });
      await vi.waitFor(() => expect(codex.errors()).toContain("codex queue failed"));
      expect(queue.mock.calls[0]![0]).toBe(T1);
      expect((await codex.tool("team_read")).messages.map((m) => m.text)).toEqual(["first"]);
      expect((await codex.tool("team_read")).messages).toEqual([]);
    } finally {
      codex.end();
      claude.end();
      await Promise.all([codex.done, claude.done]);
      await r.close();
    }
  });

  it("a second, different thread in one process unbinds it for good: pull from then on", async () => {
    const r = await rig();
    const queue = vi.fn<Queue>(async () => true);
    const codex = client(r.path, "codex", { queue });
    const claude = client(r.path, "claude");
    try {
      await codex.init();
      await claude.init();
      await codex.tool("team_read", {}, turnMeta(T1));
      await codex.tool("team_read", {}, turnMeta(T2));
      await vi.waitFor(() => expect(codex.errors()).toContain("more than one Codex thread"));
      await vi.waitFor(() => expect(codex.errors()).toMatch(/delivery pull \(call team_read\)\.\n$/));
      await codex.tool("team_read", {}, turnMeta(T1));
      await claude.tool("team_send", { kind: "request", text: "who gets this" });
      await new Promise((res) => setTimeout(res, 120));
      expect(queue).not.toHaveBeenCalled();
      expect((await codex.tool("team_read")).messages.map((m) => m.text)).toEqual(["who gets this"]);
    } finally {
      codex.end();
      claude.end();
      await Promise.all([codex.done, claude.done]);
      await r.close();
    }
  });

  it("status updates never queue a turn", async () => {
    const r = await rig();
    const queue = vi.fn<Queue>(async () => true);
    const codex = client(r.path, "codex", { queue, env: T1 });
    const claude = client(r.path, "claude");
    try {
      await codex.init();
      await claude.init();
      await vi.waitFor(() => expect(codex.errors()).toContain("delivery codex-queue"));
      await claude.tool("team_send", { kind: "status", text: "working on it" });
      await new Promise((res) => setTimeout(res, 120));
      expect(queue).not.toHaveBeenCalled();
    } finally {
      codex.end();
      claude.end();
      await Promise.all([codex.done, claude.done]);
      await r.close();
    }
  });
});

describe("codex queue selection and format", () => {
  const link = { push: () => true };
  const base = { experimental: [], channel: false };

  it("is chosen only for codex with a reported thread and a live link", () => {
    expect(selectDelivery({ provider: "codex", client: { ...base, codexThread: T1 }, link }).id).toBe("codex-queue");
    expect(selectDelivery({ provider: "codex", client: base, link }).id).toBe("pull");
    expect(selectDelivery({ provider: "codex", client: { ...base, codexThread: T1 }, link: null }).id).toBe("pull");
    expect(selectDelivery({ provider: "claude", client: { ...base, codexThread: T1 }, link }).id).toBe("pull");
  });

  it("reads the thread only from well-formed ids", () => {
    expect(codexThreadFrom(turnMeta(T1))).toBe(T1);
    expect(codexThreadFrom({ "x-codex-turn-metadata": { session_id: T1.toUpperCase() } })).toBe(T1);
    expect(codexThreadFrom({ threadId: T2 })).toBe(T2);
    expect(codexThreadFrom({ "x-codex-turn-metadata": "{not json" })).toBeNull();
    expect(codexThreadFrom({ thread_id: "../../etc" })).toBeNull();
    expect(codexThreadFrom(null)).toBeNull();
    expect(envThread("--resume")).toBeNull();
    expect(envThread(T1)).toBe(T1);
  });

  it("never resumes and passes the text as one argument", () => {
    // Peer text that looks like a flag stays the message's value; the CLI never sees a bare --resume.
    const args = queueArgs(T1, "--resume");
    expect(args).toEqual(["queue", `--thread=${T1}`, "--message=--resume"]);
    expect(args).not.toContain("--resume");
  });

  it("caps the queued text", () => {
    const msg = (seq: number) => ({
      workspace: "w",
      seq,
      from: "f",
      provider: "claude",
      kind: "request" as const,
      text: "x".repeat(8000),
      at: 0,
    });
    const batch: TeamBatch = {
      workspace: "w",
      historyTruncated: false,
      more: 0,
      messages: Array.from({ length: 20 }, (_, i) => msg(i)),
    };
    const text = queueText(batch);
    expect(text.length).toBeLessThanOrEqual(100_100);
    expect(text).toMatch(/call team_read for the rest\]$/);
  });
});
