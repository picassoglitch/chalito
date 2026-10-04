/**
 * Desktop presence for the notifier (-41's contract): `devices.presence = {desktopActive}`
 * with `last_seen_at` refreshed while it holds. The notifier treats the desktop as present
 * when desktopActive && last_seen_at < 2 min, and then prefers the pet over phone channels.
 *
 * desktopActive = the user is at this machine and the pet can reach them: input seen
 * recently (not idle), not in Do Not Disturb. Fullscreen still counts as present: the pet
 * is damped to a glance, but the user is here. Changes are debounced so a brief idle blip
 * or a quick fullscreen toggle doesn't write; a heartbeat re-reports well inside 2 min.
 */
export interface PresenceSignals {
  /** OS reports recent input (not idle). */
  active: boolean;
  /** Screen locked / session switched away. */
  locked: boolean;
  fullscreen: boolean;
  dnd: boolean;
}

export interface Presence {
  desktopActive: boolean;
}

/** Where presence goes. The desktop's default is the local agent (see ipc.ts). */
export type PresenceSink = (p: Presence) => Promise<void>;

export const desktopActive = (s: PresenceSignals): boolean => s.active && !s.locked && !s.dnd;

export interface Timers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface PresenceOptions {
  /** Going active is reported quickly; going inactive waits longer (a blip isn't leaving). */
  activateDebounceMs?: number;
  deactivateDebounceMs?: number;
  /** Re-report while unchanged so last_seen_at stays fresh (< 2 min on the server). */
  heartbeatMs?: number;
  timers?: Timers;
  onError?: (err: unknown) => void;
}

export class PresenceReporter {
  #reported: boolean | null = null;
  #pending: boolean | null = null;
  #debounce: unknown = null;
  #heartbeat: unknown = null;
  readonly #t: Timers;
  readonly #o: Required<Omit<PresenceOptions, "timers" | "onError">>;

  constructor(
    private readonly sink: PresenceSink,
    private readonly opts: PresenceOptions = {},
  ) {
    this.#t = opts.timers ?? realTimers;
    this.#o = {
      activateDebounceMs: opts.activateDebounceMs ?? 1_000,
      deactivateDebounceMs: opts.deactivateDebounceMs ?? 15_000,
      heartbeatMs: opts.heartbeatMs ?? 45_000,
    };
  }

  /** The last value sent (null before the first report). */
  get reported(): boolean | null {
    return this.#reported;
  }

  update(signals: PresenceSignals): void {
    const next = desktopActive(signals);
    if (next === this.#pending) return;
    if (this.#debounce !== null) this.#t.clearTimeout(this.#debounce);
    this.#debounce = null;
    this.#pending = next;
    if (next === this.#reported) return;
    const wait = next ? this.#o.activateDebounceMs : this.#o.deactivateDebounceMs;
    this.#debounce = this.#t.setTimeout(() => {
      this.#debounce = null;
      this.#send(next);
    }, wait);
  }

  /** Stop and report inactive (app quitting / pet hidden by the user). */
  async stop(): Promise<void> {
    if (this.#debounce !== null) this.#t.clearTimeout(this.#debounce);
    if (this.#heartbeat !== null) this.#t.clearInterval(this.#heartbeat);
    this.#debounce = null;
    this.#heartbeat = null;
    this.#pending = null;
    if (this.#reported) {
      this.#reported = false;
      await this.sink({ desktopActive: false }).catch((e: unknown) => this.opts.onError?.(e));
    }
  }

  #send(v: boolean): void {
    this.#reported = v;
    this.#write(v);
    if (this.#heartbeat !== null) this.#t.clearInterval(this.#heartbeat);
    this.#heartbeat = v ? this.#t.setInterval(() => this.#write(true), this.#o.heartbeatMs) : null;
  }

  #write(v: boolean): void {
    this.sink({ desktopActive: v }).catch((e: unknown) => this.opts.onError?.(e));
  }
}
