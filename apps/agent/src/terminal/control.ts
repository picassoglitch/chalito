import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  AgentEvent,
  RAW_SHELL_APP_ID,
  TERMINAL_INPUT_MAX,
  isSignedOrigin,
  type Origin,
  type ResolutionReason,
  type SealedEnvelope,
  type TerminalCloseReason,
} from "@chalito/protocol";
import type { Policy } from "../policy/schema.js";
import type { TerminalLaunch } from "./driver.js";
import { OutputStream, TokenBucket, type OutputLimits } from "./output.js";
import { PtyUnavailableError, type PtyBackend, type PtyProcess } from "./pty.js";

/**
 * Remote terminals on this device (Connect engine, contract v2): who may open one, when, and
 * how its bytes move.
 *
 * - Off unless the person turned remote terminal on locally (`policy.remoteTerminal.enabled`,
 *   written only by the OS-authenticated path in toggle.ts). The raw shell (appId "shell") also
 *   needs `rawShell`, its own local switch. Turning either off closes what it covered.
 * - `terminal.open` comes only from a signed, trusted client. Before anything runs the person
 *   approves that terminal on a trusted device: a `terminal` approval, HIGH with a passkey
 *   step-up. A deny or an expiry ends it.
 * - Nothing runs or is typed unless the desktop app shows its always-on-top indicator (its poll
 *   is the heartbeat, shared with computer control); if it stops showing it, open terminals close.
 * - The kill switch (Ctrl+Alt+Esc, tray "Detener control", indicator, panel) closes every terminal.
 * - Input and output are sealed end to end (the cloud only relays); opens and input are rate
 *   limited; the audit has metadata only (ids, sizes, counts, reasons), never bytes.
 */

export interface TerminalApprovalOutcome {
  allow: boolean;
  reason: ResolutionReason;
  byDeviceId?: string;
}

export interface TerminalDeps {
  deviceId: string;
  policy: () => Policy["remoteTerminal"];
  /** The workspaces the person allowed locally (label → path). */
  workspaces: () => { label: string; path: string }[];
  /** A recipe's terminal driver (drivers/registry.ts + driver.ts), or null when there is none. */
  launch: (appId: string) => TerminalLaunch | null;
  /** The person's raw shell (driver.ts `rawShellLaunch`). */
  rawShell: () => TerminalLaunch;
  /** Loaded on first use; throws PtyUnavailableError where it can't run. */
  pty: () => PtyBackend;
  /** argv[0] → absolute path (PATH lookup), or null when it isn't installed. */
  resolve: (program: string) => string | null;
  /** The environment the terminal's program starts with (before Chalito's own variables). */
  env: () => Record<string, string | undefined>;
  /** A `terminal` approval (HIGH, passkey step-up) for this terminal, announced to the person's devices. */
  requestApproval: (
    tid: string,
    input: { origin: Origin; details: { toolName: string; input: unknown; reasons: string[] } },
    onRequested: (aid: string, expiresAt: number) => void,
  ) => Promise<TerminalApprovalOutcome>;
  seal: (value: unknown, aad: string) => Promise<SealedEnvelope>;
  writeEvent: (e: AgentEvent) => Promise<void>;
  upsertSession: (tid: string, data: Record<string, unknown>) => Promise<void>;
  audit: (type: string, meta: Record<string, unknown>) => void;
  /** Reports the state to the account (`terminal.changed` DeviceEvent). */
  publish: (state: { enabled: boolean; rawShell: boolean; activeSessions: number; by?: string }) => void;
  now: () => number;
  locale?: () => "es" | "en";
  log?: (msg: string, meta: Record<string, unknown>) => void;
  setTimer?: (fn: () => void, ms: number) => { clear(): void };
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  /** How long a granted terminal waits for the desktop app to show the indicator (default 3 s). */
  indicatorWaitMs?: number;
  /** The desktop app polls every 500 ms; a heartbeat older than this means it's gone (default 2 s). */
  heartbeatTtlMs?: number;
  /** Open terminals close when the indicator has been missing this long (default 10 s). */
  indicatorGraceMs?: number;
  /** Device-wide `terminal.output` events per minute (default 900, i.e. 15/s; burst 60). */
  eventsPerMinute?: number;
  /** Opens per minute on this device (default 6). */
  opensPerMinute?: number;
  output?: Partial<OutputLimits>;
}

