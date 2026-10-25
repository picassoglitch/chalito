import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { main, type CliIo } from "../src/cli.js";
import { chalitoDir } from "../src/config.js";
import { IpcError } from "../src/ipc-server.js";
import { ipcHandlers, type IpcDeps } from "../src/ipc-handlers.js";
import type { ProcessRunner } from "../src/runner.js";
import { recordHook } from "../src/watch/hook.js";
import { claudePid, openOwnSession } from "../src/watch/open.js";
import { OwnSessionWatcher, ledgerPath, watchEnabled, watchPaths, type WatchPaths } from "../src/watch/watcher.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "watch", name), "utf8");
const CLAUDE_ID = "7f3e2a10-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
const QUESTION_ID = "0a1b2c3d-1111-4222-8333-444455556666";
const CODEX_ID = "0199f0aa-bbbb-7ccc-8ddd-eeeeffff0001";
const NOW = Date.parse("2026-10-25T17:01:00Z");

/** Every file under a folder with its bytes' hash and mtime: proves nothing there was written. */
const snapshot = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else
        out[relative(root, p)] = `${createHash("sha256").update(readFileSync(p)).digest("hex")}:${statSync(p).mtimeMs}`;
    }
  };
  walk(root);
  return out;
};

const touch = (p: string, ms: number) => utimesSync(p, ms / 1000, ms / 1000);

const homes: string[] = [];
afterEach(() => void homes.splice(0));

/** A home folder laid out like a real one: Claude projects, Codex sessions, index and app state. */
const fakeHome = () => {
  const home = mkdtempSync(join(tmpdir(), "chalito-watch-"));
  homes.push(home);
  const proj = join(home, ".claude", "projects", "-home-ana-code-tienda");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${CLAUDE_ID}.jsonl`), fixture("claude-finished.jsonl"));
  const blog = join(home, ".claude", "projects", "C--Users-ana-code-blog");
  mkdirSync(join(blog, QUESTION_ID, "subagents"), { recursive: true });
  writeFileSync(join(blog, `${QUESTION_ID}.jsonl`), fixture("claude-question.jsonl"));
  // A subagent transcript one level deeper must not become a session of its own.
  writeFileSync(join(blog, QUESTION_ID, "subagents", "agent-1.jsonl"), fixture("claude-question.jsonl"));
  const day = join(home, ".codex", "sessions", "2026", "10", "25");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-10-25T17-00-00-${CODEX_ID}.jsonl`), fixture("codex-rollout.jsonl"));
  writeFileSync(join(day, "rollout-2026-10-25T17-10-00-guardian.jsonl"), fixture("codex-guardian.jsonl"));
  writeFileSync(
    join(home, ".codex", "session_index.jsonl"),
    `${JSON.stringify({ id: CODEX_ID, thread_name: "Subir Node" })}\n{broken\n`,
  );
  for (const f of [join(proj, `${CLAUDE_ID}.jsonl`), join(blog, `${QUESTION_ID}.jsonl`)]) touch(f, NOW - 60_000);
  const paths = watchPaths(chalitoDir(home), {}, home);
  return { home, paths, proj, blog, day };
};

const watcher = (paths: WatchPaths, now: () => number = () => NOW, log: string[] = []) =>
  new OwnSessionWatcher({ paths, now, log: (m, meta) => log.push(`${m}:${JSON.stringify(meta)}`) });

