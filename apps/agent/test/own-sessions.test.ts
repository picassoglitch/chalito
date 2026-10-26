import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_GUESS_S,
  REVIEW_S,
  claudeNow,
  codexEvent,
  codexNow,
  ledgerEvent,
  levelFor,
  parseClaudeTail,
  rank,
  reduceCodex,
  unreadThreads,
  type CodexEvent,
  type CodexSession,
  type OwnSessionView,
  type RolloutMeta,
} from "../src/watch/own-sessions.js";
import { hookLine } from "../src/watch/hook.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "watch", name), "utf8");
const at = (iso: string) => Date.parse(iso);

describe("Claude transcripts → one state", () => {
  it("a finished turn: parallel results land out of order, sidechain and unknown lines are skipped", () => {
    const t = parseClaudeTail(fixture("claude-finished.jsonl"));
    expect(t.id).toBe("7f3e2a10-4c5d-4e6f-8a9b-0c1d2e3f4a5b");
    expect(t.cwd).toBe("/home/ana/code/tienda");
    expect(t.title).toBe("Arreglar test de checkout");
    expect(t.state).toBe("finished");
    expect(t.detail).toBe("Listo: el total ahora suma impuestos y el test pasa.");
    expect(t.since).toBe(at("2026-10-25T15:01:00.000Z"));
    expect(t.pending).toEqual([]);
    expect(t.skipped).toBe(2);
  });

  it("an unanswered AskUserQuestion is a question until its answer arrives", () => {
    const text = fixture("claude-question.jsonl");
    const t = parseClaudeTail(text);
    expect([t.state, t.detail, t.title]).toEqual([
      "question",
      "¿Conservo las URLs viejas con redirects?",
      "blog → astro",
    ]);
    expect(t.cwd).toBe("C:\\Users\\ana\\code\\blog");
    expect(t.since).toBe(at("2026-10-25T16:00:05.000Z"));
    const answer = JSON.stringify({
      type: "user",
      sessionId: t.id,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_02Q", content: "Sí" }] },
      timestamp: "2026-10-25T16:02:00.000Z",
    });
    expect(parseClaudeTail(`${text}${answer}\n`).state).toBe("working");
  });

  it("a partial last line (still being written) is skipped, never thrown", () => {
    const text = fixture("claude-question.jsonl");
    const partial = `${text}{"type":"assistant","message":{"content":[{"type":"te`;
    const t = parseClaudeTail(partial);
    expect(t.state).toBe("question");
    expect(t.skipped).toBe(1);
  });

  it("an API error, an interruption and a new prompt", () => {
    const base = { sessionId: "s1", cwd: "/w", isSidechain: false };
    const line = (o: object) => JSON.stringify({ ...base, ...o });
    const prompt = line({ type: "user", message: { content: "hola" }, timestamp: "2026-10-25T10:00:00Z" });
    const err = line({
      type: "assistant",
      isApiErrorMessage: true,
      message: { content: [{ type: "text", text: "API Error: 529 overloaded" }] },
      timestamp: "2026-10-25T10:00:05Z",
    });
    const t = parseClaudeTail([prompt, err].join("\n"));
    expect([t.state, t.detail]).toEqual(["error", "API Error: 529 overloaded"]);
    const stop = line({
      type: "user",
      message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] },
      timestamp: "2026-10-25T10:01:00Z",
    });
    expect(parseClaudeTail([prompt, stop].join("\n")).state).toBe("finished");
    const again = line({ type: "user", message: { content: "otra vez" }, timestamp: "2026-10-25T10:02:00Z" });
    expect(parseClaudeTail([prompt, err, again].join("\n")).state).toBe("working");
  });

  it("an unanswered tool call reads as a permission prompt only after its tool's normal run time", () => {
    const call = (name: string) =>
      [
        JSON.stringify({ type: "user", sessionId: "s", message: { content: "x" }, timestamp: "2026-10-25T10:00:00Z" }),
        JSON.stringify({
          type: "assistant",
          sessionId: "s",
          message: { content: [{ type: "tool_use", id: "t1", name, input: {} }] },
          timestamp: "2026-10-25T10:00:01Z",
        }),
      ].join("\n");
    const t0 = at("2026-10-25T10:00:01Z");
    const edit = parseClaudeTail(call("Edit"));
    expect(claudeNow(edit, t0 + (APPROVAL_GUESS_S.instant - 1) * 1000).state).toBe("working");
    const guessed = claudeNow(edit, t0 + APPROVAL_GUESS_S.instant * 1000);
    expect([guessed.state, guessed.guessed, guessed.detail]).toEqual(["approval", true, "Edit"]);
    const bash = parseClaudeTail(call("Bash"));
    expect(claudeNow(bash, t0 + 20_000).state).toBe("working");
    expect(claudeNow(bash, t0 + APPROVAL_GUESS_S.other * 1000).state).toBe("approval");
  });

  it("redacts secrets out of the line it shows", () => {
    const t = parseClaudeTail(
      JSON.stringify({
        type: "assistant",
        sessionId: "s",
        message: { content: [{ type: "text", text: "usa sk-ant-api03-abcdefghijklmnop para probar" }] },
        timestamp: "2026-10-25T10:00:00Z",
      }),
    );
    expect(t.detail).not.toContain("abcdefghijklmnop");
  });
});

