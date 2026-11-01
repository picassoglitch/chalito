import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { sessionLink, type AgentEvent } from "@chalito/protocol";
import type { AgentCore } from "../agent-core.js";
import type { AgentStore } from "../store.js";
import { expandHome } from "../workspace-path.js";
import {
  NativeHookRequest,
  NATIVE_APPS,
  nativeTargets,
  type NativeHookReply,
  type NativeProvider,
} from "./protocol.js";

interface LinkedSession {
  sid: string;
  provider: NativeProvider;
  label: string;
  cwd: string;
  /** Provider, native session and folder: lifecycle events find every label's session by it. */
  base: string;
  seq: number;
  active: number;
  at: number;
  pending: Set<AbortController>;
  tail: Promise<void>;
  /** Detached state writes, kept in order. */
  chain: Promise<void>;
  ready: Promise<void>;
}

export const NATIVE_SID_PREFIX = "native-";
// Claude Code runs about ten read-only tools in parallel; these only bound a runaway caller.
const MAX_ACTIVE_PER_SESSION = 16;
const MAX_PENDING = 32;
const MAX_SESSIONS = 32;
/** Tools whose targets are only file fields: these can be judged when the app runs outside the workspace. */
const FILE_TOOLS = new Set([
  "Read",
  "NotebookRead",
  "LS",
  "Glob",
  "Grep",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
]);
const errorText = (error: unknown) => (error instanceof Error ? error.message : "error");

