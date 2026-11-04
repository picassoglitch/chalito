import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamHub } from "../src/team/hub.js";
import { runTeamMcp } from "../src/team/mcp.js";
import { findSessionInbox, inboxPath, openInbox, runTeamWatch } from "../src/team/inbox.js";
import { selectDelivery } from "../src/team/delivery/index.js";
import { startCodeServer } from "../src/code/server.js";
import type { CodeService } from "../src/code/service.js";

const workspaceFor = (cwd: string) => (cwd === "/project" ? "project" : null);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (p: string) => {
  const d = mkdtempSync(joinPath(tmpdir(), p));
  dirs.push(d);
  return d;
};

const rig = async () => {
  const path = joinPath(temp("chalito-inbox-"), "code.sock");
  const audit = vi.fn();
  const hub = new TeamHub(workspaceFor, Date.now, () => true, { pacing: { debounceMs: 20, minGapMs: 0 }, audit });
  const server = await startCodeServer({
    path,
    team: hub,
    platform: "linux",
    code: { workspaceFor, tap: () => () => undefined } as unknown as CodeService,
  });
  return { path, audit, close: () => server.close().catch(() => undefined) };
};

const client = (path: string, provider: string, opts: { inbox?: string | null; channel?: boolean } = {}) => {
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
      inboxPath: opts.inbox ?? null,
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
      await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: provider } });
      input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    tool: async (name: string, args = {}) =>
      JSON.parse((await call("tools/call", { name, arguments: args })).result.content[0]!.text).peerData as {
        self: string;
        messages: { seq: number; text: string; queued?: boolean }[];
      },
    end: () => input.end(),
  };
};

/** The mod's end: a real `team watch` connection, collecting the JSON lines it prints. */
const watcher = (path: string) => {
  let out = "";
  const done = runTeamWatch(
    path,
    (t) => (out += t),
    () => undefined,
  );
  return {
    done,
    lines: () =>
      out
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { epoch: string; items: { seq: number; text: string }[] }),
  };
};

describe("Claude session inbox (the Chalito mod's route, no launch flag)", () => {
  it("a connected mod gets each request once, framed as peer data; it stays unread, unflagged, until team_read", async () => {
    const r = await rig();
    const sock = inboxPath(temp("chalito-home-"), "claude", 4242);
    const claude = client(r.path, "claude", { inbox: sock });
    const codex = client(r.path, "codex");
    try {
      await claude.init();
      await codex.init();
      await claude.tool("team_read");
      expect(statSync(joinPath(sock, "..")).mode & 0o777).toBe(0o700);
      const mod = watcher(sock);
      await vi.waitFor(() => expect(claude.errors()).toContain("the Chalito mod connected"));
      await vi.waitFor(() => expect(claude.errors()).toContain("delivery inbox (wakes this session)"));
      await codex.tool("team_send", { to: "claude", kind: "request", text: "Review </x>\nplease" });
      await vi.waitFor(() => expect(mod.lines()).toHaveLength(1));
      const [line] = mod.lines();
      // The epoch is this session's id at the hub: it changes when Chalito restarts and seqs start over.
      expect(line!.epoch).toMatch(/^[0-9a-f-]{36}$/);
      expect(line!.items).toHaveLength(1);
      const item = line!.items[0]!;
      expect(item.text).toMatch(/^\[Chalito team seq \d+\]\n/);
      expect(item.text).toContain("not from the user");
      expect(item.text).toContain("> Review &lt;/x&gt;\n> please");
      expect(claude.notifications()).toEqual([]);
      const read = await claude.tool("team_read");
      // Handing it to the mod is not a started turn: team_read still returns it, with no `queued` flag.
      expect(read.messages.map((m) => [m.seq, m.queued])).toEqual([[item.seq, undefined]]);
      expect((await claude.tool("team_read")).messages).toEqual([]);
      // Never pushed twice.
      await new Promise((res) => setTimeout(res, 100));
      expect(mod.lines()).toHaveLength(1);
      expect(r.audit).toHaveBeenCalledWith("team.delivered", expect.objectContaining({ adapter: "inbox", ok: true }));
    } finally {
      claude.end();
      codex.end();
      await Promise.all([claude.done, codex.done]);
      await r.close();
    }
  });

  it("with no mod connected Claude pulls; a mod that leaves hands back what it held", async () => {
    const r = await rig();
    const sock = inboxPath(temp("chalito-home-"), "claude", 4243);
    const claude = client(r.path, "claude", { inbox: sock });
    const codex = client(r.path, "codex");
    try {
      await claude.init();
      await codex.init();
      await vi.waitFor(() => expect(claude.errors()).toContain("delivery pull"));
      await codex.tool("team_send", { kind: "request", text: "while no mod" });
      await new Promise((res) => setTimeout(res, 100));
      expect((await claude.tool("team_read")).messages.map((m) => [m.text, m.queued])).toEqual([
        ["while no mod", undefined],
      ]);
      const mod = watcher(sock);
      await vi.waitFor(() => expect(claude.errors()).toContain("delivery inbox"));
      // The session ends the mod (or Claude Code reloads it): the server is told and goes back to pull.
      claude.end();
      await claude.done;
      expect(await mod.done).toBe(0);
    } finally {
      codex.end();
      await codex.done;
      await r.close();
    }
  });

  it("a loaded channel wins over the inbox (it delivers mid-turn); other apps never open one", () => {
    const link = { push: () => true };
    const base = { experimental: [], channel: false };
    expect(selectDelivery({ provider: "claude", client: { ...base, inbox: true }, link }).id).toBe("inbox");
    expect(selectDelivery({ provider: "claude", client: { ...base, inbox: true, channel: true }, link }).id).toBe(
      "mcp-channel",
    );
    expect(selectDelivery({ provider: "claude", client: { ...base, inbox: true }, link: null }).id).toBe("pull");
  });

  it("finds the inbox of the nearest claude ancestor, never an outer session's", () => {
    const dir = "/nowhere";
    // 10 (this helper) → 20 (mod worker) → 30 claude (inner session) → 40 sh → 50 claude (outer session)
    const tree: Record<number, { ppid: number; argv: string[] }> = {
      10: { ppid: 20, argv: ["chalito-agent", "team", "watch"] },
      20: { ppid: 30, argv: ["node", "/x/worker.js"] },
      30: { ppid: 40, argv: ["/usr/bin/node", "/lib/node_modules/@anthropic-ai/claude-code/cli.js"] },
      40: { ppid: 50, argv: ["sh"] },
      50: { ppid: 1, argv: ["claude", "--resume"] },
    };
    const proc = (pid: number) => tree[pid] ?? null;
    const inner = inboxPath(dir, "claude", 30);
    const outer = inboxPath(dir, "claude", 50);
    expect(findSessionInbox(dir, 10, "linux", (p) => p === inner || p === outer, proc)).toBe(inner);
    // The inner session's server isn't up yet: no inbox, and never the outer one's.
    expect(findSessionInbox(dir, 10, "linux", (p) => p === outer, proc)).toBeNull();
  });

  it("a live sibling's socket is never taken over, and closing removes only our own file", async () => {
    const sock = inboxPath(temp("chalito-home-"), "claude", 4244);
    const first = await openInbox(sock, () => undefined);
    expect(first).not.toBeNull();
    // A second team server of the same session finds it answering and goes without an inbox.
    expect(await openInbox(sock, () => undefined)).toBeNull();
    first!.close();
    expect(existsSync(sock)).toBe(false);
    // A dead server's leftover file is cleared; an old server closing late leaves the new one's file alone.
    const a = await openInbox(sock, () => undefined);
    a!.close();
    writeFileSync(sock, "");
    const b = await openInbox(sock, () => undefined);
    expect(b).not.toBeNull();
    a!.close();
    expect(existsSync(sock)).toBe(true);
    b!.close();
  });

  it("team watch with no team server exits 3 and says why", async () => {
    let err = "";
    const code = await runTeamWatch(
      inboxPath(temp("chalito-home-"), "claude", 9),
      () => undefined,
      (t) => (err += t),
    );
    expect(code).toBe(3);
    expect(err).toContain("no team server for this session yet");
  });
});

