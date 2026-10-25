import type { EnrollResult } from "./enrollment.js";
import type { AcceptError, ExchangeError, ExchangeResult, SsoFlow } from "./sso.js";

export type SignInStep =
  | { step: "signed_out" }
  /** `stale`: a link from an earlier attempt came back; the newest browser tab still works. */
  | { step: "browser"; stale?: true }
  | { step: "exchanging" }
  | { step: "enrolling" }
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
  enroll(owner: string): Promise<EnrollResult>;
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
 * deep link → exchange → the sign-in enrols this computer (ADR 0032, + passkey) → ready.
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
      // A link for a sign-in this launch never started (restart, another copy, cancelled): say so
      // instead of looking stuck, so the person doesn't keep signing in (2026-10-25).
      const s = this.#s;
      // A real error (expired, enrolment failed) stays on screen; a stray link doesn't replace it.
      const idle = s.step === "signed_out" || (s.step === "error" && s.reason === "no_pending");
      if (r.reason === "no_pending" && idle) return this.#set({ step: "error", reason: "no_pending" });
      // Same while waiting on the browser (Sign in clicked twice, old tab finished): a hint, it carries on.
      const stale = r.reason === "no_pending" || r.reason === "state_mismatch";
      if (stale && this.#s.step === "browser" && !this.#s.stale) this.#set({ step: "browser", stale: true });
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
    this.#set({ step: "enrolling" });
    // A throw (keychain, storage) is an error to show, never a panel left on "enrolling".
    const e = await this.d.enroll(x.owner).catch((): EnrollResult => ({ ok: false, reason: "failed" }));
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