/** Native apps retain their own login and execution. Only signed Chalito decisions leave this bridge. */
/** POSIX single-quote unless the word is plainly safe, so the classifier sees the words as run. */
const shellQuote = (a: string): string => (/^[A-Za-z0-9_/.,:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

/** Keys the classifier reads paths from, or whose text it reads as a command or file content. */
const READ_KEYS = new Set([
  "file_path",
  "path",
  "notebook_path",
  "pattern",
  "glob",
  "command",
  "content",
  "old_string",
  "new_string",
  "new_source",
  "working_directory",
  "cwd",
  "workdir",
  "description",
  "prompt",
]);
const looksLikePath = (v: string) => /^(~|\/|\.\.?[\\/]|[A-Za-z]:[\\/])/.test(v) || /(^|[\\/])\.\.([\\/]|$)/.test(v);
/** A path under a key the classifier doesn't read could skip its protected-file check: ask a human instead. */
const hidesPath = (input: Record<string, unknown>): boolean =>
  Object.entries(input).some(([k, v]) => !READ_KEYS.has(k) && typeof v === "string" && looksLikePath(v));

export class NativeBridge {
  #sessions = new Map<string, LinkedSession>();
  /** Sessions the store has not yet recorded as ended (an earlier run's, or a failed write). */
  #stale = new Set<string>();
  #pending = 0;
  #closed = false;
  constructor(
    private readonly d: {
      core: Pick<AgentCore, "requestNativeTool" | "sealer">;
      store: AgentStore;
      deviceId: string;
      /** `unreadable`: the app's settings or Chalito's record can't be read, which is not "turned off". */
      enabled: (provider: NativeProvider) => boolean | "unreadable";
      workspaceFor: (cwd: string) => string | null;
      /** Expands `~` in request paths (tests point it elsewhere). */
      home?: string;
      now: () => number;
      locale: () => "es" | "en";
      /** Local list of this device's live native sids, so a restart can mark them interrupted. */
      ledger?: string;
      log?: (event: string, meta: Record<string, unknown>) => void;
    },
  ) {}

  #warn(event: string, error: unknown, meta: Record<string, unknown> = {}): void {
    this.d.log?.(event, { ...meta, error: errorText(error) });
  }

  #saveLedger(): void {
    if (!this.d.ledger) return;
    const sids = [...new Set([...this.#stale, ...[...this.#sessions.values()].map((s) => s.sid)])];
    const temp = `${this.d.ledger}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify({ v: 1, sids })}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temp, this.d.ledger);
    } catch (error) {
      this.#warn("native.ledger_write_failed", error);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  /** Records the end of a session; a failure is logged and retried by the next startup sweep. */
  #end(sid: string, state: "completed" | "interrupted"): Promise<void> {
    this.#stale.add(sid);
    this.#saveLedger();
    return this.d.store.upsertSession(sid, { state, live: false, updatedAt: this.d.now() }).then(
      () => {
        this.#stale.delete(sid);
        this.#saveLedger();
      },
      (error: unknown) => this.#warn("native.session_end_failed", error, { sid, state }),
    );
  }

  /** At startup: sessions an earlier run left live (crash, kill) are reported interrupted. */
  async sweep(): Promise<void> {
    if (!this.d.ledger) return;
    try {
      if (existsSync(this.d.ledger)) {
        const data = JSON.parse(readFileSync(this.d.ledger, "utf8")) as { sids?: unknown };
        const live = new Set([...this.#sessions.values()].map((s) => s.sid));
        for (const sid of Array.isArray(data.sids) ? data.sids : [])
          if (typeof sid === "string" && sid.startsWith(NATIVE_SID_PREFIX) && sid.length < 128 && !live.has(sid))
            this.#stale.add(sid);
      }
    } catch (error) {
      this.#warn("native.ledger_read_failed", error);
    }
    await Promise.all(
      [...this.#stale].map(async (sid) => {
        try {
          await this.d.store.upsertSession(sid, { state: "interrupted", live: false, updatedAt: this.d.now() });
          this.#stale.delete(sid);
        } catch (error) {
          this.#warn("native.sweep_failed", error, { sid });
        }
      }),
    );
    this.#saveLedger();
  }

  #event(s: LinkedSession, event: Record<string, unknown>): Promise<void> {
    const seq = s.seq++;
    const write = s.tail.then(() =>
      this.d.store.writeEvent({
        v: 1,
        eid: randomUUID(),
        sid: s.sid,
        deviceId: this.d.deviceId,
        seq,
        t: this.d.now(),
        urgency: "normal",
        ...event,
      } as AgentEvent),
    );
    s.tail = write.catch(() => undefined);
    return write;
  }

  /** Store bookkeeping off the decision path, in order per session; a hung write never delays a decision. */
  #later(s: LinkedSession, event: string, work: () => Promise<void>): void {
    s.chain = s.chain.then(work).catch((error: unknown) => this.#warn(event, error, { sid: s.sid }));
  }

  /** Why this app's requests can't be judged right now, or null when its connector is on. */
  #refusal(provider: NativeProvider): string | null {
    const on = this.d.enabled(provider);
    return on === true ? null : on === "unreadable" ? "connector_unreadable" : "connector_disabled";
  }

  #expireIdle(): void {
    for (const [oldKey, session] of this.#sessions)
      if (!session.active && this.d.now() - session.at > 60 * 60_000) {
        this.#sessions.delete(oldKey);
        void this.#end(session.sid, "completed");
      }
  }

  /** The linked session for this native session in `label`, created on first use. */
  async #open(
    r: NativeHookRequest,
    label: string,
    base: string,
    signal: AbortSignal,
  ): Promise<{ key: string; s: LinkedSession } | NativeHookReply> {
    const key = JSON.stringify([r.provider, r.nativeSessionId, r.cwd, label]);
    let s = this.#sessions.get(key);
    if (!s) {
      // The same-user socket is not an unlimited session allocator: the oldest idle session makes room.
      if (this.#sessions.size >= MAX_SESSIONS) {
        let oldest: [string, LinkedSession] | undefined;
        for (const entry of this.#sessions)
          if (!entry[1].active && (!oldest || entry[1].at < oldest[1].at)) oldest = entry;
        if (!oldest) return { ok: false, reason: "session_limit" };
        this.#sessions.delete(oldest[0]);
        void this.#end(oldest[1].sid, "completed");
      }
      const created: LinkedSession = {
        sid: `${NATIVE_SID_PREFIX}${randomUUID()}`,
        provider: r.provider,
        label,
        cwd: r.cwd,
        base,
        seq: 0,
        active: 0,
        at: this.d.now(),
        pending: new Set(),
        tail: Promise.resolve(),
        chain: Promise.resolve(),
        ready: Promise.resolve(),
      };
      s = created;
      this.#sessions.set(key, created);
      this.#saveLedger();
      const adapter = r.provider === "cursor" ? "acp" : r.provider === "claude" ? "claude-code" : "codex";
      let recorded = false;
      created.ready = (async () => {
        await this.d.store.upsertSession(created.sid, {
          deviceId: this.d.deviceId,
          adapter,
          appId: NATIVE_APPS[r.provider],
          kind: "agent",
          control: "approvals",
          label,
          cwdLabel: label,
          state: "running",
          live: true,
          permissionMode: "default",
          updatedAt: this.d.now(),
        });
        recorded = true;
        await this.#event(created, {
          type: "session.started",
          adapter,
          origin: "local:cli",
          permissionMode: "default",
        });
      })().catch((error: unknown) => {
        if (this.#sessions.get(key) === created) {
          this.#sessions.delete(key);
          this.#saveLedger();
        }
        // The row exists without its start event: end it so the ledger and sweep still clean it up.
        if (recorded) void this.#end(created.sid, "interrupted");
        throw error;
      });
    }
    const linked = s;
    await linked.ready;
    if (this.#closed || signal.aborted) return { ok: false, reason: "not_running" };
    const refusal = this.#refusal(r.provider);
    if (refusal) return { ok: false, reason: refusal };
    if (this.#sessions.get(key) !== linked) return { ok: false, reason: "session_ended" };
    linked.at = this.d.now();
    return { key, s: linked };
  }

  #connection(s: LinkedSession) {
    return { ok: true, sid: s.sid, url: sessionLink(s.sid, this.d.locale()) };
  }

  async handle(raw: unknown, signal: AbortSignal): Promise<NativeHookReply> {
    const parsed = NativeHookRequest.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: "bad_params" };
    const r = parsed.data;
    if (this.#closed || signal.aborted) return { ok: false, reason: "not_running" };
    // Owner 2026-10-31: gate where the action lands (cwd, roots, shell folder, files), not where the app opened.
    const home = this.d.home ?? homedir();
    const targets = nativeTargets({ cwd: r.cwd, roots: r.workspaceRoots, input: r.input }, home) ?? [r.cwd];
    const labels = [...new Set(targets.map((t) => this.d.workspaceFor(t)).filter((l): l is string => l !== null))];
    const tool = r.event === "permission" || r.event === "tool";
    const base = JSON.stringify([r.provider, r.nativeSessionId, r.cwd]);
    // Lifecycle events reach every session this native session opened, wherever its actions landed.
    const opened = tool ? [] : [...this.#sessions.entries()].filter(([, s]) => s.base === base);
    // Owner 2026-10-31: outside Chalito workspaces the hook gives no decision at all.
    if (!labels.length && !opened.length) return { ok: true, pass: true };
    if (labels.length > 1) return { ok: false, reason: "ambiguous_path" };
    const refusal = this.#refusal(r.provider);
    if (refusal) return { ok: false, reason: refusal };
    this.#expireIdle();
    if (r.event === "end") {
      let reply: NativeHookReply = { ok: true };
      for (const [key, linked] of opened) {
        this.#sessions.delete(key);
        for (const pending of linked.pending) pending.abort();
        await this.#end(linked.sid, "completed");
        await this.#event(linked, { type: "session.state", state: "completed" });
        reply = this.#connection(linked);
      }
      return reply;
    }
    const sessions = opened.map(([, s]) => s);
    let mine: { key: string; s: LinkedSession } | undefined;
    if (labels[0]) {
      const got = await this.#open(r, labels[0], base, signal);
      if (!("s" in got)) return got;
      mine = got;
      if (!sessions.includes(got.s)) sessions.unshift(got.s);
    }
    if (!tool) {
      for (const linked of sessions) {
        if (r.text) {
          const ct = await this.d.core.sealer.seal({ text: r.text }, `event:${linked.sid}`);
          await this.#event(linked, {
            type: r.event === "prompt" ? "message.user" : "message.assistant",
            ...(r.event === "prompt" ? { origin: "local:cli" } : {}),
            ct,
          });
        }
        if (r.event === "prompt") {
          await this.d.store.upsertSession(linked.sid, { state: "running", updatedAt: this.d.now() });
          await this.#event(linked, { type: "session.state", state: "running" });
        }
        if (r.event === "stop" && linked.active === 0) {
          await this.d.store.upsertSession(linked.sid, { state: "idle", updatedAt: this.d.now() });
          await this.#event(linked, { type: "session.state", state: "idle" });
        }
      }
      return this.#connection(sessions[0]!);
    }
    // A tool request always has its label: no target inside a workspace already passed above.
    const { key, s: linked } = mine!;
    const connection = this.#connection(linked);
    if (!r.toolName || !r.input) return { ...connection, allow: false, reason: "bad_params" };
    if (this.#pending >= MAX_PENDING || linked.active >= MAX_ACTIVE_PER_SESSION)
      return { ...connection, allow: false, reason: "busy" };
    this.#pending++;
    linked.active++;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) abort.abort();
    linked.pending.add(abort);
    let announced = false;
    try {
      const name = r.provider === "cursor" && r.toolName === "Shell" ? "Bash" : r.toolName;
      const input = { ...r.input };
      // Cursor's filesystem tools may name their target `path`; two different targets are refused.
      if (typeof input.path === "string") {
        if (input.file_path === undefined) input.file_path = input.path;
        else if (input.file_path !== input.path) return { ...connection, allow: false, reason: "ambiguous_path" };
      }
      // Each app names the shell's folder differently; two that disagree are refused, not guessed.
      const dirs = [input.working_directory, input.cwd, input.workdir].filter((v) => v !== undefined);
      if (dirs.some((v) => typeof v !== "string") || new Set(dirs).size > 1)
        return { ...connection, allow: false, reason: "ambiguous_path" };
      const actualCwd = resolve(linked.cwd, expandHome((dirs[0] as string | undefined) ?? ".", home));
      if (name === "Bash") {
        // Codex sends argv, not a string: classify the real command, never an empty one.
        const cmd = input.command;
        if (Array.isArray(cmd) && cmd.length > 0 && cmd.every((a) => typeof a === "string"))
          input.command = cmd.map(shellQuote).join(" ");
        else if (typeof cmd !== "string" || !cmd.trim())
          return { ...connection, allow: false, reason: "unsupported_input" };
      }
      let classifyCwd = actualCwd;
      let unsure = false;
      if (this.d.workspaceFor(actualCwd) !== linked.label) {
        const inside = targets.find((t) => this.d.workspaceFor(t) === linked.label)!;
        if (FILE_TOOLS.has(name)) {
          // The app runs outside the workspace yet names a file in it: judge the file where it lands.
          for (const k of ["file_path", "notebook_path", "path"])
            if (typeof input[k] === "string") input[k] = resolve(actualCwd, expandHome(input[k], home));
          classifyCwd = this.d.workspaceFor(dirname(inside)) === linked.label ? dirname(inside) : inside;
        } else if (this.d.workspaceFor(linked.cwd) === linked.label) {
          // A session opened in the workspace may not move its shell out of it.
          return { ...connection, allow: false, reason: "outside_workspace" };
        } else {
          // Only an open root (Cursor) is in the workspace: where it runs is unclear, so a human decides.
          classifyCwd = inside;
          unsure = true;
        }
      }
      const outcome = await this.d.core.requestNativeTool({
        sid: linked.sid,
        cwd: classifyCwd,
        toolName: name,
        input,
        forcePrompt: unsure || r.event === "permission" || hidesPath(input),
        signal: abort.signal,
        onRequested: (aid, expiresAt, risk) => {
          announced = true;
          this.#later(linked, "native.announce_failed", async () => {
            await this.d.store.upsertSession(linked.sid, {
              state: "waiting_approval",
              live: true,
              updatedAt: this.d.now(),
            });
            await this.#event(linked, { type: "approval.requested", aid, risk, expiresAt });
          });
        },
      });
      const refusal = this.#closed ? "not_running" : this.#refusal(r.provider);
      const ended = this.#sessions.get(key) !== linked;
      if (refusal || ended || abort.signal.aborted)
        return { ...connection, allow: false, reason: refusal ?? (ended ? "session_ended" : outcome.reason) };
      return { ...connection, allow: outcome.allow, reason: outcome.reason };
    } finally {
      signal.removeEventListener("abort", cancel);
      linked.pending.delete(abort);
      linked.active--;
      this.#pending--;
      // Bookkeeping only: a failed or hung store write must never touch the decision.
      if (announced)
        this.#later(linked, "native.state_write_failed", async () => {
          if (this.#sessions.get(key) !== linked) return;
          const state = linked.active ? "waiting_approval" : "running";
          await this.d.store.upsertSession(linked.sid, { state, updatedAt: this.d.now() });
          await this.#event(linked, { type: "session.state", state });
        });
    }
  }

  /** Cancels the provider's requests; resolves once its sessions are recorded interrupted. */
  disconnect(provider: NativeProvider): Promise<void> {
    const ended: Promise<void>[] = [];
    for (const [key, session] of this.#sessions)
      if (session.provider === provider) {
        for (const pending of session.pending) pending.abort();
        this.#sessions.delete(key);
        ended.push(this.#end(session.sid, "interrupted"));
      }
    return Promise.all(ended).then(() => undefined);
  }
  connected(provider: NativeProvider): boolean {
    return (
      !this.#closed &&
      [...this.#sessions.values()].some((s) => s.provider === provider && this.d.now() - s.at < 120_000)
    );
  }
  close(): Promise<void> {
    this.#closed = true;
    return Promise.all((["codex", "claude", "cursor"] as const).map((p) => this.disconnect(p))).then(() => undefined);
  }
}
