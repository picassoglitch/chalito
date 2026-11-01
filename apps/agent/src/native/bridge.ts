import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sessionLink, type AgentEvent } from "@chalito/protocol";
import type { AgentCore } from "../agent-core.js";
import type { AgentStore } from "../store.js";
import { NativeHookRequest, NATIVE_APPS, type NativeHookReply, type NativeProvider } from "./protocol.js";

interface LinkedSession {
  sid: string;
  provider: NativeProvider;
  label: string;
  cwd: string;
  seq: number;
  active: number;
  at: number;
  pending: Set<AbortController>;
  tail: Promise<void>;
  ready: Promise<void>;
}

export const NATIVE_SID_PREFIX = "native-";
// Claude Code runs about ten read-only tools in parallel; these only bound a runaway caller.
const MAX_ACTIVE_PER_SESSION = 16;
const MAX_PENDING = 32;
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
      enabled: (provider: NativeProvider) => boolean;
      workspaceFor: (cwd: string) => string | null;
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

  async handle(raw: unknown, signal: AbortSignal): Promise<NativeHookReply> {
    const parsed = NativeHookRequest.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: "bad_params" };
    const r = parsed.data;
    if (this.#closed || signal.aborted) return { ok: false, reason: "not_running" };
    const label = this.d.workspaceFor(r.cwd);
    // Owner 2026-10-31: outside Chalito workspaces the hook gives no decision at all.
    if (!label) return { ok: true, pass: true };
    if (!this.d.enabled(r.provider)) return { ok: false, reason: "connector_disabled" };
    for (const [oldKey, session] of this.#sessions)
      if (!session.active && this.d.now() - session.at > 60 * 60_000) {
        this.#sessions.delete(oldKey);
        void this.#end(session.sid, "completed");
      }
    const key = JSON.stringify([r.provider, r.nativeSessionId, r.cwd]);
    let s = this.#sessions.get(key);
    if (!s && r.event === "end") return { ok: true };
    if (!s) {
      // The same-user socket is not an unlimited session or approval allocator.
      if (this.#sessions.size >= 32) return { ok: false, reason: "session_limit" };
      s = {
        sid: `${NATIVE_SID_PREFIX}${randomUUID()}`,
        provider: r.provider,
        label,
        cwd: r.cwd,
        seq: 0,
        active: 0,
        at: this.d.now(),
        pending: new Set(),
        tail: Promise.resolve(),
        ready: Promise.resolve(),
      };
      this.#sessions.set(key, s);
      this.#saveLedger();
      const created = s;
      created.ready = (async () => {
        await this.d.store.upsertSession(created.sid, {
          deviceId: this.d.deviceId,
          adapter: r.provider === "cursor" ? "acp" : r.provider === "claude" ? "claude-code" : "codex",
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
        await this.#event(created, {
          type: "session.started",
          adapter: r.provider === "cursor" ? "acp" : r.provider === "claude" ? "claude-code" : "codex",
          origin: "local:cli",
          permissionMode: "default",
        });
      })().catch((error: unknown) => {
        if (this.#sessions.get(key) === created) {
          this.#sessions.delete(key);
          this.#saveLedger();
        }
        throw error;
      });
    }
    const linked = s;
    await linked.ready;
    if (this.#closed || signal.aborted || !this.d.enabled(r.provider) || this.#sessions.get(key) !== linked)
      return { ok: false, reason: "connector_disabled" };
    linked.at = this.d.now();
    const connection = { ok: true, sid: linked.sid, url: sessionLink(linked.sid, this.d.locale()) };
    if (r.event === "end") {
      this.#sessions.delete(key);
      for (const pending of linked.pending) pending.abort();
      await this.#end(linked.sid, "completed");
      await this.#event(linked, { type: "session.state", state: "completed" });
      return connection;
    }
    if (r.event !== "permission" && r.event !== "tool") {
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
      return connection;
    }
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
    let announcing = Promise.resolve();
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
      const actualCwd = resolve(linked.cwd, (dirs[0] as string | undefined) ?? ".");
      if (name === "Bash") {
        // Codex sends argv, not a string: classify the real command, never an empty one.
        const cmd = input.command;
        if (Array.isArray(cmd) && cmd.length > 0 && cmd.every((a) => typeof a === "string"))
          input.command = cmd.map(shellQuote).join(" ");
        else if (typeof cmd !== "string" || !cmd.trim())
          return { ...connection, allow: false, reason: "unsupported_input" };
      }
      if (this.d.workspaceFor(actualCwd) !== linked.label)
        return { ...connection, allow: false, reason: "outside_workspace" };
      const outcome = await this.d.core.requestNativeTool({
        sid: linked.sid,
        cwd: actualCwd,
        toolName: name,
        input,
        forcePrompt: r.event === "permission" || hidesPath(input),
        signal: abort.signal,
        onRequested: (aid, expiresAt, risk) => {
          announced = true;
          announcing = this.d.store
            .upsertSession(linked.sid, { state: "waiting_approval", live: true, updatedAt: this.d.now() })
            .then(() => this.#event(linked, { type: "approval.requested", aid, risk, expiresAt }))
            .catch((error: unknown) => this.#warn("native.announce_failed", error, { sid: linked.sid }));
        },
      });
      return {
        ...connection,
        allow: outcome.allow && !abort.signal.aborted && this.d.enabled(r.provider),
        reason: outcome.reason,
      };
    } finally {
      signal.removeEventListener("abort", cancel);
      linked.pending.delete(abort);
      linked.active--;
      this.#pending--;
      // Bookkeeping only: a failed store write must never turn the decision into an error.
      try {
        await announcing;
        if (announced && this.#sessions.get(key) === linked) {
          const state = linked.active ? "waiting_approval" : "running";
          await this.d.store.upsertSession(linked.sid, { state, updatedAt: this.d.now() });
          await this.#event(linked, { type: "session.state", state });
        }
      } catch (error) {
        this.#warn("native.state_write_failed", error, { sid: linked.sid });
      }
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