/** pending: waiting for the approval; starting: approved, waiting for the indicator and the PTY. */
export type TerminalState = "pending" | "starting" | "running" | "closed";

interface Term {
  tid: string;
  appId: string;
  name: string;
  label: string;
  workspaceLabel: string;
  cwd: string;
  rawShell: boolean;
  origin: Origin;
  state: TerminalState;
  cols: number;
  rows: number;
  since: number | null;
  seq: number;
  pty: PtyProcess | null;
  out: OutputStream | null;
  input: TokenBucket;
  commands: TokenBucket;
  inputChars: number;
  rateAudited: number;
  killTimer: { clear(): void } | null;
}

export interface TerminalStatus {
  enabled: boolean;
  rawShell: boolean;
  /** Approved terminals (starting or running): the desktop shows the indicator while this isn't empty. */
  active: { sid: string; label: string; since: number }[];
  /** Terminals waiting for the person's approval. */
  pending: { sid: string; label: string }[];
}

export type TerminalResult = { ok: true; tid?: string } | { ok: false; reason: string };

/** What the approval says, on the person's trusted device. */
const REASONS = {
  es: {
    app: [
      "Se abrirá esta app de terminal en esta computadora y podrás verla y escribir en ella desde tu navegador hasta que la cierres.",
      "Mientras esté abierta verás un aviso en pantalla; se cierra con Ctrl+Alt+Esc o con «Detener control».",
    ],
    shell: [
      "Se abrirá una SHELL COMPLETA de esta computadora: podrá ejecutar cualquier comando con tu usuario.",
      "Mientras esté abierta verás un aviso en pantalla; se cierra con Ctrl+Alt+Esc o con «Detener control».",
    ],
  },
  en: {
    app: [
      "This terminal app will open on this computer and you'll see it and type into it from your browser until you close it.",
      "While it's open you'll see a notice on screen; Ctrl+Alt+Esc or “Stop control” closes it.",
    ],
    shell: [
      "A FULL SHELL on this computer will open: it can run any command as your user.",
      "While it's open you'll see a notice on screen; Ctrl+Alt+Esc or “Stop control” closes it.",
    ],
  },
} as const;

/** Variables the terminal's program never inherits from the agent. */
const STRIPPED_ENV = /^(CHALITO_|SUPABASE_|npm_config_|NODE_OPTIONS$|BUN_)/;

const defaultTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  return { clear: () => clearTimeout(t) };
};

export class TerminalControl {
  readonly #terms = new Map<string, Term>();
  #beat: { at: number; indicatorShown: boolean } | null = null;
  #indicatorMissingSince: number | null = null;
  #backend: PtyBackend | null = null;
  readonly #events: TokenBucket;
  readonly #opens: TokenBucket;
  /** Starts as "off, nobody": an agent that never had it on reports nothing. */
  #lastPublished = JSON.stringify([false, false, 0]);

