import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamHub } from "../src/team/hub.js";
import { runTeamMcp } from "../src/team/mcp.js";
import { selectDelivery } from "../src/team/delivery/index.js";
import {
  codexQueue,
  codexThreadFrom,
  envThread,
  queueArgs,
  queueText,
  runCodexQueue,
} from "../src/team/delivery/codex-queue.js";
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
  opts: { env?: string; queue?: Queue; channel?: boolean; optIn?: boolean | null; platform?: NodeJS.Platform } = {},
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
      ...(opts.queue
        ? {
            codexQueue: async (t: string, x: string) =>
              (await opts.queue!(t, x)) ? ({ ok: true } as const) : ({ ok: false, reason: "test refused" } as const),
          }
        : {}),
      ...(opts.platform ? { platform: opts.platform } : {}),
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
      // "two" was already handed over by that read, so it is neither queued nor reported as failed.
      await new Promise((res) => setTimeout(res, 120));
      expect(queue).toHaveBeenCalledTimes(1);
      expect(r.audit).not.toHaveBeenCalledWith("team.delivery_failed", expect.anything());
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
    // Shape captured from a real codex-cli 0.166.0 tools/call (ids replaced).
    const real = {
      callId: "exec-95ce074d-727c-41b9-b8b5-c6894a73631c",
      "x-codex-turn-metadata": { session_id: T1, thread_id: T1, turn_id: T2, turn_trigger: "exec" },
      threadId: T1,
      sessionId: T1,
    };
    expect(codexThreadFrom(real)).toBe(T1);
    expect(codexThreadFrom({ "x-codex-turn-metadata": { thread_id: T1 } })).toBe(T1);
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

