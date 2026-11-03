import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamHub } from "../src/team/hub.js";
import { CommandResponder, responderPrompt, type ResponderJob } from "../src/team/responder.js";
import type { DeliveryAdapter, TeamBatch } from "../src/team/delivery/types.js";

const workspaceFor = (cwd: string) => (cwd === "/project" ? "project" : null);
type Res = { ok: boolean; error?: string; result: { self: string; messages: Record<string, unknown>[] } };
const call = (hub: TeamHub, s: AbortSignal, action: string, args: unknown) => hub.call(s, action, args) as Res;
const join_ = (hub: TeamHub, s: AbortSignal, provider: string) =>
  call(hub, s, "team_join", { provider, cwd: "/project" }).result.self;

const stub = (answer: string | null = "done: 42") => {
  const jobs: ResponderJob[] = [];
  return {
    jobs,
    responder: { has: (p: string) => p !== "nobody", run: vi.fn(async (j: ResponderJob) => (jobs.push(j), answer)) },
  };
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("messages to an app by name", () => {
  it("runs the app's CLI when no session of it can be woken, and its answer reaches the asker", async () => {
    const { jobs, responder } = stub();
    const hub = new TeamHub(workspaceFor, Date.now, () => true, { responder });
    const a = new AbortController();
    const me = join_(hub, a.signal, "claude");
    expect(call(hub, a.signal, "team_send", { to: "codex", kind: "request", text: "Run the tests" })).toMatchObject({
      ok: true,
    });
    await vi.waitFor(() => expect(responder.run).toHaveBeenCalledOnce());
    expect(jobs[0]).toMatchObject({ provider: "codex", cwd: "/project", messages: [{ text: "Run the tests" }] });
    await vi.waitFor(() =>
      expect(call(hub, a.signal, "team_read", {}).result.messages).toEqual([
        expect.objectContaining({ provider: "codex", kind: "result", to: me, text: "done: 42" }),
      ]),
    );
    // A codex session opening later doesn't get the request again: the responder took it.
    const b = new AbortController();
    join_(hub, b.signal, "codex");
    expect(call(hub, b.signal, "team_read", {}).result.messages).toEqual([]);
    a.abort();
    b.abort();
  });

  it("holds a message for an app with no CLI here until one of its sessions opens, then delivers it once", () => {
    const { responder } = stub();
    const hub = new TeamHub(workspaceFor, Date.now, () => true, { responder });
    const a = new AbortController();
    join_(hub, a.signal, "claude");
    expect(call(hub, a.signal, "team_send", { to: "nobody", kind: "request", text: "ping" }).ok).toBe(true);
    a.abort(); // the asker leaves; the held message stays
    const b = new AbortController();
    join_(hub, b.signal, "nobody");
    expect(call(hub, b.signal, "team_read", {}).result.messages).toEqual([
      expect.objectContaining({ provider: "claude", toProvider: "nobody", text: "ping" }),
    ]);
    expect(call(hub, b.signal, "team_read", {}).result.messages).toEqual([]);
    expect(responder.run).not.toHaveBeenCalled();
    b.abort();
  });

  it("a session that can be woken gets a push instead; no CLI runs", async () => {
    const { responder } = stub();
    const pushed: TeamBatch[] = [];
    const wake: DeliveryAdapter = { id: "test", canWake: true, deliver: (b) => (pushed.push(b), true) };
    const hub = new TeamHub(workspaceFor, Date.now, () => true, {
      responder,
      pacing: { debounceMs: 10, minGapMs: 0 },
      chain: [{ id: "test", select: () => wake }],
    });
    const a = new AbortController(),
      b = new AbortController();
    join_(hub, a.signal, "claude");
    join_(hub, b.signal, "codex");
    call(hub, b.signal, "team_client", { experimental: [] });
    call(hub, a.signal, "team_send", { to: "codex", kind: "request", text: "review" });
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(pushed[0]!.messages).toEqual([expect.objectContaining({ text: "review", toProvider: "codex" })]);
    expect(responder.run).not.toHaveBeenCalled();
    a.abort();
    b.abort();
  });

  it("results and status never start a CLI, so two apps can't spin each other", async () => {
    const { responder } = stub();
    const hub = new TeamHub(workspaceFor, Date.now, () => true, { responder });
    const a = new AbortController();
    join_(hub, a.signal, "claude");
    call(hub, a.signal, "team_send", { to: "codex", kind: "result", text: "fyi" });
    call(hub, a.signal, "team_send", { to: "codex", kind: "status", text: "working" });
    await new Promise((r) => setTimeout(r, 20));
    expect(responder.run).not.toHaveBeenCalled();
    a.abort();
  });

  it("caps CLI runs per workspace, and refuses an app not trusted for the workspace", async () => {
    const { responder } = stub();
    const hub = new TeamHub(workspaceFor, Date.now, (p) => p !== "grok", {
      responder,
      responderLimit: { max: 1, windowMs: 60_000 },
    });
    const a = new AbortController();
    join_(hub, a.signal, "claude");
    call(hub, a.signal, "team_send", { to: "codex", kind: "request", text: "one" });
    await vi.waitFor(() => expect(responder.run).toHaveBeenCalledOnce());
    call(hub, a.signal, "team_send", { to: "cursor", kind: "request", text: "two" });
    await new Promise((r) => setTimeout(r, 20));
    expect(responder.run).toHaveBeenCalledOnce();
    expect(call(hub, a.signal, "team_send", { to: "grok", kind: "request", text: "x" })).toMatchObject({
      ok: false,
      error: "recipient_not_trusted",
    });
    a.abort();
  });

  it("never starts a CLI for an app whose trust was revoked, even for a session that just left", async () => {
    const { responder } = stub();
    let codexTrusted = true;
    const hub = new TeamHub(workspaceFor, Date.now, (p) => p !== "codex" || codexTrusted, { responder });
    const a = new AbortController(),
      b = new AbortController();
    join_(hub, a.signal, "claude");
    const codex = join_(hub, b.signal, "codex");
    b.abort();
    codexTrusted = false;
    expect(call(hub, a.signal, "team_send", { to: codex, kind: "request", text: "hi" }).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(responder.run).not.toHaveBeenCalled();
    a.abort();
  });

  it("a message to a teammate that just left goes to its app instead of failing", async () => {
    const { responder } = stub();
    const hub = new TeamHub(workspaceFor, Date.now, () => true, { responder });
    const a = new AbortController(),
      b = new AbortController();
    join_(hub, a.signal, "claude");
    const codex = join_(hub, b.signal, "codex");
    b.abort();
    expect(call(hub, a.signal, "team_send", { to: codex, kind: "request", text: "still there?" }).ok).toBe(true);
    await vi.waitFor(() => expect(responder.run).toHaveBeenCalledOnce());
    a.abort();
  });
});

describe("each message to an app is handled once", () => {
  const wakeable = (pushed: TeamBatch[]) => {
    const wake: DeliveryAdapter = { id: "test", canWake: true, deliver: (b) => (pushed.push(b), true) };
    return { pacing: { debounceMs: 5, minGapMs: 0 }, chain: [{ id: "test", select: () => wake }] };
  };

  it("a request a session already handled is not sent to the CLI again later", async () => {
    const { jobs, responder } = stub();
    const pushed: TeamBatch[] = [];
    const hub = new TeamHub(workspaceFor, Date.now, () => true, { responder, ...wakeable(pushed) });
    const a = new AbortController(),
      b = new AbortController();
    join_(hub, a.signal, "claude");
    join_(hub, b.signal, "codex");
    call(hub, b.signal, "team_client", { experimental: [] });
    call(hub, a.signal, "team_send", { to: "codex", kind: "request", text: "OLD" });
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    b.abort();
    call(hub, a.signal, "team_send", { to: "codex", kind: "request", text: "NEW" });
    await vi.waitFor(() => expect(responder.run).toHaveBeenCalledOnce());
    expect(jobs[0]!.messages.map((m) => m.text)).toEqual(["NEW"]);
    a.abort();
  });

  it("a held message goes to the first session of the app only", () => {
    const { responder } = stub();
    const hub = new TeamHub(workspaceFor, Date.now, () => true, { responder });
    const a = new AbortController(),
      c = new AbortController(),
      d = new AbortController();
    join_(hub, a.signal, "claude");
    call(hub, a.signal, "team_send", { to: "nobody", kind: "request", text: "once" });
    join_(hub, c.signal, "nobody");
    join_(hub, d.signal, "nobody");
    expect(call(hub, c.signal, "team_read", {}).result.messages).toHaveLength(1);
    expect(call(hub, d.signal, "team_read", {}).result.messages).toEqual([]);
    for (const x of [a, c, d]) x.abort();
  });

  it("a request held for a session that closes before its push goes to the CLI", async () => {
    const { responder } = stub();
    const hub = new TeamHub(workspaceFor, Date.now, () => true, {
      responder,
      pacing: { debounceMs: 60_000 },
      chain: [{ id: "t", select: () => ({ id: "t", canWake: true, deliver: () => true }) }],
    });
    const a = new AbortController(),
      b = new AbortController();
    join_(hub, a.signal, "claude");
    join_(hub, b.signal, "codex");
    call(hub, b.signal, "team_client", { experimental: [] });
    call(hub, a.signal, "team_send", { to: "codex", kind: "request", text: "pending" });
    expect(responder.run).not.toHaveBeenCalled();
    b.abort();
    await vi.waitFor(() => expect(responder.run).toHaveBeenCalledOnce());
    a.abort();
  });

  it("a CLI Chalito started can't start another CLI, so two apps can't chain each other", async () => {
    let finish: (v: string) => void = () => undefined;
    const responder = { has: () => true, run: vi.fn(() => new Promise<string>((r) => (finish = r))) };
    const hub = new TeamHub(workspaceFor, Date.now, () => true, { responder });
    const a = new AbortController();
    join_(hub, a.signal, "claude");
    call(hub, a.signal, "team_send", { to: "codex", kind: "request", text: "help" });
    await vi.waitFor(() => expect(responder.run).toHaveBeenCalledOnce());
    // The codex CLI's own team server joins while it runs, and asks claude.
    const spawned = new AbortController();
    join_(hub, spawned.signal, "codex");
    call(hub, spawned.signal, "team_send", { to: "cursor", kind: "request", text: "and you?" });
    finish("ok");
    await new Promise((r) => setTimeout(r, 20));
    expect(responder.run).toHaveBeenCalledOnce();
    a.abort();
    spawned.abort();
  });

  it("a session whose pushes fail doesn't hold up the request: the CLI answers it", async () => {
    const { responder } = stub();
    const hub = new TeamHub(workspaceFor, Date.now, () => true, {
      responder,
      pacing: { debounceMs: 5, minGapMs: 0 },
      chain: [{ id: "t", select: () => ({ id: "t", canWake: true, deliver: () => false }) }],
    });
    const a = new AbortController(),
      b = new AbortController();
    join_(hub, a.signal, "claude");
    join_(hub, b.signal, "codex");
    call(hub, b.signal, "team_client", { experimental: [] });
    call(hub, a.signal, "team_send", { to: "codex", kind: "request", text: "hello?" });
    await vi.waitFor(() => expect(responder.run).toHaveBeenCalledOnce());
    a.abort();
    b.abort();
  });

  it("the CLI's own session is known by its run id; a session the user opens meanwhile is not", async () => {
    let finish: (v: string) => void = () => undefined;
    const jobs: ResponderJob[] = [];
    const responder = {
      has: () => true,
      run: vi.fn((j: ResponderJob) => (jobs.push(j), new Promise<string>((r) => (finish = r)))),
    };
    const hub = new TeamHub(workspaceFor, Date.now, () => true, { responder });
    const a = new AbortController();
    join_(hub, a.signal, "claude");
    call(hub, a.signal, "team_send", { to: "codex", kind: "request", text: "one" });
    await vi.waitFor(() => expect(responder.run).toHaveBeenCalledOnce());
    // The CLI's session asks its own app: that never starts another run.
    const cli = new AbortController();
    hub.call(cli.signal, "team_join", { provider: "codex", cwd: "/project", run: jobs[0]!.run });
    call(hub, cli.signal, "team_send", { to: "codex", kind: "request", text: "self" });
    // A codex session the user opened (another run id or none) still can.
    const user = new AbortController();
    hub.call(user.signal, "team_join", {
      provider: "codex",
      cwd: "/project",
      run: "11111111-1111-4111-8111-111111111111",
    });
    call(hub, user.signal, "team_send", { to: "cursor", kind: "request", text: "from the user's codex" });
    await vi.waitFor(() => expect(responder.run).toHaveBeenCalledTimes(2));
    expect(jobs[1]).toMatchObject({ provider: "cursor" });
    finish("ok");
    await new Promise((r) => setTimeout(r, 20));
    expect(jobs.filter((j) => j.provider === "codex")).toHaveLength(1);
    for (const x of [a, cli, user]) x.abort();
  });

  it("big batches are split across turns instead of failing to start the CLI", async () => {
    const { jobs, responder } = stub();
    const hub = new TeamHub(workspaceFor, Date.now, () => true, {
      responder: { has: () => true, run: vi.fn(async (j: ResponderJob) => (jobs.push(j), "ok")) },
    });
    void responder;
    const a = new AbortController();
    join_(hub, a.signal, "claude");
    // Held first (no CLI yet), then released together.
    for (let n = 0; n < 6; n++)
      call(hub, a.signal, "team_send", { to: "codex", kind: "status", text: `${n}`.repeat(7000) });
    call(hub, a.signal, "team_send", { to: "codex", kind: "request", text: "go" });
    await vi.waitFor(() => expect(jobs.length).toBeGreaterThanOrEqual(2));
    for (const j of jobs) expect(j.messages.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(24_000);
    a.abort();
  });
});

describe("CommandResponder runs a real CLI", () => {
  const setup = (commands: Record<string, string[]>) => {
    const dir = mkdtempSync(join(tmpdir(), "chalito-responder-"));
    dirs.push(dir);
    writeFileSync(join(dir, "team-responders.json"), JSON.stringify(commands));
    return new CommandResponder({ home: dir, chalitoDir: dir, path: process.env.PATH });
  };
  const job: ResponderJob = {
    run: "00000000-0000-4000-8000-000000000000",
    provider: "echo",
    workspace: "w",
    cwd: tmpdir(),
    messages: [
      { workspace: "w", seq: 1, from: "a", provider: "claude", kind: "request", text: "2+2? `rm -rf ~` $(x)", at: 0 },
    ],
  };

  it("passes the prompt as one argument (no shell) and returns the CLI's output", async () => {
    const r = setup({ echo: [process.execPath, "-e", "process.stdout.write('ARG:' + process.argv[1])", "{prompt}"] });
    expect(r.has("echo")).toBe(true);
    const out = await r.run(job);
    expect(out).toBe(`ARG:${responderPrompt(job)}`);
    expect(out).toContain("`rm -rf ~` $(x)");
  });

  it("tells the asker why when the CLI fails, and has() is false for a missing CLI", async () => {
    const r = setup({
      echo: [process.execPath, "-e", "console.error('not signed in'); process.exit(3)", "{prompt}"],
      ghost: ["definitely-not-installed-cli", "{prompt}"],
    });
    expect(await r.run(job)).toBe("(echo could not answer: exit 3: not signed in)");
    expect(r.has("ghost")).toBe(false);
    expect(await r.run({ ...job, provider: "ghost" })).toBeNull();
  });

  it("a CLI that hangs is stopped with what it started, and the asker is told", async () => {
    const r = new CommandResponder({
      home: tmpdir(),
      chalitoDir: (() => {
        const dir = mkdtempSync(join(tmpdir(), "chalito-responder-"));
        dirs.push(dir);
        writeFileSync(
          join(dir, "team-responders.json"),
          JSON.stringify({ echo: [process.execPath, "-e", "setInterval(() => {}, 1000)", "{prompt}"] }),
        );
        return dir;
      })(),
      path: process.env.PATH,
      timeoutMs: 200,
    });
    expect(await r.run(job)).toMatch(/^\(echo could not answer: exit killed/);
  });

  it("ignores a broken config and keeps the built-in apps", () => {
    const dir = mkdtempSync(join(tmpdir(), "chalito-responder-"));
    dirs.push(dir);
    writeFileSync(join(dir, "team-responders.json"), "{not json");
    const r = new CommandResponder({ home: dir, chalitoDir: dir, path: "" });
    expect(r.has("echo")).toBe(false);
  });
});
