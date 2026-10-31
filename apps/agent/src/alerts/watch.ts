import type { AdapterEvent } from "@chalito/adapters";

/** Stuck and stall detection over the tool calls the agent already sees (from Alux, by Omar (homiomar)). */

export interface AlertsConfig {
  /** A running turn with no output this long is stalled. */
  stallTimeout: number;
  stuckFailures: number;
  stuckWindow: number;
}

export interface Run {
  cmd: string;
  ok: boolean;
}

export interface AgentAlert {
  kind: "stuck" | "stalled";
  /** When the turn started (epoch ms): keys the alert, so each kind fires once per turn. */
  turn: number;
  cmd?: string;
  count?: number;
}

/** One command failing `failures`+ times among the last `window` runs, its latest run failing too (Alux's looping()). */
export const looping = (
  runs: readonly Run[],
  failures: number,
  window: number,
): { cmd: string; count: number } | null => {
  const recent = runs.slice(-window);
  const fails = new Map<string, number>();
  for (const r of recent) if (!r.ok) fails.set(r.cmd, (fails.get(r.cmd) ?? 0) + 1);
  for (const [cmd, count] of fails)
    if (count >= failures && recent.findLast((r) => r.cmd === cmd)?.ok === false) return { cmd, count };
  return null;
};

const MAX_CMD = 200;

/** The shell command a tool call runs (Claude Code's and Codex's `Bash` carry `input.command`), else null. */
export const commandOf = (input: Record<string, unknown>): string | null => {
  const c = input.command;
  if (typeof c !== "string") return null;
  const one = c.replace(/\s+/g, " ").trim();
  return one ? one.slice(0, MAX_CMD) : null;
};

const BUSY = new Set(["starting", "running", "waiting_approval", "waiting_input"]);

/** One session's turn: its tool runs, open calls, last output and which alerts already fired. */
export class SessionWatch {
  #state = "idle";
  #turn: number | null = null;
  #runs: Run[] = [];
  #open = new Map<string, string | null>();
  #fired = new Set<AgentAlert["kind"]>();
  #lastOutputAt = 0;
  /** This turn's open questions and approvals: the turn waits on the person, which is never a stall. */
  #waits = new Set<symbol>();

  constructor(private readonly cfg: AlertsConfig) {}

  pause(): symbol {
    const id = Symbol("wait");
    this.#waits.add(id);
    return id;
  }

  /** The person answered: the quiet clock starts over. An earlier turn's wait settling late changes nothing. */
  resume(id: symbol, now: number): void {
    if (this.#waits.delete(id)) this.#lastOutputAt = now;
  }

  get running(): boolean {
    return this.#state === "running";
  }

  /** Feeds one adapter event; returns a stuck alert the first time this turn goes in circles. */
  observe(e: AdapterEvent, now: number): AgentAlert | null {
    this.#lastOutputAt = now;
    if (e.type === "state") {
      // Back from waiting on the person is the same turn; anything else entering a busy state is a new one.
      if (BUSY.has(e.state) && !BUSY.has(this.#state)) {
        this.#turn = now;
        this.#runs = [];
        this.#open.clear();
        this.#fired.clear();
        // Backstop: nothing from an earlier turn can still be waiting on the person.
        this.#waits.clear();
      }
      this.#state = e.state;
      return null;
    }
    if (e.type === "tool_started") {
      this.#open.set(e.toolUseId, commandOf(e.input));
      return null;
    }
    if (e.type !== "tool_finished") return null;
    const cmd = this.#open.get(e.toolUseId);
    this.#open.delete(e.toolUseId);
    if (!cmd) return null;
    this.#runs.push({ cmd, ok: e.ok });
    if (this.#runs.length > this.cfg.stuckWindow) this.#runs.shift();
    const loop = looping(this.#runs, this.cfg.stuckFailures, this.cfg.stuckWindow);
    return loop ? this.#fire({ kind: "stuck", ...loop }) : null;
  }

  /** Milliseconds until this turn counts as stalled, or null when it isn't running. */
  stallIn(now: number): number | null {
    if (!this.running || this.#waits.size > 0 || this.#fired.has("stalled")) return null;
    return Math.max(0, this.#lastOutputAt + this.cfg.stallTimeout - now);
  }

  /** A stall alert once the running turn has been quiet for the whole timeout. */
  checkStall(now: number): AgentAlert | null {
    return this.stallIn(now) === 0 ? this.#fire({ kind: "stalled" }) : null;
  }

  #fire(a: Omit<AgentAlert, "turn">): AgentAlert | null {
    if (this.#turn === null || this.#fired.has(a.kind)) return null;
    this.#fired.add(a.kind);
    return { ...a, turn: this.#turn };
  }
}

/** Every live session's watch, the stall timers, and where alerts go (the agent writes an `agent.alert` event). */
export class AlertWatcher {
  #watches = new Map<string, { watch: SessionWatch; timer?: { clear(): void } }>();

  constructor(
    private readonly d: {
      config: () => AlertsConfig;
      now: () => number;
      schedule: (fn: () => void, ms: number) => { clear(): void };
      raise: (sid: string, alert: AgentAlert) => void;
    },
  ) {}

  observe(sid: string, e: AdapterEvent): void {
    let w = this.#watches.get(sid);
    if (!w) this.#watches.set(sid, (w = { watch: new SessionWatch(this.d.config()) }));
    const alert = w.watch.observe(e, this.d.now());
    if (alert) this.d.raise(sid, alert);
    this.#sync(sid, w);
  }

  /** `work` waits on the person (an open question or approval): no stall while it's pending. */
  async whileWaiting<T>(sid: string, work: Promise<T>): Promise<T> {
    let w = this.#watches.get(sid);
    if (!w) this.#watches.set(sid, (w = { watch: new SessionWatch(this.d.config()) }));
    const id = w.watch.pause();
    this.#sync(sid, w);
    try {
      return await work;
    } finally {
      w.watch.resume(id, this.d.now());
      if (this.#watches.get(sid) === w) this.#sync(sid, w);
    }
  }

  /** One timer per running turn: output only moves the deadline, which the timer re-reads when it fires. */
  #sync(sid: string, w: { watch: SessionWatch; timer?: { clear(): void } }): void {
    if (w.watch.stallIn(this.d.now()) === null) {
      w.timer?.clear();
      w.timer = undefined;
    } else if (!w.timer) this.#arm(sid);
  }

  forget(sid: string): void {
    this.#watches.get(sid)?.timer?.clear();
    this.#watches.delete(sid);
  }

  #arm(sid: string): void {
    const w = this.#watches.get(sid);
    if (!w) return;
    w.timer?.clear();
    w.timer = undefined;
    const due = w.watch.stallIn(this.d.now());
    if (due === null) return;
    w.timer = this.d.schedule(() => {
      if (this.#watches.get(sid) !== w) return;
      w.timer = undefined;
      const alert = w.watch.checkStall(this.d.now());
      if (alert) this.d.raise(sid, alert);
      else this.#arm(sid);
    }, due);
  }
}
