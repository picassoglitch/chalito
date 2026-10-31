import { SupabaseError, writeWithRetry, type RetryOptions, type SupaResult } from "./supa.js";

export interface RpcClient {
  rpc(fn: string, args: Record<string, string>): PromiseLike<SupaResult>;
}

/** PostgREST: no such function (the calm-alerts migration isn't there, or its schema cache is still reloading). */
const MISSING_FUNCTION = "PGRST202";
/** How long a missing function is trusted before asking again: the tray app runs for days. */
export const ALERT_ACTIONS_RETRY_MS = 10 * 60_000;

export class AlertActionsUnavailable extends Error {
  override name = "AlertActionsUnavailable";
  constructor() {
    super("alert actions unavailable: chalito.notification_action is missing on this database");
  }
}

/** Calmer alerts (from Alux, by Omar): what the app tells the escalation engine via chalito.notification_action. */
export class AlertActions {
  #missing = false;
  #retryAt = 0;
  #listeners = new Set<() => void>();

  constructor(
    private readonly db: RpcClient,
    private readonly retry?: RetryOptions,
    private readonly report: (msg: string) => void = (msg) => console.error(msg),
    private readonly now: () => number = Date.now,
  ) {}

  /** False from a missing-function answer until a later call goes through (subscribers hear both changes). */
  get available(): boolean {
    return !this.#missing;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  };

  /** The person opened this session: its alerts rest, with one gentle re-nudge in 2 h if it still waits. */
  async seen(sid: string): Promise<void> {
    // Background, on every open: while the function is missing, skip quietly until it's time to ask again.
    if (this.#missing && this.now() < this.#retryAt) return;
    await this.#call({ p_action: "seen", p_sid: sid });
  }

  /** "Esperando a alguien" on (or undone): the session's alerts rest until it changes again. */
  waiting(sid: string, on: boolean): Promise<void> {
    return this.#call({ p_action: on ? "waiting" : "not_waiting", p_sid: sid });
  }

  /** "Posponer 30 min" on one alert. */
  snooze(nid: string): Promise<void> {
    return this.#call({ p_action: "snooze", p_nid: nid });
  }

  async #call(args: Record<string, string>): Promise<void> {
    if (this.#missing && this.now() < this.#retryAt) throw new AlertActionsUnavailable();
    try {
      await writeWithRetry("notification action", () => this.db.rpc("notification_action", args), this.retry);
    } catch (e) {
      if (!(e instanceof SupabaseError) || e.code !== MISSING_FUNCTION) throw e;
      this.#retryAt = this.now() + ALERT_ACTIONS_RETRY_MS;
      if (!this.#missing) {
        this.#missing = true;
        this.report(`chalito: ${new AlertActionsUnavailable().message} (${e.message}); trying again in 10 min`);
        this.#emit();
      }
      throw new AlertActionsUnavailable();
    }
    if (this.#missing) {
      this.#missing = false;
      this.#emit();
    }
  }

  #emit(): void {
    for (const fn of this.#listeners) fn();
  }
}
