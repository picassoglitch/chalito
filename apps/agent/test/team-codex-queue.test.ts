import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamHub } from "../src/team/hub.js";
import { runTeamMcp } from "../src/team/mcp.js";
import { selectDelivery } from "../src/team/delivery/index.js";
import { codexQueue, codexThreadFrom, envThread, queueArgs, queueText } from "../src/team/delivery/codex-queue.js";
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
const client = (
  path: string,
  provider: string,
  opts: { env?: string; queue?: Queue; channel?: boolean; optIn?: boolean | null } = {},
) => {
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
      // null: leave it unset, as cli.ts does without CHALITO_TEAM_CODEX_QUEUE=1.
      ...(opts.optIn === null ? {} : { codexQueueOptIn: opts.optIn ?? true }),
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
        messages: { seq: number; text: string; queued?: boolean }[];
      };
    },
    end: () => input.end(),
  };
};

const turnMeta = (thread: string) => ({ "x-codex-turn-metadata": JSON.stringify({ thread_id: thread, turn_id: "t" }) });

describe("codex queue delivery over the real socket and stdio", () => {
  it("queues a request into the reported thread once; it stays unread, flagged queued, until team_read", async () => {
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
      // Exit 0 means queued, not seen: the hub still holds it, and team_read says it was already queued.
      const read = await codex.tool("team_read", {}, turnMeta(T1));
      expect(read.messages).toMatchObject([{ text: "Run </x> please\nline two", queued: true }]);
      expect((await codex.tool("team_read", {}, turnMeta(T1))).messages).toEqual([]);
      // A later message is queued on its own; the first is never queued again.
      await claude.tool("team_send", { to: codexId, kind: "request", text: "second" });
      await vi.waitFor(() => expect(queue).toHaveBeenCalledTimes(2));
      expect(queue.mock.calls[1]![1]).toContain("> second");
      expect(queue.mock.calls[1]![1]).not.toContain("line two");
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

  it("a failed codex queue leaves the messages unread, unflagged, for team_read", async () => {
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
      const read = (await codex.tool("team_read")).messages;
      expect(read.map((m) => [m.text, m.queued])).toEqual([["first", undefined]]);
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

  it("is off unless opted in: a reported thread is ignored and Codex pulls", async () => {
    const r = await rig();
    const queue = vi.fn<Queue>(async () => true);
    const codex = client(r.path, "codex", { queue, env: T1, optIn: false });
    const claude = client(r.path, "claude");
    try {
      await codex.init();
      await claude.init();
      await codex.tool("team_read", {}, turnMeta(T1));
      await vi.waitFor(() => expect(codex.errors()).toContain("delivery pull"));
      await claude.tool("team_send", { kind: "request", text: "pull me" });
      await new Promise((res) => setTimeout(res, 120));
      expect(queue).not.toHaveBeenCalled();
      expect((await codex.tool("team_read")).messages.map((m) => m.text)).toEqual(["pull me"]);
    } finally {
      codex.end();
      claude.end();
      await Promise.all([codex.done, claude.done]);
      await r.close();
    }
  });

  it("a batch waiting behind a slow queue is dropped to team_read when a thread conflict appears meanwhile", async () => {
    const r = await rig();
    let release = () => undefined as void;
    const gate = new Promise<void>((res) => (release = res));
    const queue = vi.fn<Queue>(async () => {
      await gate;
      return true;
    });
    const codex = client(r.path, "codex", { queue });
    const claude = client(r.path, "claude");
    try {
      await codex.init();
      await claude.init();
      await codex.tool("team_read", {}, turnMeta(T1));
      await vi.waitFor(() => expect(codex.errors()).toContain("delivery codex-queue"));
      await claude.tool("team_send", { kind: "request", text: "one" });
      await vi.waitFor(() => expect(queue).toHaveBeenCalledTimes(1));
      await claude.tool("team_send", { kind: "request", text: "two" });
      const pushes = () => r.audit.mock.calls.filter(([t, m]) => t === "team.delivered" && m.adapter === "codex-queue");
      await vi.waitFor(() => expect(pushes()).toHaveLength(2));
      await new Promise((res) => setTimeout(res, 80));
      // "two" waits in the chain behind "one"; a second thread shows up first. That read returns both: nothing is lost.
      const read = (await codex.tool("team_read", {}, turnMeta(T2))).messages;
      expect(read.map((m) => m.text)).toEqual(["one", "two"]);
      await vi.waitFor(() => expect(codex.errors()).toContain("more than one Codex thread"));
      release();
      await vi.waitFor(() => expect(codex.errors()).toContain("codex queue failed"));
      expect(queue).toHaveBeenCalledTimes(1);
    } finally {
      codex.end();
      claude.end();
      await Promise.all([codex.done, claude.done]);
      await r.close();
    }
  });

  it("with the opt-in unset (the default), a reported thread never selects codex queue", async () => {
    const r = await rig();
    const queue = vi.fn<Queue>(async () => true);
    const codex = client(r.path, "codex", { queue, env: T1, optIn: null });
    const claude = client(r.path, "claude");
    try {
      await codex.init();
      await claude.init();
      await codex.tool("team_read", {}, turnMeta(T1));
      await claude.tool("team_send", { kind: "request", text: "default" });
      await new Promise((res) => setTimeout(res, 120));
      expect(queue).not.toHaveBeenCalled();
      expect(codex.errors()).not.toContain("codex-queue");
      expect(r.audit).not.toHaveBeenCalledWith(
        "team.delivery_selected",
        expect.objectContaining({ adapter: "codex-queue" }),
      );
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

  it("never cuts: a batch too big for one argument is not queued", () => {
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
    expect(queueText(batch)).toBeNull();
    expect(queueText({ ...batch, messages: batch.messages.slice(0, 2) })).toContain("> xxx");
  });
});

describe("codex queue durability at the hub", () => {
  it("a queued message stays unread through a disconnect and rejoin, and is not queued again", () => {
    vi.useFakeTimers();
    try {
      const frames: TeamBatch[] = [];
      const link = { push: (f: { teamDelivery: { batch: TeamBatch } }) => (frames.push(f.teamDelivery.batch), true) };
      const hub = new TeamHub(
        workspaceFor,
        () => Date.now(),
        () => true,
        {
          pacing: { debounceMs: 10, minGapMs: 0 },
          chain: [codexQueue],
        },
      );
      const c = new AbortController();
      const s = new AbortController();
      const joined = hub.call(c.signal, "team_join", { provider: "codex", cwd: "/project" }, link) as {
        result: { self: string };
      };
      expect(hub.call(c.signal, "team_client", { codexThread: T1 })).toMatchObject({
        result: { delivery: "codex-queue" },
      });
      hub.call(s.signal, "team_join", { provider: "claude", cwd: "/project" });
      hub.call(s.signal, "team_send", { kind: "request", text: "keep me" });
      vi.advanceTimersByTime(20);
      expect(frames.map((b) => b.messages.map((m) => m.text))).toEqual([["keep me"]]);
      // The mcp process dies right after `codex queue` accepted it.
      c.abort();
      const again = new AbortController();
      hub.call(again.signal, "team_join", { provider: "codex", cwd: "/project", resume: joined.result.self }, link);
      hub.call(again.signal, "team_client", { codexThread: T1 });
      vi.advanceTimersByTime(20);
      expect(frames).toHaveLength(1);
      const read = hub.call(again.signal, "team_read", {}) as { result: { messages: { text: string }[] } };
      expect(read.result.messages.map((m) => m.text)).toEqual(["keep me"]);
      expect((hub.call(again.signal, "team_read", {}) as { result: { messages: [] } }).result.messages).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
