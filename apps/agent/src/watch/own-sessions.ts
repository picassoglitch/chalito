import { redact } from "@chalito/redact";

// Sessions the person started outside Chalito, read from their local transcripts (owner, 2026-10-25).
// Adapted from Alux by Omar (homiomar): sacbe pet/feed.js, pet/titles.js, pet/codexread.js.

export type OwnSource = "claude" | "codex";
/** `closed`: the session's process is gone while it still looked busy or waiting (Claude's pid file left). */
export type OwnState = "working" | "question" | "approval" | "error" | "finished" | "closed";
export type OwnLevel = "L1" | "L2" | "L3";
/** Generic lines the panel words in the person's language; `detail` then carries only the argument. */
export type OwnDetailKey = "question" | "approval" | "stopped" | "tool" | "apiError";

/** What leaves the agent: derived state only, never transcript lines. */
export interface OwnSessionView {
  key: string;
  source: OwnSource;
  id: string;
  cwd: string | null;
  title: string | null;
  state: OwnState;
  /** Epoch ms the current state began. */
  since: number;
  /** One short redacted line: the question, the error or the tool waiting. */
  detail: string | null;
  detailKey: OwnDetailKey | null;
  /** Escalation for states that want the person; never L4, so the pet never takes focus. */
  level: OwnLevel | null;
  /** Codex's own auto-reviewer is still judging this approval. */
  reviewing: boolean;
  /** Claude logs no permission prompts: a tool call that stays unanswered is only a guess. */
  guessed: boolean;
  /** The Codex app already shows this finished chat as read. */
  seen: boolean;
}

export const NEEDS: ReadonlySet<OwnState> = new Set(["question", "approval", "error"]);
/** Seconds waited before the level rises: L1 at once, L2 at 2 min, L3 at 5 min. */
export const ESCALATE_S = [0, 120, 300] as const;
/** Codex's auto-reviewer answers in ~7 s (p90 30 s); undecided after this, it's yours. */
export const REVIEW_S = 60;