describe("watching the person's own sessions (real files in a temp home)", () => {
  it("is off by default: nothing is listed, and nothing is written or read into memory", () => {
    const { home, paths } = fakeHome();
    const before = snapshot(join(home, ".claude"));
    const w = watcher(paths);
    expect(w.enabled).toBe(false);
    expect(w.poll()).toEqual([]);
    expect(existsSync(paths.own)).toBe(false);
    expect(snapshot(join(home, ".claude"))).toEqual(before);
  });

  it("on: Claude and Codex sessions with derived state, ranked, and the tools' folders untouched", () => {
    const { home, paths } = fakeHome();
    const claudeBefore = snapshot(join(home, ".claude"));
    const codexBefore = snapshot(join(home, ".codex"));
    const log: string[] = [];
    const w = watcher(paths, () => NOW, log);
    w.setEnabled(true);
    expect(watchEnabled(paths)).toBe(true);
    const views = w.poll();
    expect(views.map((v) => [v.key, v.state, v.level])).toEqual([
      [`claude:${QUESTION_ID}`, "question", "L3"],
      [`codex:${CODEX_ID}`, "question", "L1"],
      [`claude:${CLAUDE_ID}`, "finished", null],
    ]);
    const codex = views.find((v) => v.source === "codex")!;
    expect([codex.title, codex.cwd, codex.detail]).toEqual(["Subir Node", "/Users/ana/code/api", "¿Node 22 o 24?"]);
    expect(views.find((v) => v.key === `claude:${CLAUDE_ID}`)!.title).toBe("Arreglar test de checkout");
    expect(log.some((l) => l.startsWith("watch.skipped_lines") && l.includes('"claude"'))).toBe(true);
    expect(log.join("\n")).not.toContain("checkout");
    expect(snapshot(join(home, ".claude"))).toEqual(claudeBefore);
    expect(snapshot(join(home, ".codex"))).toEqual(codexBefore);
  });

  it("follows appends, waits out a half-written line, and logs drift without the text", () => {
    const { paths, blog } = fakeHome();
    let now = NOW;
    const w = watcher(paths, () => now);
    w.setEnabled(true);
    const file = join(blog, `${QUESTION_ID}.jsonl`);
    expect(w.poll()[0]!.state).toBe("question");
    const answer = JSON.stringify({
      type: "user",
      sessionId: QUESTION_ID,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_02Q", content: "Sí" }] },
      timestamp: "2026-10-25T17:01:05.000Z",
    });
    appendFileSync(file, answer.slice(0, 40));
    now += 1000;
    expect(w.poll().find((v) => v.id === QUESTION_ID)!.state).toBe("question");
    appendFileSync(file, `${answer.slice(40)}\n`);
    now += 1000;
    expect(w.poll().find((v) => v.id === QUESTION_ID)!.state).toBe("working");
  });

  it("the Codex hook's ledger brings approvals in, merged out of order with the rollout", () => {
    const { paths, day } = fakeHome();
    let now = NOW;
    const w = watcher(paths, () => now);
    expect(recordHook(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: CODEX_ID }), paths, now)).toBe(
      false,
    );
    expect(existsSync(ledgerPath(paths))).toBe(false);
    w.setEnabled(true);
    w.poll();
    const rollout = join(day, `rollout-2026-10-25T17-00-00-${CODEX_ID}.jsonl`);
    appendFileSync(
      rollout,
      `${JSON.stringify({ timestamp: "2026-10-25T17:02:00.000Z", type: "event_msg", payload: { type: "task_started" } })}\n`,
    );
    now = Date.parse("2026-10-25T17:02:10Z");
    expect(
      recordHook(
        JSON.stringify({ hook_event_name: "PermissionRequest", session_id: CODEX_ID, tool_name: "shell" }),
        paths,
        now,
      ),
    ).toBe(true);
    now += 5000;
    expect(w.poll().find((s) => s.source === "codex")!.state).toBe("approval");
    // An older line read after the approval (the rollout can lag the hook) cannot cancel it.
    appendFileSync(
      rollout,
      `${JSON.stringify({ timestamp: "2026-10-25T17:02:05.000Z", type: "event_msg", payload: { type: "task_started" } })}\n`,
    );
    now += 10_000;
    const v = w.poll().find((s) => s.source === "codex")!;
    expect([v.state, v.detailKey, v.detail, v.reviewing, v.level]).toEqual([
      "approval",
      "approval",
      "shell",
      false,
      "L1",
    ]);
    recordHook(JSON.stringify({ hook_event_name: "PostToolUse", session_id: CODEX_ID }), paths, now + 1000);
    now += 2000;
    expect(w.poll().find((s) => s.source === "codex")!.state).toBe("working");
  });

  it("a chat the Codex app already shows as read is marked seen", () => {
    const { home, paths } = fakeHome();
    const state = join(home, ".codex", ".codex-global-state.json");
    writeFileSync(
      state,
      JSON.stringify({ "electron-thread-read-state-v1": { unreadByIdentity: { me: { local: [] } } } }),
    );
    touch(state, NOW);
    const w = watcher(paths);
    w.setEnabled(true);
    const day = join(home, ".codex", "sessions", "2026", "10", "25", `rollout-2026-10-25T17-00-00-${CODEX_ID}.jsonl`);
    // Without the question the chat is simply finished.
    writeFileSync(day, fixture("codex-rollout.jsonl").replace(/.*request_user_input_async.*\n/, ""));
    expect(w.poll().find((s) => s.source === "codex")!).toMatchObject({ state: "finished", seen: true });
  });

  it("turning it off forgets everything and stops reading; the hook stops recording", () => {
    const { paths } = fakeHome();
    const w = watcher(paths);
    w.setEnabled(true);
    expect(w.poll().length).toBe(3);
    w.setEnabled(false);
    expect(w.poll()).toEqual([]);
    expect(recordHook(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "z" }), paths, NOW)).toBe(
      false,
    );
  });

  it("old sessions drop off, a long-silent working one too, and missing folders are fine", () => {
    const { paths, proj } = fakeHome();
    touch(join(proj, `${CLAUDE_ID}.jsonl`), NOW - 2 * 24 * 3600 * 1000);
    const w = watcher(paths);
    w.setEnabled(true);
    expect(w.poll().some((v) => v.id === CLAUDE_ID)).toBe(false);
    const empty = mkdtempSync(join(tmpdir(), "chalito-watch-empty-"));
    const lone = watcher(watchPaths(chalitoDir(empty), {}, empty));
    lone.setEnabled(true);
    expect(lone.poll()).toEqual([]);
  });

  it("an unreadable rollout is logged by code and skipped; every other session still shows", () => {
    const { paths, day } = fakeHome();
    mkdirSync(join(day, "rollout-2026-10-25T17-30-00-broken.jsonl"));
    const log: string[] = [];
    const w = watcher(paths, () => NOW, log);
    w.setEnabled(true);
    expect(w.poll()).toHaveLength(3);
    expect(log.some((l) => l.startsWith("watch.read_failed") && l.includes("EISDIR"))).toBe(true);
  });

  it("a guardian verdict read in the same poll as the hook's request lands after it (merged by time)", () => {
    const { paths, day } = fakeHome();
    let now = Date.parse("2026-10-25T17:20:00Z");
    appendFileSync(
      join(day, `rollout-2026-10-25T17-00-00-${CODEX_ID}.jsonl`),
      `${JSON.stringify({ timestamp: "2026-10-25T17:19:00.000Z", type: "event_msg", payload: { type: "task_started" } })}\n`,
    );
    const w = watcher(paths, () => now);
    w.setEnabled(true);
    w.poll();
    recordHook(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: CODEX_ID }), paths, now);
    const verdict = (ts: string) =>
      `${JSON.stringify({ timestamp: "2026-10-25T17:20:00.000Z", type: "session_meta", payload: { id: "g2", thread_source: "guardian_review", parent_thread_id: CODEX_ID } })}\n${JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "task_complete", last_agent_message: '{"outcome":"allow"}' } })}\n`;
    writeFileSync(join(day, "rollout-2026-10-25T17-20-00-g2.jsonl"), verdict("2026-10-25T17:20:07.000Z"));
    now += 31_000;
    expect(w.poll().find((s) => s.source === "codex")!.state).toBe("working");
  });

  it("logs the same drift once, without text, however often the session writes", () => {
    const { paths, proj } = fakeHome();
    const log: string[] = [];
    let now = NOW;
    const w = watcher(paths, () => now, log);
    w.setEnabled(true);
    w.poll();
    const file = join(proj, `${CLAUDE_ID}.jsonl`);
    for (let i = 0; i < 3; i++) {
      appendFileSync(file, `${JSON.stringify({ type: "summary", summary: `s${i}`, leafUuid: "x" })}\n`);
      now += 3000;
      w.poll();
    }
    const drift = log.filter((l) => l.startsWith("watch.skipped_lines") && l.includes('"claude"'));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain('"count":2');
  });

  it("turning it off deletes the hook's ledger (Chalito's own file) and nothing in the tools' folders", () => {
    const { home, paths } = fakeHome();
    const before = snapshot(join(home, ".codex"));
    const w = watcher(paths);
    w.setEnabled(true);
    recordHook(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: CODEX_ID }), paths, NOW);
    expect(existsSync(ledgerPath(paths))).toBe(true);
    w.setEnabled(false);
    expect(existsSync(ledgerPath(paths))).toBe(false);
    expect(snapshot(join(home, ".codex"))).toEqual(before);
  });

  it("honours CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
    const p = watchPaths("/c", { CLAUDE_CONFIG_DIR: "/x/claude", CODEX_HOME: "/y/codex" }, "/home/ana");
    expect([p.claudeProjects, p.claudeSessions, p.codexHome, p.own]).toEqual([
      join("/x/claude", "projects"),
      join("/x/claude", "sessions"),
      "/y/codex",
      join("/c", "watch"),
    ]);
  });
});