describe("codex queue failure feedback, batching and reservations", () => {
  const hubRig = (responder?: { has: () => boolean; run: () => Promise<string | null> }) => {
    vi.useFakeTimers();
    const audit = vi.fn();
    const frames: TeamBatch[][] = [[], []];
    const links = [0, 1].map((i) => ({
      push: (f: { teamDelivery: { batch: TeamBatch } }) => (frames[i]!.push(f.teamDelivery.batch), true),
    }));
    const hub = new TeamHub(
      workspaceFor,
      () => Date.now(),
      () => true,
      {
        pacing: { debounceMs: 10, minGapMs: 0 },
        chain: [codexQueue],
        audit,
        ...(responder ? { responder } : {}),
      },
    );
    const join = (i: number, thread: string) => {
      const c = new AbortController();
      hub.call(c.signal, "team_join", { provider: "codex", cwd: "/project" }, links[i]!);
      hub.call(c.signal, "team_client", { codexThread: thread });
      return c;
    };
    const s = new AbortController();
    hub.call(s.signal, "team_join", { provider: "claude", cwd: "/project" });
    const send = (to: string | undefined, text: string) =>
      expect(hub.call(s.signal, "team_send", { ...(to ? { to } : {}), kind: "request", text }).ok).toBe(true);
    return { hub, audit, frames, join, send };
  };
  afterEach(() => vi.useRealTimers());

  it("a failed queue reported back is pushed again, and lets the responder take a request to codex by name", () => {
    const run = vi.fn(async () => "answered by CLI");
    const r = hubRig({ has: () => true, run });
    const c = r.join(0, T1);
    r.send("codex", "do it");
    vi.advanceTimersByTime(20);
    expect(r.frames[0]!.map((b) => b.messages.map((m) => m.text))).toEqual([["do it"]]);
    // Healthy wakeable session: no CLI run.
    expect(run).not.toHaveBeenCalled();
    const seq = r.frames[0]![0]!.messages[0]!.seq;
    expect(r.hub.call(c.signal, "team_delivery", { seqs: [seq], ok: false })).toMatchObject({ ok: true });
    expect(r.audit).toHaveBeenCalledWith("team.delivery_failed", expect.objectContaining({ seqs: [seq] }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a failed queue with no responder is retried at the paced rate", () => {
    const r = hubRig();
    const c = r.join(0, T1);
    r.send(undefined, "retry me");
    vi.advanceTimersByTime(20);
    const seq = r.frames[0]![0]!.messages[0]!.seq;
    r.hub.call(c.signal, "team_delivery", { seqs: [seq], ok: false });
    vi.advanceTimersByTime(20);
    expect(r.frames[0]!.map((b) => b.messages.map((m) => m.seq))).toEqual([[seq], [seq]]);
    // Reported ok: never pushed again.
    r.hub.call(c.signal, "team_delivery", { seqs: [seq], ok: true });
    vi.advanceTimersByTime(1000);
    expect(r.frames[0]).toHaveLength(2);
    expect(r.hub.call(c.signal, "team_delivery", { seqs: ["x"], ok: false })).toMatchObject({ error: "bad_params" });
  });

  it("more than one batch: every seq is queued once, in order", () => {
    const r = hubRig();
    r.join(0, T1);
    for (let n = 0; n < 10; n++) r.send(undefined, `r${n}`);
    vi.advanceTimersByTime(200);
    expect(r.frames[0]!.map((b) => b.messages.map((m) => m.text))).toEqual([
      ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"],
      ["r8", "r9"],
    ]);
  });

  it("a request to codex by name is reserved for one session; another gets it only after a failure or leave", () => {
    const r = hubRig();
    const a = r.join(0, T1);
    r.join(1, T2);
    r.send("codex", "only once");
    vi.advanceTimersByTime(20);
    const got = () => r.frames.map((f) => f.flatMap((b) => b.messages.map((m) => m.text)));
    // The first session to flush reserves it; the other is never pushed it while that one is healthy.
    expect(got()).toEqual([["only once"], []]);
    r.send(undefined, "nudge");
    vi.advanceTimersByTime(20);
    expect(got()[1]).toEqual(["nudge"]);
    // The reserving session left: the other session is pushed it with no further traffic.
    a.abort();
    vi.advanceTimersByTime(20);
    expect(got()[1]).toEqual(["nudge", "only once"]);
  });
});

describe("codex queue on the Codex side", () => {
  it("the queued text names each seq; three failures switch the session to pull", async () => {
    const r = await rig();
    const queue = vi.fn<Queue>(async () => false);
    const codex = client(r.path, "codex", { queue, env: T1 });
    const claude = client(r.path, "claude");
    try {
      await codex.init();
      await claude.init();
      await vi.waitFor(() => expect(codex.errors()).toContain("bound to thread"));
      await claude.tool("team_send", { kind: "request", text: "a" });
      await vi.waitFor(() => expect(codex.errors()).toContain("codex queue off for this session (3 failed attempts"), {
        timeout: 4000,
      });
      expect(queue.mock.calls[0]![1]).toMatch(/^\[Chalito team seq \d+\]\n/);
      expect(codex.errors()).toContain("codex queue failed (test refused)");
      await vi.waitFor(() => expect(codex.errors()).toMatch(/delivery pull \(call team_read\)\.\n[^]*$/));
      const calls = queue.mock.calls.length;
      await claude.tool("team_send", { kind: "request", text: "b" });
      await new Promise((res) => setTimeout(res, 150));
      expect(queue.mock.calls.length).toBe(calls);
      expect((await codex.tool("team_read")).messages.map((m) => m.text)).toEqual(["a", "b"]);
    } finally {
      codex.end();
      claude.end();
      await Promise.all([codex.done, claude.done]);
      await r.close();
    }
  });

  it("a batch team_read already returned is not queued afterwards", async () => {
    const r = await rig();
    let release = () => undefined as void;
    const gate = new Promise<void>((res) => (release = res));
    const queue = vi.fn<Queue>(async () => {
      await gate;
      return true;
    });
    const codex = client(r.path, "codex", { queue, env: T1 });
    const claude = client(r.path, "claude");
    try {
      await codex.init();
      await claude.init();
      await vi.waitFor(() => expect(codex.errors()).toContain("delivery codex-queue"));
      await claude.tool("team_send", { kind: "request", text: "one" });
      await vi.waitFor(() => expect(queue).toHaveBeenCalledTimes(1));
      await claude.tool("team_send", { kind: "request", text: "two" });
      const pushes = () => r.audit.mock.calls.filter(([t, m]) => t === "team.delivered" && m.adapter === "codex-queue");
      await vi.waitFor(() => expect(pushes()).toHaveLength(2));
      expect((await codex.tool("team_read", {}, turnMeta(T1))).messages.map((m) => m.text)).toEqual(["one", "two"]);
      release();
      await new Promise((res) => setTimeout(res, 120));
      expect(queue).toHaveBeenCalledTimes(1);
    } finally {
      codex.end();
      claude.end();
      await Promise.all([codex.done, claude.done]);
      await r.close();
    }
  });

  it("a by-name request released by another session is queued even after this session read newer messages", async () => {
    const r = await rig();
    const qa = vi.fn<Queue>(async () => true);
    const qb = vi.fn<Queue>(async () => true);
    const a = client(r.path, "codex", { queue: qa, env: T1 });
    const b = client(r.path, "codex", { queue: qb, env: T2 });
    const claude = client(r.path, "claude");
    try {
      await a.init();
      await b.init();
      await claude.init();
      await vi.waitFor(() => expect(a.errors() + b.errors()).toMatch(/delivery codex-queue[^]*delivery codex-queue/));
      await claude.tool("team_send", { to: "codex", kind: "request", text: "by name" });
      await vi.waitFor(() => expect(qa.mock.calls.length + qb.mock.calls.length).toBe(1));
      const [owner, other, otherQueue] = qa.mock.calls.length ? [a, b, qb] : [b, a, qa];
      // The other session reads a newer broadcast, so it has seen a higher seq than the by-name request.
      await claude.tool("team_send", { kind: "status", text: "newer" });
      expect((await other.tool("team_read")).messages.map((m) => m.text)).toEqual(["newer"]);
      owner.end();
      await owner.done;
      await vi.waitFor(() => expect(otherQueue).toHaveBeenCalledTimes(1));
      expect(otherQueue.mock.calls[0]![1]).toContain("> by name");
    } finally {
      a.end();
      b.end();
      claude.end();
      await Promise.all([a.done, b.done, claude.done]);
      await r.close();
    }
  });

  it("is never on for Windows", async () => {
    const r = await rig();
    const queue = vi.fn<Queue>(async () => true);
    const codex = client(r.path, "codex", { queue, env: T1, platform: "win32" });
    try {
      await codex.init();
      await vi.waitFor(() => expect(codex.errors()).toContain("not available on Windows"));
      expect(codex.errors()).not.toContain("codex-queue");
    } finally {
      codex.end();
      await codex.done;
      await r.close();
    }
  });
});

describe("runCodexQueue against a real process", () => {
  const withStub = async (script: string, body: (log: string) => Promise<void>) => {
    const dir = mkdtempSync(joinPath(tmpdir(), "chalito-codex-stub-"));
    dirs.push(dir);
    const log = joinPath(dir, "argv");
    writeFileSync(joinPath(dir, "codex"), `#!/bin/sh\nprintf '%s\\0' "$@" > "${log}"\n${script}\n`);
    chmodSync(joinPath(dir, "codex"), 0o755);
    const old = process.env.PATH;
    process.env.PATH = `${dir}:${old}`;
    try {
      await body(log);
    } finally {
      process.env.PATH = old;
    }
  };

  it.skipIf(process.platform === "win32")(
    "passes exactly three arguments, text as one value, never --resume",
    async () => {
      await withStub("exit 0", async (log) => {
        const text = "--resume\nlínea 2 ✓ &lt;x&gt;";
        expect(await runCodexQueue(T1, text)).toEqual({ ok: true });
        expect(readFileSync(log, "utf8").split("\0").slice(0, -1)).toEqual([
          "queue",
          `--thread=${T1}`,
          `--message=${text}`,
        ]);
      });
    },
  );

  it.skipIf(process.platform === "win32")("reports the exit and first stderr line on failure", async () => {
    await withStub("echo 'error: unknown thread' >&2; exit 3", async () => {
      expect(await runCodexQueue(T1, "x")).toEqual({ ok: false, reason: "3: error: unknown thread" });
    });
  });

  it.skipIf(process.platform === "win32")(
    "a missing binary or an oversized argument resolves, never throws",
    async () => {
      const old = process.env.PATH;
      process.env.PATH = "/nonexistent";
      try {
        expect(await runCodexQueue(T1, "x")).toMatchObject({ ok: false, reason: "ENOENT" });
      } finally {
        process.env.PATH = old;
      }
      await withStub("exit 0", async () => {
        const r = await runCodexQueue(T1, "é".repeat(200_000));
        expect(r.ok).toBe(false);
      });
    },
  );

  it("measures the size in bytes: multibyte text that fits in characters is still refused", () => {
    const msg = (seq: number) => ({
      workspace: "w",
      seq,
      from: "f",
      provider: "claude",
      kind: "request" as const,
      text: "漢".repeat(8000),
      at: 0,
    });
    const batch: TeamBatch = {
      workspace: "w",
      historyTruncated: false,
      more: 0,
      messages: [1, 2, 3, 4, 5, 6, 7, 8].map(msg),
    };
    expect(queueText(batch)).toBeNull();
    expect(queueText({ ...batch, messages: batch.messages.slice(0, 2) })).toContain("[Chalito team seq 1]");
  });
});