describe("Codex rollouts and the hook ledger → one state", () => {
  const replay = (lines: string[], meta: RolloutMeta = {}, parents = new Map<string, string>()) =>
    lines.map((l) => codexEvent(l, meta, parents));
  const ID = "0199f0aa-bbbb-7ccc-8ddd-eeeeffff0001";

  it("a rollout: the question outlives the end of the turn; unknown event kinds are dropped", () => {
    const sessions = new Map<string, CodexSession>();
    const evs = replay(fixture("codex-rollout.jsonl").trim().split("\n"));
    expect(evs.filter(Boolean).map((e) => e!.event)).toEqual([
      "settings",
      "prompt",
      "activity",
      "activity",
      "question",
      "turn_done",
    ]);
    for (const e of evs) reduceCodex(sessions, e);
    const s = sessions.get(ID)!;
    expect([s.cwd, s.state, s.reviewer]).toEqual(["/Users/ana/code/api", "finished", "user"]);
    const now = codexNow(s, at("2026-10-25T17:01:00Z"));
    expect([now.state, now.detail, now.since]).toEqual(["question", "¿Node 22 o 24?", at("2026-10-25T17:00:07Z")]);
  });

  it("out-of-order merge: an older task_started cannot cancel a newer approval (sacbe feed.test.js:84)", () => {
    const sessions = new Map<string, CodexSession>();
    reduceCodex(sessions, { session: "c", event: "settings", reviewer: "user", ts: 100_000 });
    reduceCodex(sessions, { session: "c", event: "notify", detail: "Codex necesita tu permiso", ts: 110_000 });
    reduceCodex(sessions, { session: "c", event: "prompt", ts: 105_000 });
    expect(codexNow(sessions.get("c")!, 111_000).state).toBe("approval");
  });

  it("a question survives later approvals and replays from an older read in the same turn (sacbe feed.test.js:134)", () => {
    const sessions = new Map<string, CodexSession>();
    const c = (event: CodexEvent["event"], ts: number, extra: Partial<CodexEvent> = {}) =>
      reduceCodex(sessions, { session: "c4", event, ts: ts * 1000, ...extra });
    c("prompt", 100);
    c("notify", 150, { detail: "Codex necesita tu permiso (Bash)" });
    c("tool", 160);
    c("question", 120, { detail: "¿PR parcial?" }); // rollout read after the hook ledger
    expect(codexNow(sessions.get("c4")!, 170_000).state).toBe("question");
    c("prompt", 300);
    expect(codexNow(sessions.get("c4")!, 310_000).state).toBe("working");
  });

  it("auto-review: hidden from the person for a minute, then theirs; a guardian verdict lands on the parent chat", () => {
    const sessions = new Map<string, CodexSession>();
    const parents = new Map<string, string>();
    for (const e of replay(fixture("codex-rollout.jsonl").trim().split("\n").slice(0, 3), {}, parents))
      reduceCodex(sessions, e);
    sessions.get(ID)!.reviewer = "auto_review";
    const t = at("2026-10-25T17:10:01Z");
    reduceCodex(sessions, { session: ID, event: "notify", detail: "Codex necesita tu permiso", ts: t });
    const reviewing = codexNow(sessions.get(ID)!, t + 5000);
    expect([reviewing.state, reviewing.reviewing]).toEqual(["approval", true]);
    const late = codexNow(sessions.get(ID)!, t + (REVIEW_S + 1) * 1000);
    expect([late.reviewing, late.since]).toEqual([false, t + REVIEW_S * 1000]);
    const verdict = replay(fixture("codex-guardian.jsonl").trim().split("\n"), {}, parents)[1]!;
    expect([verdict.session, verdict.event, verdict.outcome]).toEqual([ID, "review", "deny"]);
    reduceCodex(sessions, verdict);
    expect(sessions.get(ID)!.state).toBe("working");
  });

  it("a verdict or end for a thread we don't track creates nothing; subagent threads are not the person's", () => {
    const sessions = new Map<string, CodexSession>();
    reduceCodex(sessions, { session: "x", event: "review", outcome: "deny", ts: 1 });
    reduceCodex(sessions, { session: "x", event: "end", ts: 1 });
    expect(sessions.size).toBe(0);
    const meta: RolloutMeta = {};
    codexEvent(JSON.stringify({ type: "session_meta", payload: { id: "sub", thread_source: "subagent" } }), meta);
    const ev = codexEvent(
      JSON.stringify({ timestamp: "2026-10-25T10:00:00Z", type: "event_msg", payload: { type: "task_started" } }),
      meta,
    );
    expect(ev).toBeNull();
  });

  it("garbage never throws: broken JSON, arrays, missing timestamps", () => {
    const meta: RolloutMeta = { id: "a", user: true };
    for (const l of ["", "{", "[1,2]", "null", '{"type":"event_msg","payload":{"type":"task_started"}}'])
      expect(codexEvent(l, meta)).toBeNull();
    expect(ledgerEvent("{nope")).toBeNull();
    expect(ledgerEvent('{"session":"a","ts":1,"event":"rm -rf"}')).toBeNull();
  });

  it("the Codex app's unread list, from its global state", () => {
    const state = {
      "electron-thread-read-state-v1": { unreadByIdentity: { me: { local: ["a", "b"], other: ["c", 4] } } },
    };
    expect([...unreadThreads(state)].sort()).toEqual(["a", "b", "c"]);
    expect(unreadThreads(null).size).toBe(0);
  });
});

