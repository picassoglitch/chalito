/**
 * Partial assistant text on its way to the person's clients (M16 A, ADR 0022 §1): the pieces an
 * adapter reports (`assistant_delta`) are joined and flushed at most every `flushMs`, or as soon
 * as `flushChars` characters wait, as one `message.assistant.delta` each. Display only: the final
 * `assistant_text` is the message, and discards whatever is still waiting here.
 */
export interface DeltaThrottleDeps {
  flushMs: number;
  flushChars: number;
  schedule: (fn: () => void, ms: number) => { clear(): void };
  emit: (text: string) => void;
}

export class DeltaThrottle {
  #buf = "";
  #timer: { clear(): void } | null = null;
  /** Pieces emitted so far (for tests and the audit). */
  flushes = 0;

  constructor(private readonly d: DeltaThrottleDeps) {}

  push(text: string): void {
    if (!text) return;
    this.#buf += text;
    if (this.#buf.length >= this.d.flushChars) this.flush();
    else
      this.#timer ??= this.d.schedule(() => {
        this.#timer = null;
        this.flush();
      }, this.d.flushMs);
  }

  flush(): void {
    this.#timer?.clear();
    this.#timer = null;
    if (!this.#buf) return;
    const text = this.#buf;
    this.#buf = "";
    this.flushes++;
    this.d.emit(text);
  }

  /** The final text arrived (or the turn ended): nothing waiting is sent. */
  discard(): void {
    this.#timer?.clear();
    this.#timer = null;
    this.#buf = "";
  }
}