describe("the panel's calls", () => {
  const deps = (paths: WatchPaths | null, run?: ProcessRunner): IpcDeps =>
    ({
      ...(paths
        ? {
            ownSessions: {
              watcher: watcher(paths),
              open: (v) => openOwnSession(v, { platform: "darwin", run: run!, paths }),
            },
          }
        : {}),
    }) as IpcDeps;

  it("reads, toggles and opens through the IPC handlers", async () => {
    const { paths } = fakeHome();
    const runs: string[][] = [];
    const run: ProcessRunner = {
      run: async (cmd, args) => (runs.push([cmd, ...args]), { code: 0, stdout: "", stderr: "" }),
    };
    const h = ipcHandlers(deps(paths, run));
    expect(await h.ownSessions!(undefined)).toEqual({ enabled: false, sessions: [] });
    await expect(h.ownSessionsSet!({ enabled: "yes" })).rejects.toThrow("bad_params");
    expect(await h.ownSessionsSet!({ enabled: true })).toEqual({ enabled: true });
    const r = (await h.ownSessions!(undefined)) as { enabled: boolean; sessions: { key: string }[] };
    expect(r.enabled).toBe(true);
    expect(r.sessions).toHaveLength(3);
    expect(await h.ownSessionOpen!({ key: `codex:${CODEX_ID}` })).toEqual({
      opened: true,
      via: "codex",
      id: CODEX_ID,
      cwd: "/Users/ana/code/api",
    });
    expect(runs).toEqual([["open", `codex://threads/${CODEX_ID}`]]);
    await expect(h.ownSessionOpen!({ key: "claude:nope" })).rejects.toThrow("not_found");
  });

  it("answers unavailable without a watcher", async () => {
    const h = ipcHandlers(deps(null));
    await expect(h.ownSessions!(undefined)).rejects.toBeInstanceOf(IpcError);
    await expect(h.ownSessions!(undefined)).rejects.toThrow("unavailable");
  });
});