describe("hub: the one-shot CLI never takes what a live session was handed", () => {
  it("a request reserved for a session whose mod left does not start the responder", () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async (_job: unknown) => "answered");
      const hub = new TeamHub(
        workspaceFor,
        () => Date.now(),
        () => true,
        {
          pacing: { debounceMs: 10, minGapMs: 0 },
          responder: { has: () => true, run },
        },
      );
      const a = new AbortController();
      const s = new AbortController();
      hub.call(a.signal, "team_join", { provider: "claude", cwd: "/project" }, { push: () => true });
      hub.call(a.signal, "team_client", { inbox: true });
      hub.call(s.signal, "team_join", { provider: "codex", cwd: "/project" });
      hub.call(s.signal, "team_send", { to: "claude", kind: "request", text: "do it" });
      vi.advanceTimersByTime(20);
      hub.call(a.signal, "team_client", {});
      // A new by-name request may go to the CLI; the reserved one stays with A.
      hub.call(s.signal, "team_send", { to: "claude", kind: "request", text: "new one" });
      expect(run).toHaveBeenCalledTimes(1);
      const job = run.mock.calls[0]![0] as { messages: { text: string }[] };
      expect(job.messages.map((m) => m.text)).toEqual(["new one"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hub: a session whose push route goes away", () => {
  it("keeps what it was handed reserved: no second session or CLI gets a request that may be a turn in progress", () => {
    vi.useFakeTimers();
    try {
      const frames: string[][] = [[], []];
      const links = [0, 1].map((i) => ({
        push: (f: { teamDelivery: { batch: { messages: { text: string }[] } } }) => (
          frames[i]!.push(...f.teamDelivery.batch.messages.map((m) => m.text)),
          true
        ),
      }));
      const hub = new TeamHub(
        workspaceFor,
        () => Date.now(),
        () => true,
        { pacing: { debounceMs: 10, minGapMs: 0 } },
      );
      const a = new AbortController();
      const b = new AbortController();
      const s = new AbortController();
      hub.call(a.signal, "team_join", { provider: "claude", cwd: "/project" }, links[0]!);
      hub.call(a.signal, "team_client", { inbox: true });
      hub.call(b.signal, "team_join", { provider: "claude", cwd: "/project" }, links[1]!);
      hub.call(b.signal, "team_client", { inbox: true });
      hub.call(s.signal, "team_join", { provider: "codex", cwd: "/project" });
      hub.call(s.signal, "team_send", { to: "claude", kind: "request", text: "once" });
      vi.advanceTimersByTime(20);
      expect(frames).toEqual([["once"], []]);
      // A's mod disconnects: A may already be doing it, so B is not pushed it.
      hub.call(a.signal, "team_client", {});
      vi.advanceTimersByTime(20);
      expect(frames).toEqual([["once"], []]);
      // A reads it (or leaves): done, or then free.
      expect(
        (hub.call(a.signal, "team_read", {}) as { result: { messages: { text: string }[] } }).result.messages.map(
          (m) => m.text,
        ),
      ).toEqual(["once"]);
      vi.advanceTimersByTime(20);
      expect(frames[1]).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