describe("the Codex hook payload", () => {
  it("PermissionRequest → an approval line; PostToolUse → a tool line", () => {
    const line = hookLine(
      JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "th1", cwd: "/w", tool_name: "shell" }),
      5000,
    );
    expect(JSON.parse(line!)).toEqual({
      session: "th1",
      ts: 5000,
      event: "notify",
      tool: "shell",
      cwd: "/w",
    });
    expect(ledgerEvent(line!)).toMatchObject({
      session: "th1",
      event: "notify",
      ts: 5000,
      detailKey: "approval",
      detail: "shell",
    });
    expect(JSON.parse(hookLine(JSON.stringify({ hook_event_name: "PostToolUse", thread_id: "th1" }), 6)!).event).toBe(
      "tool",
    );
  });

  it("subagents, other events and garbage write nothing", () => {
    expect(
      hookLine(JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "a", agent_type: "sub" }), 1),
    ).toBeNull();
    expect(hookLine(JSON.stringify({ hook_event_name: "Stop", session_id: "a" }), 1)).toBeNull();
    expect(hookLine(JSON.stringify({ hook_event_name: "PermissionRequest" }), 1)).toBeNull();
    expect(hookLine("not json", 1)).toBeNull();
    expect(hookLine("[]", 1)).toBeNull();
  });
});