describe("Abrir", () => {
  const runner = (out: Record<string, { code: number; stdout: string }>) => {
    const runs: string[][] = [];
    const run: ProcessRunner = {
      run: async (cmd, args) => {
        runs.push([cmd, ...args]);
        return { ...(out[cmd] ?? { code: 0, stdout: "" }), stderr: "" };
      },
    };
    return { run, runs };
  };

  it("macOS: Claude's pid file → its tty → that Terminal tab", async () => {
    const { home, paths } = fakeHome();
    mkdirSync(join(home, ".claude", "sessions"));
    writeFileSync(join(home, ".claude", "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: CLAUDE_ID }));
    writeFileSync(join(home, ".claude", "sessions", "bad.json"), "{");
    expect(claudePid(paths.claudeSessions, CLAUDE_ID)).toBe(4242);
    const { run, runs } = runner({ ps: { code: 0, stdout: "ttys003\n" }, osascript: { code: 0, stdout: "ok\n" } });
    expect(await openOwnSession({ source: "claude", id: CLAUDE_ID }, { platform: "darwin", run, paths })).toEqual({
      opened: true,
      via: "terminal",
    });
    expect(runs[0]).toEqual(["ps", "-o", "tty=", "-p", "4242"]);
    expect(runs[1]!.at(-1)).toBe("/dev/ttys003");
  });

  it("falls back (the panel shows the folder and id) off macOS, with no tty, or with an unsafe id", async () => {
    const { paths } = fakeHome();
    const { run, runs } = runner({ ps: { code: 0, stdout: "??\n" } });
    expect(await openOwnSession({ source: "codex", id: CODEX_ID }, { platform: "linux", run, paths })).toEqual({
      opened: false,
    });
    expect(await openOwnSession({ source: "codex", id: "x; rm -rf /" }, { platform: "darwin", run, paths })).toEqual({
      opened: false,
    });
    expect(await openOwnSession({ source: "claude", id: CLAUDE_ID }, { platform: "darwin", run, paths })).toEqual({
      opened: false,
    });
    expect(runs).toEqual([]);
  });
});

describe("chalito watch-hook codex", () => {
  const io = (home: string, stdin: string): CliIo => {
    const input = new PassThrough();
    input.end(stdin);
    let out = "";
    return {
      out: (s) => void (out += s),
      err: (s) => void (out += s),
      tty: { input, output: new PassThrough() },
      env: {},
      home,
      platform: "linux",
      runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
      fetch: async () => {
        throw new Error("no network in tests");
      },
      now: () => NOW,
      execPath: "/opt/chalito/chalito-agent",
      tmpdir: tmpdir(),
      get printed() {
        return out;
      },
    } as CliIo;
  };

  it("records only while the watch is on, prints nothing and always exits 0", async () => {
    const { home, paths } = fakeHome();
    const payload = JSON.stringify({ hook_event_name: "PermissionRequest", session_id: CODEX_ID, tool_name: "shell" });
    const off = io(home, payload);
    expect(await main(["watch-hook", "codex"], off)).toBe(0);
    expect(existsSync(ledgerPath(paths))).toBe(false);
    watcher(paths).setEnabled(true);
    const on = io(home, payload);
    expect(await main(["watch-hook", "codex"], on)).toBe(0);
    expect((on as unknown as { printed: string }).printed).toBe("");
    expect(JSON.parse(readFileSync(ledgerPath(paths), "utf8"))).toMatchObject({ session: CODEX_ID, event: "notify" });
    expect(await main(["watch-hook", "codex"], io(home, "garbage"))).toBe(0);
  });
});