export const oneLine = (t: unknown, n = 140): string =>
  redact(
    String(t ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, n);

const parseLine = (line: string): Record<string, unknown> | null => {
  if (!line.startsWith("{")) return null;
  try {
    const d: unknown = JSON.parse(line);
    return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const tsOf = (d: Record<string, unknown>): number | null => {
  const t = typeof d.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
};

// ---- Claude Code transcripts (~/.claude/projects/<dir>/<session>.jsonl) ----

export interface ClaudeTail {
  id: string | null;
  cwd: string | null;
  title: string | null;
  state: OwnState;
  since: number;
  detail: string | null;
  detailKey: OwnDetailKey | null;
  /** Unanswered tool calls (not AskUserQuestion), oldest first. */
  pending: { name: string; at: number }[];
  /** Epoch ms of the newest line with a timestamp. */
  last: number;
  /** Lines that weren't JSON or had a shape we don't know: skipped, counted for the log. */
  skipped: number;
}

const INTERRUPTED = /^\[Request interrupted by user/;
/** Tools that finish at once once allowed: silence after them means a permission prompt. */
const INSTANT = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "WebFetch"]);
/** How long an unanswered tool call waits before it reads as a permission prompt. */
export const APPROVAL_GUESS_S = { instant: 8, other: 45 } as const;
const KNOWN_TYPES = new Set([
  "user",
  "assistant",
  "summary",
  "custom-title",
  "ai-title",
  "system",
  "file-history-snapshot",
  "queue-operation",
  "attachment",
  "progress",
]);
/** Slash commands, `!` shell runs and compaction write user lines that start no turn. */
const LOCAL_COMMAND = /^<(command-|local-command-|bash-)/;

/** Folds transcript lines (file order is write order) into one state; unknown lines are skipped. */
export const parseClaudeTail = (text: string): ClaudeTail => {
  const out: ClaudeTail = {
    id: null,
    cwd: null,
    title: null,
    state: "working",
    since: 0,
    detail: null,
    detailKey: null,
    pending: [],
    last: 0,
    skipped: 0,
  };
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  const pending = new Map<string, { name: string; at: number }>();
  let question: { id: string; detail: string | null; at: number } | null = null;
  let since: number | null = null;
  let commandAt: number | null = null;
  const set = (state: OwnState, at: number, detail: string | null) => {
    if (since === null || out.state !== state) since = at;
    out.state = state;
    out.detail = detail;
    out.detailKey = null;
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const d = parseLine(line);
    // Any timestamped line, even one we skip, proves the session is alive.
    const at = (d && tsOf(d)) ?? out.last;
    out.last = Math.max(out.last, at);
    if (!d || typeof d.type !== "string" || !KNOWN_TYPES.has(d.type)) {
      out.skipped++;
      continue;
    }
    // Subagent turns live in the same session; their tool calls are not the person's to answer.
    if (d.isSidechain === true) continue;
    out.id = str(d.sessionId) ?? out.id;
    out.cwd = str(d.cwd) ?? out.cwd;
    if (d.type === "custom-title") customTitle = str(d.customTitle) ?? customTitle;
    else if (d.type === "ai-title") aiTitle = str(d.aiTitle) ?? aiTitle;
    if (d.type !== "user" && d.type !== "assistant") continue;
    const message = obj(d.message);
    const content = message.content;
    if (d.type === "user") {
      const blocks = arr(content).map(obj);
      const said =
        typeof content === "string"
          ? content
          : blocks
              .filter((b) => b.type === "text")
              .map((b) => str(b.text) ?? "")
              .join(" ");
      // A prompt-type slash command logs its expanded prompt as a meta line: that starts the turn.
      if (d.isMeta === true && commandAt !== null && said.trim()) {
        pending.clear();
        question = null;
        set("working", commandAt, null);
      }
      if (d.isMeta === true || d.isCompactSummary === true || d.isVisibleInTranscriptOnly === true) continue;
      commandAt = /^<command-(name|message)>/.test(said.trim()) ? at : null;
      const results = blocks.filter((b) => b.type === "tool_result");
      if (results.length) {
        for (const r of results) {
          const id = str(r.tool_use_id) ?? "";
          pending.delete(id);
          if (question?.id === id) question = null;
        }
        set("working", at, null);
        continue;
      }
      if (LOCAL_COMMAND.test(said.trim())) continue;
      if (INTERRUPTED.test(said.trim())) {
        pending.clear();
        question = null;
        set("finished", at, null);
      } else if (said.trim()) {
        pending.clear();
        question = null;
        set("working", at, null);
      }
      continue;
    }
    const blocks = arr(content).map(obj);
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => str(b.text) ?? "")
      .join(" ");
    if (d.isApiErrorMessage === true) {
      pending.clear();
      set("error", at, text.trim() ? oneLine(text) : null);
      if (!text.trim()) out.detailKey = "apiError";
      continue;
    }
    const calls = blocks.filter((b) => b.type === "tool_use");
    for (const c of calls) {
      const id = str(c.id) ?? "";
      const name = str(c.name) ?? "tool";
      if (name === "AskUserQuestion") {
        const q = obj(arr(obj(c.input).questions)[0]).question;
        question = { id, detail: oneLine(q) || null, at };
      } else pending.set(id, { name, at });
    }
    if (calls.length) set("working", at, null);
    else if (text.trim() && pending.size === 0 && !question) set("finished", at, oneLine(text));
  }
  out.title = customTitle ?? aiTitle;
  out.pending = [...pending.values()];
  if (question) {
    out.state = "question";
    out.detail = question.detail;
    out.detailKey = question.detail ? null : "question";
    since = question.at;
  }
  out.since = since ?? out.last;
  return out;
};

/** The guessed permission prompt: a call left unanswered past its tool's normal run time. */
export const claudeNow = (
  t: ClaudeTail,
  nowMs: number,
  mtimeMs = 0,
): Pick<OwnSessionView, "state" | "since" | "detail" | "detailKey" | "guessed"> => {
  if (t.state === "working" && t.pending.length) {
    const p = t.pending[0]!;
    // The file's mtime counts too: progress lines and subagents write while a long tool runs.
    const quietS = (nowMs - Math.max(t.last, p.at, mtimeMs)) / 1000;
    if (quietS >= (INSTANT.has(p.name) ? APPROVAL_GUESS_S.instant : APPROVAL_GUESS_S.other))
      return { state: "approval", since: t.last, detail: oneLine(p.name, 60), detailKey: "tool", guessed: true };
  }
  return { state: t.state, since: t.since, detail: t.detail, detailKey: t.detailKey, guessed: false };
};

// ---- Codex rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) and the hook ledger ----

export type CodexEventName =
  | "start"
  | "prompt"
  | "turn_done"
  | "notify"
  | "tool"
  | "review"
  | "question"
  | "error"
  | "activity"
  | "settings"
  | "end";

export interface CodexEvent {
  session: string;
  event: CodexEventName;
  /** Epoch ms. */
  ts: number;
  cwd?: string;
  detail?: string;
  detailKey?: OwnDetailKey;
  outcome?: string;
  reviewer?: string;
}

export interface RolloutMeta {
  id?: string;
  cwd?: string;
  /** false for subagent and guardian threads: not chats the person talks to. */
  user?: boolean;
  /** A guardian thread: the chat its verdicts belong to. */
  reviews?: string;
}

const CODEX_TYPES = new Set(["session_meta", "turn_context", "response_item", "event_msg", "compacted"]);

/** A rollout line we can't read at all, or of a record kind we've never seen: format drift worth a log. */
export const codexDrift = (line: string): boolean => {
  const d = parseLine(line);
  return !d || typeof d.type !== "string" || !CODEX_TYPES.has(d.type);
};

/** One rollout line → an event, or null (meta lines fill `meta`; unknown lines are dropped). */
export const codexEvent = (line: string, meta: RolloutMeta, parents = new Map<string, string>()): CodexEvent | null => {
  const d = parseLine(line);
  if (!d) return null;
  const p = obj(d.payload);
  if (d.type === "session_meta") {
    meta.id = str(p.id);
    meta.cwd = str(p.cwd);
    const source = str(p.thread_source) ?? "user";
    meta.user = source === "user";
    meta.reviews = source === "guardian_review" ? str(p.parent_thread_id) : undefined;
    const id = str(p.id);
    const parent = str(p.parent_thread_id);
    if (id && parent) parents.set(id, parent);
    return null;
  }
  const ts = tsOf(d);
  if (ts === null) return null;
  if (meta.reviews) {
    if (d.type !== "event_msg" || p.type !== "task_complete") return null;
    let v: Record<string, unknown>;
    try {
      v = obj(JSON.parse(str(p.last_agent_message) ?? ""));
    } catch {
      return null;
    }
    // A guardian may judge a subagent's command: the verdict belongs to the chat the person talks to.
    let root = meta.reviews;
    for (let i = 0; i < 8 && parents.has(root); i++) root = parents.get(root)!;
    const outcome = str(v.outcome);
    return outcome ? { session: root, ts, event: "review", outcome, detail: oneLine(v.rationale, 200) } : null;
  }
  if (!meta.id || meta.user === false) return null;
  const base = { session: meta.id, ts, ...(meta.cwd ? { cwd: meta.cwd } : {}) };
  if (d.type === "turn_context") {
    const reviewer = str(p.approvals_reviewer);
    return { ...base, event: "settings", ...(reviewer ? { reviewer } : {}) };
  }
  if (d.type === "response_item" && p.type === "function_call" && p.name === "request_user_input_async") {
    let q: unknown;
    try {
      q = obj(arr(obj(JSON.parse(str(p.arguments) ?? "")).questions)[0]).title;
    } catch {
      q = undefined;
    }
    const text = oneLine(q);
    return { ...base, event: "question", ...(text ? { detail: text } : { detailKey: "question" }) };
  }
  if (d.type !== "event_msg") return null;
  const t = p.type;
  if (t === "task_started") return { ...base, event: "prompt" };
  if (t === "item_completed" || t === "token_count" || t === "exec_command_begin")
    return { ...base, event: "activity" };
  if (t === "task_complete" || (t === "turn_aborted" && p.reason === "interrupted")) {
    const msg = str(p.last_agent_message);
    return { ...base, event: "turn_done", ...(msg ? { detail: oneLine(msg) } : {}) };
  }
  if (t === "turn_aborted")
    return { ...base, event: "error", detailKey: "stopped", detail: oneLine(str(p.reason) ?? "error", 60) };
  return null;
};

/** A line the Chalito hook appended (watch/hook.ts); anything else is null. */
export const ledgerEvent = (line: string): CodexEvent | null => {
  const d = parseLine(line);
  if (!d || typeof d.session !== "string" || typeof d.ts !== "number") return null;
  if (d.event !== "notify" && d.event !== "tool") return null;
  return {
    session: d.session,
    ts: d.ts,
    event: d.event,
    ...(typeof d.cwd === "string" ? { cwd: d.cwd } : {}),
    ...(d.event === "notify" ? { detailKey: "approval" as const } : {}),
    ...(typeof d.tool === "string" ? { detail: oneLine(d.tool, 40) } : {}),
  };
};

export interface CodexSession {
  id: string;
  cwd: string | null;
  state: "working" | "finished" | "approval" | "error";
  since: number;
  turnStart: number;
  last: number;
  detail: string | null;
  detailKey: OwnDetailKey | null;
  reviewer: string | null;
  question: { detail: string | null; detailKey: OwnDetailKey | null; ts: number } | null;
}

/** Sacbe's reducer: sources merge out of order, and an event older than the current state can't change it. */
export const reduceCodex = (sessions: Map<string, CodexSession>, ev: CodexEvent | null): void => {
  if (!ev) return;
  const prev = sessions.get(ev.session);
  if (!prev && (ev.event === "review" || ev.event === "end")) return;
  const s: CodexSession = prev
    ? { ...prev }
    : {
        id: ev.session,
        cwd: ev.cwd ?? null,
        state: "working",
        since: ev.ts,
        turnStart: ev.ts,
        last: ev.ts,
        detail: null,
        detailKey: null,
        reviewer: null,
        question: null,
      };
  if (ev.event === "settings") {
    if (ev.reviewer) s.reviewer = ev.reviewer;
    sessions.set(ev.session, s);
    return;
  }
  // Questions and verdicts belong to the turn, not to the latest state change.
  const turnScoped = ev.event === "question" || ev.event === "review";
  if (prev && ev.ts < (turnScoped ? prev.turnStart : prev.since)) return;
  s.cwd = ev.cwd ?? s.cwd;
  s.last = Math.max(s.last, ev.ts);
  const to = (state: CodexSession["state"], detail: string | null, detailKey: OwnDetailKey | null = null) => {
    if (s.state !== state) s.since = ev.ts;
    s.state = state;
    s.detail = detail;
    s.detailKey = detailKey;
  };
  switch (ev.event) {
    case "start":
    case "prompt":
      Object.assign(s, {
        state: "working",
        since: ev.ts,
        turnStart: ev.ts,
        detail: null,
        detailKey: null,
        question: null,
      });
      break;
    case "turn_done":
      if (s.state !== "finished") to("finished", ev.detail ?? null);
      break;
    case "notify":
      to("approval", ev.detail ?? null, "approval");
      break;
    case "tool":
      if (s.state === "approval" || (s.state === "finished" && ev.ts > s.since)) to("working", null);
      break;
    case "activity":
      // Anything Codex writes after the request means it was answered (allowed, denied, or the turn moved on).
      if (s.state === "approval" && ev.ts > s.since) to("working", null);
      break;
    case "review":
      if (s.state === "approval" && ev.outcome && ev.ts >= s.since) to("working", null);
      break;
    case "question":
      s.question = { detail: ev.detail ?? null, detailKey: ev.detail ? null : "question", ts: ev.ts };
      break;
    case "error":
      to("error", ev.detail ?? null, ev.detailKey ?? null);
      break;
    case "end":
      sessions.delete(ev.session);
      return;
    default:
      break;
  }
  sessions.set(ev.session, s);
};

/** Unknown reviewer counts as auto: the setting can arrive after the request, and it is the default. */
const autoReviewed = (s: CodexSession) => s.reviewer === null || s.reviewer === "auto_review";

export const codexNow = (
  s: CodexSession,
  nowMs: number,
): Pick<OwnSessionView, "state" | "since" | "detail" | "detailKey" | "reviewing"> => {
  // An open question shows until the next prompt, unless an approval or error is more pressing.
  if (s.question && s.state !== "approval" && s.state !== "error")
    return {
      state: "question",
      since: s.question.ts,
      detail: s.question.detail,
      detailKey: s.question.detailKey,
      reviewing: false,
    };
  if (s.state === "approval" && autoReviewed(s)) {
    const reviewing = nowMs - s.since < REVIEW_S * 1000;
    // A reviewer that timed out hands it to the person then, so the wait starts then too.
    const since = reviewing ? s.since : s.since + REVIEW_S * 1000;
    return { state: "approval", since, detail: s.detail, detailKey: s.detailKey, reviewing };
  }
  return { state: s.state, since: s.since, detail: s.detail, detailKey: s.detailKey, reviewing: false };
};

/** Codex's app state → the thread ids it still lists as unread (every account, every host). */
export const unreadThreads = (state: unknown): Set<string> => {
  const out = new Set<string>();
  const byIdentity = obj(obj(obj(state)["electron-thread-read-state-v1"]).unreadByIdentity);
  for (const hosts of Object.values(byIdentity))
    for (const ids of Object.values(obj(hosts))) for (const id of arr(ids)) if (typeof id === "string") out.add(id);
  return out;
};

// ---- ranking ----

/** A guessed approval never climbs past L1: it may only be a slow tool. Silent sessions stop calling. */
export const levelFor = (
  state: OwnState,
  waitedS: number,
  reviewing: boolean,
  o: { guessed?: boolean; quietS?: number } = {},
): OwnLevel | null => {
  if (!NEEDS.has(state) || reviewing) return null;
  if ((o.quietS ?? 0) >= (state === "approval" ? QUIET_APPROVAL_S : QUIET_NEEDS_S)) return null;
  if (o.guessed) return "L1";
  return waitedS >= ESCALATE_S[2] ? "L3" : waitedS >= ESCALATE_S[1] ? "L2" : "L1";
};
/** A session that asked and then went silent this long was most likely closed. */
export const QUIET_NEEDS_S = 30 * 60;
/** An approval nobody answered and nothing followed: the tool was killed or Codex quit (owner wants a calm pet). */
export const QUIET_APPROVAL_S = 10 * 60;

/** Most urgent first: sessions that want the person, longest wait first; then the rest, newest first. */
export const rank = (views: OwnSessionView[]): OwnSessionView[] =>
  [...views].sort((a, b) => {
    const na = a.level !== null;
    const nb = b.level !== null;
    if (na !== nb) return na ? -1 : 1;
    return na ? a.since - b.since : b.since - a.since;
  });