describe("review round: what a busy or idle session really is", () => {
  const L = (o: object) => JSON.stringify({ sessionId: "s", cwd: "/w", isSidechain: false, ...o });
  const prompt = L({ type: "user", message: { content: "corre los tests" }, timestamp: "2026-10-25T10:00:00Z" });
  const bash = L({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pnpm test" } }] },
    timestamp: "2026-10-25T10:00:01Z",
  });

  it("a long-running tool whose transcript file keeps changing is still working, not an approval", () => {
    const t = parseClaudeTail([prompt, bash].join("\n"));
    const t0 = Date.parse("2026-10-25T10:00:01Z");
    expect(claudeNow(t, t0 + 120_000, t0 + 110_000).state).toBe("working");
    expect(claudeNow(t, t0 + 120_000, t0).state).toBe("approval");
  });

  it("progress and other unknown lines with a timestamp keep the session alive", () => {
    const progress = L({ type: "progress", data: { type: "bash_progress" }, timestamp: "2026-10-25T10:03:00Z" });
    const future = L({ type: "brand-new", timestamp: "2026-10-25T10:04:00Z" });
    const t = parseClaudeTail([prompt, bash, progress, future].join("\n"));
    expect(t.last).toBe(Date.parse("2026-10-25T10:04:00Z"));
    expect(t.skipped).toBe(1);
  });

  it("a working session reports when it started working, not 0", () => {
    const t = parseClaudeTail(prompt);
    expect([t.state, t.since]).toEqual(["working", Date.parse("2026-10-25T10:00:00Z")]);
  });

  it("slash commands, ! runs and compaction don't restart a finished session", () => {
    const done = L({
      type: "assistant",
      message: { content: [{ type: "text", text: "Listo." }] },
      timestamp: "2026-10-25T10:01:00Z",
    });
    const local = [
      L({
        type: "user",
        message: { content: "<command-name>/model</command-name>\n<command-args></command-args>" },
        timestamp: "2026-10-25T10:02:00Z",
      }),
      L({
        type: "user",
        message: { content: "<local-command-stdout>Set model</local-command-stdout>" },
        timestamp: "2026-10-25T10:02:01Z",
      }),
      L({ type: "user", message: { content: "<bash-input>ls</bash-input>" }, timestamp: "2026-10-25T10:02:02Z" }),
      L({ type: "user", isCompactSummary: true, message: { content: "Resumen…" }, timestamp: "2026-10-25T10:02:03Z" }),
    ];
    expect(parseClaudeTail([prompt, done, ...local].join("\n")).state).toBe("finished");
  });

  it("generic lines come back as keys the panel translates; quoted text stays text", () => {
    const ask = L({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "q", name: "AskUserQuestion", input: {} }] },
      timestamp: "2026-10-25T10:00:02Z",
    });
    const q = parseClaudeTail([prompt, ask].join("\n"));
    expect([q.state, q.detail, q.detailKey]).toEqual(["question", null, "question"]);
    const meta: RolloutMeta = { id: "c", user: true };
    const aborted = codexEvent(
      JSON.stringify({
        timestamp: "2026-10-25T10:00:00Z",
        type: "event_msg",
        payload: { type: "turn_aborted", reason: "error" },
      }),
      meta,
    );
    expect([aborted?.event, aborted?.detailKey, aborted?.detail]).toEqual(["error", "stopped", "error"]);
  });

  it("a prompt-type slash command starts a turn; an API error with no text is a key, not English", () => {
    const done = L({
      type: "assistant",
      message: { content: [{ type: "text", text: "Listo." }] },
      timestamp: "2026-10-25T10:01:00Z",
    });
    const cmd = L({
      type: "user",
      message: { content: "<command-message>review</command-message>\n<command-name>/review</command-name>" },
      timestamp: "2026-10-25T10:02:00Z",
    });
    const expanded = L({
      type: "user",
      isMeta: true,
      message: { content: [{ type: "text", text: "Revisa el PR abierto…" }] },
      timestamp: "2026-10-25T10:02:00.100Z",
    });
    const t = parseClaudeTail([prompt, done, cmd, expanded].join("\n"));
    expect([t.state, t.since]).toEqual(["working", Date.parse("2026-10-25T10:02:00Z")]);
    const err = L({
      type: "assistant",
      isApiErrorMessage: true,
      message: { content: [] },
      timestamp: "2026-10-25T10:03:00Z",
    });
    const e = parseClaudeTail([prompt, err].join("\n"));
    expect([e.state, e.detail, e.detailKey]).toEqual(["error", null, "apiError"]);
  });

  it("a guessed approval stays at L1; a session silent for 30 min stops calling", () => {
    expect(levelFor("approval", 3600, false, { guessed: true })).toBe("L1");
    expect(levelFor("question", 3600, false, { quietS: 30 * 60 })).toBeNull();
    expect(levelFor("question", 3600, false, { quietS: 60 })).toBe("L3");
  });
});

describe("levels and ranking", () => {
  it("L1 at once, L2 at 2 min, L3 at 5 min, never L4; nothing for working, finished or under review", () => {
    expect(levelFor("approval", 0, false)).toBe("L1");
    expect(levelFor("question", 120, false)).toBe("L2");
    expect(levelFor("error", 3600, false)).toBe("L3");
    expect(levelFor("approval", 3600, true)).toBeNull();
    expect(levelFor("working", 3600, false)).toBeNull();
    expect(levelFor("finished", 3600, false)).toBeNull();
  });

  it("sessions that want the person first, longest wait first; then the rest, newest first", () => {
    const v = (key: string, level: OwnSessionView["level"], since: number) => ({ key, level, since }) as OwnSessionView;
    const out = rank([v("done-old", null, 1), v("ask-new", "L1", 50), v("done-new", null, 9), v("ask-old", "L2", 10)]);
    expect(out.map((s) => s.key)).toEqual(["ask-old", "ask-new", "done-new", "done-old"]);
  });
});
