/**
 * A terminal's output on its way to the browser (terminal/control.ts seals and writes each
 * chunk as a `terminal.output` event).
 *
 * - Coalesces: output is sent at most every `flushMs`, or at once when a full chunk is waiting,
 *   in chunks of at most `chunkChars`.
 * - Backpressure: at most `maxInflight` chunks are being written at a time, and every chunk takes
 *   a token from a bucket shared by all terminals on this device (the database accepts about 20
 *   session events a second per device). Above `highWater` waiting characters the PTY is paused
 *   (where the backend can pause), and resumed below `lowWater`.
 * - Scrollback limit: the device never holds more than `scrollbackChars` unsent characters. The
 *   oldest are dropped and the next chunk says how many (`dropped`), so the browser can show a gap.
 */

/** A token bucket: `capacity` tokens, refilled at `perMinute` a minute. */
export class TokenBucket {
  #tokens: number;
  #at: number;
  constructor(
    private readonly capacity: () => number,
    private readonly perMinute: () => number,
    private readonly now: () => number,
  ) {
    this.#tokens = capacity();
    this.#at = now();
  }

  /** Takes `n` tokens if there are that many; false (and nothing taken) otherwise. */
  take(n = 1): boolean {
    const t = this.now();
    this.#tokens = Math.min(this.capacity(), this.#tokens + ((t - this.#at) * this.perMinute()) / 60_000);
    this.#at = t;
    if (this.#tokens < n) return false;
    this.#tokens -= n;
    return true;
  }
}

export interface OutputLimits {
  chunkChars: number;
  flushMs: number;
  maxInflight: number;
  scrollbackChars: number;
  highWater: number;
  lowWater: number;
}

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = {
  chunkChars: 16 * 1024,
  flushMs: 40,
  maxInflight: 4,
  scrollbackChars: 1024 * 1024,
  highWater: 256 * 1024,
  lowWater: 64 * 1024,
};

export interface OutputDeps {
  send: (chunk: { data: string; dropped: number }) => Promise<void>;
  /** The device-wide event budget; false = wait and retry. */
  take: () => boolean;
  schedule: (fn: () => void, ms: number) => { clear(): void };
  pause?: () => void;
  resume?: () => void;
  onError: (err: unknown) => void;
  limits?: Partial<OutputLimits>;
}

/** Cuts at most `n` code units off the front without splitting a surrogate pair. */
const cut = (s: string, n: number): number => {
  if (n >= s.length) return s.length;
  const c = s.charCodeAt(n - 1);
  return c >= 0xd800 && c <= 0xdbff ? n - 1 : n;
};

export class OutputStream {
  readonly limits: OutputLimits;
  #buf = "";
  #dropped = 0;
  #inflight = 0;
  #paused = false;
  #timer: { clear(): void } | null = null;
  #closed = false;
  /** Totals for the audit (counts only). */
  sentChars = 0;
  droppedChars = 0;

  constructor(private readonly d: OutputDeps) {
    this.limits = { ...DEFAULT_OUTPUT_LIMITS, ...d.limits };
  }

  get pending(): number {
    return this.#buf.length;
  }

  get paused(): boolean {
    return this.#paused;
  }

  push(data: string): void {
    if (this.#closed || !data) return;
    this.#buf += data;
    const over = this.#buf.length - this.limits.scrollbackChars;
    if (over > 0) {
      const n = cut(this.#buf, over);
      this.#buf = this.#buf.slice(n);
      this.#dropped += n;
      this.droppedChars += n;
    }
    if (!this.#paused && this.d.pause && this.#buf.length > this.limits.highWater) {
      this.#paused = true;
      this.d.pause();
    }
    if (this.#buf.length >= this.limits.chunkChars) this.#pump();
    else this.#arm();
  }

  /** Sends what's waiting as fast as the budget allows; resolves once nothing is left or in flight. */
  async drain(maxWaitMs: number, sleep: (ms: number) => Promise<void>): Promise<void> {
    let waited = 0;
    while ((this.#buf.length > 0 || this.#inflight > 0) && waited < maxWaitMs) {
      this.#pump();
      if (this.#buf.length === 0 && this.#inflight === 0) break;
      await sleep(this.limits.flushMs);
      waited += this.limits.flushMs;
    }
  }

  /** Stops sending; whatever is still waiting is discarded. */
  close(): void {
    this.#closed = true;
    this.#timer?.clear();
    this.#timer = null;
    this.#buf = "";
  }

  #arm(): void {
    if (this.#timer || this.#closed) return;
    this.#timer = this.d.schedule(() => {
      this.#timer = null;
      this.#pump();
    }, this.limits.flushMs);
  }

  #pump(): void {
    if (this.#closed) return;
    while (this.#buf.length > 0 && this.#inflight < this.limits.maxInflight) {
      if (!this.d.take()) {
        this.#arm();
        return;
      }
      const n = cut(this.#buf, this.limits.chunkChars);
      const data = this.#buf.slice(0, n);
      this.#buf = this.#buf.slice(n);
      const dropped = this.#dropped;
      this.#dropped = 0;
      this.#inflight++;
      this.sentChars += data.length;
      this.d
        .send({ data, dropped })
        .catch(this.d.onError)
        .finally(() => {
          this.#inflight--;
          if (this.#paused && this.#buf.length <= this.limits.lowWater) {
            this.#paused = false;
            this.d.resume?.();
          }
          if (this.#buf.length > 0) this.#pump();
        });
    }
    if (this.#buf.length > 0) this.#arm();
  }
}