  constructor(private readonly d: TerminalDeps) {
    const perMin = d.eventsPerMinute ?? 900;
    this.#events = new TokenBucket(
      () => Math.min(60, perMin),
      () => perMin,
      d.now,
    );
    const opens = d.opensPerMinute ?? 6;
    this.#opens = new TokenBucket(
      () => opens,
      () => opens,
      d.now,
    );
  }

  enabled(): boolean {
    return this.d.policy()?.enabled === true;
  }

  rawShellEnabled(): boolean {
    const p = this.d.policy();
    return p?.enabled === true && p.rawShell === true;
  }

  has(tid: string): boolean {
    return this.#terms.has(tid);
  }

  get #timer() {
    return this.d.setTimer ?? defaultTimer;
  }

  get #sleep() {
    return this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  status(): TerminalStatus {
    const all = [...this.#terms.values()];
    return {
      enabled: this.enabled(),
      rawShell: this.rawShellEnabled(),
      active: all
        .filter((t) => t.state === "starting" || t.state === "running")
        .map((t) => ({ sid: t.tid, label: t.label, since: t.since ?? 0 })),
      pending: all.filter((t) => t.state === "pending").map((t) => ({ sid: t.tid, label: t.label })),
    };
  }

  /** The desktop app's poll (shared with computer control): whether the indicator is on screen. */
  heartbeat(indicatorShown: boolean): TerminalStatus {
    this.#beat = { at: this.d.now(), indicatorShown };
    return this.status();
  }

  // ---- commands (agent-core dispatch) ---------------------------------------------------

  /**
   * `terminal.open`: checks everything that can be checked now, creates the terminal's session
   * row and returns its id; the approval and the start happen in the background (`#start`).
   */
  async open(
    input: { appId: string; workspaceLabel: string; cols: number; rows: number },
    origin: Origin,
  ): Promise<TerminalResult> {
    if (!this.enabled()) return this.#refuse("terminal_disabled", { appId: input.appId, origin });
    if (!origin.startsWith("client:") || !isSignedOrigin(origin))
      return this.#refuse("origin_disabled", { appId: input.appId, origin });
    const shell = input.appId === RAW_SHELL_APP_ID;
    if (shell && !this.rawShellEnabled()) return this.#refuse("raw_shell_disabled", { appId: input.appId, origin });
    const launch = shell ? this.d.rawShell() : this.d.launch(input.appId);
    if (!launch || launch.rawShell !== shell) return this.#refuse("unknown_app", { appId: input.appId, origin });
    const ws = this.d.workspaces().find((w) => w.label === input.workspaceLabel);
    if (!ws) return this.#refuse("unknown_workspace", { appId: input.appId, origin });
    const open = [...this.#terms.values()].filter((t) => t.state !== "closed").length;
    if (open >= (this.d.policy()?.maxSessions ?? 1))
      return this.#refuse("terminal_limit", { appId: input.appId, origin });
    if (!this.#desktopPresent()) return this.#refuse("terminal_unavailable", { appId: input.appId, why: "no_desktop" });
    try {
      this.#pty();
    } catch (err) {
      const why = err instanceof PtyUnavailableError ? "no_pty" : "pty_failed";
      return this.#refuse("terminal_unavailable", { appId: input.appId, why });
    }
    const program = this.#program(launch.command[0]!);
    if (!program) return this.#refuse("app_not_installed", { appId: input.appId });
    if (!this.#opens.take()) return this.#refuse("rate_limited", { appId: input.appId, origin });

    const tid = this.d.newId?.() ?? randomUUID();
    const now = this.d.now();
    const t: Term = {
      tid,
      appId: launch.appId,
      name: launch.name,
      label: `Terminal · ${launch.name.slice(0, 40)} · ${ws.label}`,
      workspaceLabel: ws.label,
      cwd: ws.path,
      rawShell: shell,
      origin,
      state: "pending",
      cols: input.cols,
      rows: input.rows,
      since: null,
      seq: 0,
      pty: null,
      out: null,
      input: new TokenBucket(
        () => this.d.policy()?.maxInputPerMinute ?? 0,
        () => this.d.policy()?.maxInputPerMinute ?? 0,
        this.d.now,
      ),
      // Inputs + resizes: the hub batches keystrokes, so this is generous.
      commands: new TokenBucket(
        () => 120,
        () => 600,
        this.d.now,
      ),
      inputChars: 0,
      rateAudited: 0,
      killTimer: null,
    };
    this.#terms.set(tid, t);
    try {
      await this.d.upsertSession(tid, {
        deviceId: this.d.deviceId,
        kind: "terminal",
        appId: t.appId,
        label: t.label,
        cwdLabel: t.workspaceLabel,
        state: "waiting_approval",
        updatedAt: now,
      });
    } catch {
      // No session row: don't leave a pending terminal holding the maxSessions slot.
      await this.#finish(t, "failed", undefined, true);
      return this.#refuse("terminal_unavailable", { appId: input.appId, why: "session_write_failed" });
    }
    this.d.audit("terminal.requested", { tid, appId: t.appId, rawShell: shell, origin, cols: t.cols, rows: t.rows });
    this.#publish();
    void this.#start(t, launch.command, program).catch((err: unknown) => {
      this.d.log?.("terminal.start_failed", { tid, error: err instanceof Error ? err.message : "error" });
      void this.#finish(t, "failed");
    });
    return { ok: true, tid };
  }

  /** `terminal.input` (already opened by agent-core): types into a running terminal. */
  input(tid: string, data: string, origin: Origin): TerminalResult {
    const t = this.#terms.get(tid);
    if (!t) return { ok: false, reason: "unknown_session" };
    const live = this.#live(t, origin);
    if (live) return live;
    if (data.length > TERMINAL_INPUT_MAX) return this.#refuseFor(t, "invalid", "input_too_long");
    if (!t.commands.take()) return this.#refuseFor(t, "rate_limited", "input");
    if (data.length > 0 && !t.input.take(data.length)) return this.#refuseFor(t, "rate_limited", "input");
    try {
      t.pty!.write(data);
    } catch {
      return { ok: false, reason: "terminal_not_running" };
    }
    t.inputChars += data.length;
    return { ok: true };
  }

  resize(tid: string, cols: number, rows: number, origin: Origin): TerminalResult {
    const t = this.#terms.get(tid);
    if (!t) return { ok: false, reason: "unknown_session" };
    if (t.state === "pending" && origin === t.origin) {
      // Before the start: the PTY opens at the latest size.
      t.cols = cols;
      t.rows = rows;
      return { ok: true };
    }
    const live = this.#live(t, origin);
    if (live) return live;
    if (!t.commands.take()) return this.#refuseFor(t, "rate_limited", "resize");
    try {
      t.pty!.resize(cols, rows);
    } catch {
      return { ok: false, reason: "terminal_not_running" };
    }
    t.cols = cols;
    t.rows = rows;
    return { ok: true };
  }

  /** `terminal.close` from a trusted client: any of the person's trusted clients may close it. */
  async close(tid: string, origin: Origin): Promise<TerminalResult> {
    const t = this.#terms.get(tid);
    if (!t || t.state === "closed") return { ok: false, reason: "unknown_session" };
    if (!isSignedOrigin(origin)) return { ok: false, reason: "origin_disabled" };
    await this.#finish(t, "closed");
    return { ok: true };
  }

  // ---- kill switch, policy, watchdog -----------------------------------------------------

  /** Closes every terminal now (pending ones too). Returns how many there were. */
  async kill(by: string): Promise<number> {
    const affected = [...this.#terms.values()].filter((t) => t.state !== "closed");
    if (affected.length === 0) return 0;
    this.d.audit("terminal.killed", { by, sessions: affected.length });
    await Promise.all(affected.map((t) => this.#finish(t, "killed", undefined, true)));
    this.#publish(by, true);
    return affected.length;
  }

  /** After any policy change: off closes everything, raw shell off closes the shells. */
  async onPolicyChange(): Promise<void> {
    const affected = [...this.#terms.values()].filter(
      (t) => t.state !== "closed" && (!this.enabled() || (t.rawShell && !this.rawShellEnabled())),
    );
    await Promise.all(affected.map((t) => this.#finish(t, "disabled", undefined, true)));
    this.#publish(affected.length ? "policy" : undefined);
  }

  /**
   * The watchdog (the daemon calls it every second): open terminals close once the desktop app
   * has stopped showing the indicator for `indicatorGraceMs`.
   */
  async tick(): Promise<void> {
    const running = [...this.#terms.values()].filter((t) => t.state === "running" || t.state === "starting");
    if (running.length === 0 || this.#indicatorShown()) {
      this.#indicatorMissingSince = null;
      return;
    }
    const now = this.d.now();
    this.#indicatorMissingSince ??= now;
    if (now - this.#indicatorMissingSince < (this.d.indicatorGraceMs ?? 10_000)) return;
    this.#indicatorMissingSince = null;
    this.d.audit("terminal.killed", { by: "indicator", sessions: running.length });
    await Promise.all(running.map((t) => this.#finish(t, "indicator", undefined, true)));
    this.#publish("indicator", true);
  }

  // ---- internals ------------------------------------------------------------------------

  #pty(): PtyBackend {
    this.#backend ??= this.d.pty();
    return this.#backend;
  }

  #program(argv0: string): string | null {
    // A bare name (PATH lookup) or an absolute path; never a relative path into the workspace.
    if (!isAbsolute(argv0) && (argv0.includes("/") || argv0.includes("\\"))) return null;
    return this.d.resolve(argv0);
  }

  #desktopPresent(): boolean {
    return !!this.#beat && this.d.now() - this.#beat.at <= (this.d.heartbeatTtlMs ?? 2000);
  }

  #indicatorShown(): boolean {
    return this.#desktopPresent() && this.#beat!.indicatorShown;
  }

  /** Why a running terminal can't take input or a resize right now, or null. */
  #live(t: Term, origin: Origin): TerminalResult | null {
    if (!origin.startsWith("client:") || !isSignedOrigin(origin))
      return this.#refuseFor(t, "origin_disabled", "origin");
    if (!this.enabled()) return this.#refuseFor(t, "terminal_disabled", "disabled");
    if (t.rawShell && !this.rawShellEnabled()) return this.#refuseFor(t, "raw_shell_disabled", "disabled");
    if (t.state !== "running" || !t.pty) return { ok: false, reason: "terminal_not_running" };
    if (!this.#indicatorShown()) return this.#refuseFor(t, "terminal_unavailable", "indicator");
    return null;
  }

  async #start(t: Term, argv: string[], program: string): Promise<void> {
    const command = argv.join(" ").slice(0, 500);
    let aid: string | null = null;
    const outcome = await this.d
      .requestApproval(
        t.tid,
        {
          origin: t.origin,
          details: {
            toolName: t.rawShell ? "raw_shell" : "terminal",
            input: { app: t.name, appId: t.appId, workspace: t.workspaceLabel, command },
            reasons: [...REASONS[this.d.locale?.() ?? "es"][t.rawShell ? "shell" : "app"]],
          },
        },
        (requested, expiresAt) => {
          aid = requested;
          void this.#event(t, {
            type: "approval.requested",
            aid: requested,
            risk: "HIGH",
            expiresAt,
            urgency: "high",
          }).catch(() => undefined);
        },
      )
      .catch((): TerminalApprovalOutcome => ({ allow: false, reason: "timeout_deny" }));
    if (aid)
      await this.#event(t, {
        type: "approval.resolved",
        aid,
        allow: outcome.allow,
        reason: outcome.reason,
        ...(outcome.byDeviceId ? { byDeviceId: outcome.byDeviceId } : {}),
      }).catch(() => undefined);
    // Closed, killed or turned off while the person was deciding: the answer no longer applies.
    if (t.state !== "pending") return;
    if (!this.enabled() || (t.rawShell && !this.rawShellEnabled())) return this.#finish(t, "disabled");
    this.d.audit(outcome.allow ? "terminal.granted" : "terminal.denied", {
      tid: t.tid,
      reason: outcome.reason,
      ...(outcome.byDeviceId ? { by: outcome.byDeviceId } : {}),
    });
    if (!outcome.allow) return this.#finish(t, "denied");

    // Approved: it now counts as active, so the desktop app shows the indicator. Nothing runs
    // unless the person can see that something does.
    t.state = "starting";
    t.since = this.d.now();
    this.#publish();
    const deadline = this.d.now() + (this.d.indicatorWaitMs ?? 3000);
    while (!this.#indicatorShown()) {
      if ((t.state as TerminalState) !== "starting") return;
      if (this.d.now() >= deadline) return this.#finish(t, "indicator");
      await this.#sleep(100);
    }
    if ((t.state as TerminalState) !== "starting") return;

    let exited: { exitCode: number } | null = null;
    const out = new OutputStream({
      send: (chunk) => this.#output(t, chunk),
      take: () => this.#events.take(),
      schedule: (fn, ms) => this.#timer(fn, ms),
      pause: () => t.pty?.pause?.(),
      resume: () => t.pty?.resume?.(),
      onError: (err) =>
        this.d.log?.("terminal.output_failed", { tid: t.tid, error: err instanceof Error ? err.message : "error" }),
      ...(this.d.output ? { limits: this.d.output } : {}),
    });
    t.out = out;
    try {
      t.pty = this.#pty().spawn(program, argv.slice(1), {
        cols: t.cols,
        rows: t.rows,
        cwd: t.cwd,
        env: this.#env(t),
        onData: (data) => out.push(data),
        onExit: (e) => {
          exited = { exitCode: e.exitCode };
          // Gone after the hang-up: no SIGKILL later (its pid could be someone else's by then).
          t.killTimer?.clear();
          t.killTimer = null;
          void this.#finish(t, "exited", e.exitCode);
        },
      });
    } catch (err) {
      this.d.log?.("terminal.spawn_failed", { tid: t.tid, error: err instanceof Error ? err.message : "error" });
      return this.#finish(t, "failed");
    }
    if (exited || (t.state as TerminalState) !== "starting") return;
    t.state = "running";
    this.d.audit("terminal.opened", {
      tid: t.tid,
      appId: t.appId,
      rawShell: t.rawShell,
      cols: t.cols,
      rows: t.rows,
      pty: this.#backend?.name,
    });
    await this.#event(t, {
      type: "terminal.started",
      tid: t.tid,
      appId: t.appId,
      origin: t.origin,
      cols: t.cols,
      rows: t.rows,
    });
    await this.d.upsertSession(t.tid, { state: "running", updatedAt: this.d.now() });
    this.#publish();
  }

  #env(t: Term): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.d.env()))
      if (v !== undefined && !STRIPPED_ENV.test(k) && !k.startsWith("npm_")) env[k] = v;
    // `chalito` refuses every security change from inside a session (cli.ts checks this).
    env.CHALITO_SESSION = t.tid;
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    return env;
  }

  async #output(t: Term, chunk: { data: string; dropped: number }): Promise<void> {
    // The seq is taken before sealing, so chunks keep their order even when written concurrently.
    const seq = t.seq++;
    const dataCt = await this.d.seal({ data: chunk.data }, `terminal:${t.tid}:${seq}`);
    await this.#write(t, seq, {
      type: "terminal.output",
      tid: t.tid,
      dataCt,
      ...(chunk.dropped > 0 ? { dropped: chunk.dropped } : {}),
    });
  }

  async #event(t: Term, partial: Record<string, unknown>): Promise<void> {
    await this.#write(t, t.seq++, partial);
  }

  async #write(t: Term, seq: number, partial: Record<string, unknown>): Promise<void> {
    const event = AgentEvent.parse({
      v: 1,
      eid: randomUUID(),
      sid: t.tid,
      deviceId: this.d.deviceId,
      seq,
      t: this.d.now(),
      urgency: "low",
      ...partial,
    });
    await this.d.writeEvent(event);
  }

  /** Ends a terminal once, whatever the cause: stops the program, flushes, reports, audits. */
  async #finish(t: Term, reason: TerminalCloseReason, exitCode?: number, quiet = false): Promise<void> {
    if (t.state === "closed") return;
    t.state = "closed";
    const pty = t.pty;
    if (pty && reason !== "exited") {
      try {
        pty.kill("SIGHUP");
      } catch {
        /* already gone */
      }
      // A program that ignores the hangup is killed for good shortly after.
      t.killTimer = this.#timer(() => {
        try {
          pty.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 2000);
    }
    const out = t.out;
    if (out) {
      // An exit flushes what the program printed last; anything else stops the stream now.
      if (reason === "exited") await out.drain(2000, this.#sleep);
      out.close();
    }
    this.#terms.delete(t.tid);
    await this.#event(t, {
      type: "terminal.closed",
      tid: t.tid,
      reason,
      ...(exitCode !== undefined && Number.isSafeInteger(exitCode) ? { exitCode } : {}),
    }).catch(() => undefined);
    const state =
      reason === "exited" ? (exitCode === 0 ? "completed" : "failed") : reason === "failed" ? "failed" : "interrupted";
    await this.d.upsertSession(t.tid, { state, updatedAt: this.d.now() }).catch(() => undefined);
    this.d.audit("terminal.closed", {
      tid: t.tid,
      appId: t.appId,
      reason,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(t.since ? { durationMs: this.d.now() - t.since } : {}),
      inputChars: t.inputChars,
      outputChars: out?.sentChars ?? 0,
      droppedChars: out?.droppedChars ?? 0,
    });
    if (!quiet) this.#publish();
  }

  #refuse(reason: string, meta: Record<string, unknown>): TerminalResult {
    this.d.audit("terminal.refused", { reason, ...meta });
    return { ok: false, reason };
  }

  /** A refused input/resize: audited once a minute per terminal (a typing flood shouldn't flood the audit). */
  #refuseFor(t: Term, reason: string, what: string): TerminalResult {
    const now = this.d.now();
    if (now - t.rateAudited > 60_000) {
      t.rateAudited = now;
      this.d.audit("terminal.refused", { tid: t.tid, reason, what });
    }
    return { ok: false, reason };
  }

  #publish(by?: string, force = false): void {
    const s = this.status();
    const state = {
      enabled: s.enabled,
      rawShell: s.rawShell,
      activeSessions: s.active.length,
      ...(by ? { by } : {}),
    };
    const key = JSON.stringify([state.enabled, state.rawShell, state.activeSessions]);
    if (!force && key === this.#lastPublished) return;
    this.#lastPublished = key;
    this.d.publish(state);
  }
}
