import type { EnrollResult } from "./enrollment.js";
import type { AcceptError, ExchangeError, ExchangeResult, SsoFlow } from "./sso.js";

export type SignInStep =
  | { step: "signed_out" }
  | { step: "browser" }
  | { step: "exchanging" }
  | { step: "endorsing"; display: unknown }
  | { step: "ready"; owner: string; deviceId: string; passkey: "enrolled" | "unavailable" | "failed" }
  | {
      step: "error";
      reason: AcceptError | ExchangeError | Exclude<EnrollResult, { ok: true }>["reason"] | "open_failed";
    };

export interface SignInDeps {
  flow: SsoFlow;
  /** The system browser (tauri-plugin-opener), never a webview. */
  openUrl(url: string): Promise<void>;
  /** Debug builds only: the loopback redirect for this state. */
  devRedirect?: (state: string) => Promise<string>;
  exchange(token: string): Promise<ExchangeResult>;
  enroll(owner: string, onDisplay: (d: unknown) => void, signal: AbortSignal): Promise<EnrollResult>;
}

/** Link rejections that must not disturb a sign-in in progress (forged or stray links). */
const IGNORABLE = new Set<AcceptError>([
  "malformed",
  "wrong_target",
  "no_pending",
  "state_mismatch",
  "duplicate_param",
]);

/**
 * The panel's sign-in, framework-free: open the hub in the browser → accept the callback
 * deep link → exchange → endorsement by a trusted client (+ passkey) → ready.
 */
export class SignInController {
  #s: SignInStep = { step: "signed_out" };
  #abort: AbortController | null = null;
  readonly #listeners = new Set<() => void>();
  /** Why the last link was ignored (shown as a hint, the sign-in carries on). */
  lastIgnored: AcceptError | null = null;

  constructor(private readonly d: SignInDeps) {}

  subscribe = (l: () => void): (() => void) => {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  };
  getSnapshot = (): SignInStep => this.#s;

  async start(): Promise<void> {
    // A new launch supersedes any earlier one (begin() replaces the pending state).
    this.#abort?.abort();
    this.#abort = null;
    try {
      const { url } = this.d.devRedirect ? await this.d.flow.beginWith(this.d.devRedirect) : this.d.flow.begin();
      this.#set({ step: "browser" });
      await this.d.openUrl(url);
    } catch {
      this.d.flow.cancel();
      this.#set({ step: "error", reason: "open_failed" });
    }
  }

  cancel(): void {
    this.#abort?.abort();
    this.#abort = null;
    this.d.flow.cancel();
    if (this.#s.step !== "ready") this.#set({ step: "signed_out" });
  }

  /** Every chalito:// URL the app receives (deep link, single-instance forward, dev loopback). */
  async handleUrl(url: string): Promise<void> {
    const r = this.d.flow.accept(url);
    if (!r.ok) {
      if (IGNORABLE.has(r.reason)) {
        this.lastIgnored = r.reason;
        return;
      }
      return this.#set({ step: "error", reason: r.reason });
    }
    this.#set({ step: "exchanging" });
    const x = await this.d.exchange(r.token);
    if (!x.ok) return this.#set({ step: "error", reason: x.reason });
    const abort = (this.#abort = new AbortController());
    this.#set({ step: "endorsing", display: null });
    const e = await this.d.enroll(x.owner, (display) => this.#set({ step: "endorsing", display }), abort.signal);
    if (abort.signal.aborted) return;
    this.#abort = null;
    if (!e.ok) return this.#set({ step: "error", reason: e.reason });
    this.#set({ step: "ready", owner: x.owner, deviceId: e.deviceId, passkey: e.passkey });
  }

  #set(s: SignInStep): void {
    this.#s = s;
    for (const l of this.#listeners) l();
  }
}
