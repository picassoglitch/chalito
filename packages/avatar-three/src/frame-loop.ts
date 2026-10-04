/** What the loop needs from the page; injectable for tests. */
export interface LoopHost {
  requestAnimationFrame(cb: (t: number) => void): number;
  cancelAnimationFrame(id: number): void;
  /** True while the window is hidden/minimised (document.hidden). */
  hidden(): boolean;
  onVisibilityChange(cb: () => void): () => void;
}

export const browserHost = (): LoopHost => ({
  requestAnimationFrame: (cb) => window.requestAnimationFrame(cb),
  cancelAnimationFrame: (id) => window.cancelAnimationFrame(id),
  hidden: () => document.hidden,
  onVisibilityChange: (cb) => {
    document.addEventListener("visibilitychange", cb);
    return () => document.removeEventListener("visibilitychange", cb);
  },
});

/**
 * requestAnimationFrame with an FPS cap (the pet doesn't need 144 Hz) that sleeps while the
 * window is hidden: no frames are requested at all until it is visible again, and the first
 * frame after waking gets a dt of 0 instead of the whole hidden span.
 */
export class FrameLoop {
  #id: number | null = null;
  #last: number | null = null;
  #running = false;
  #off: (() => void) | null = null;
  readonly #minMs: number;

  constructor(
    readonly tick: (now: number, dtSeconds: number) => void,
    readonly fps = 30,
    readonly host: LoopHost = browserHost(),
  ) {
    this.#minMs = 1000 / fps;
  }

  get running(): boolean {
    return this.#running;
  }

  /** True when frames are being requested (running and visible). */
  get awake(): boolean {
    return this.#id !== null;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#off = this.host.onVisibilityChange(() => this.#sync());
    this.#sync();
  }

  stop(): void {
    this.#running = false;
    this.#off?.();
    this.#off = null;
    this.#sleep();
  }

  #sync(): void {
    if (this.#running && !this.host.hidden()) {
      if (this.#id === null) this.#schedule();
    } else this.#sleep();
  }

  #sleep(): void {
    if (this.#id !== null) this.host.cancelAnimationFrame(this.#id);
    this.#id = null;
    this.#last = null;
  }

  #schedule(): void {
    this.#id = this.host.requestAnimationFrame((t) => this.#frame(t));
  }

  #frame(t: number): void {
    this.#id = null;
    if (!this.#running || this.host.hidden()) return;
    // Half a frame of slack so 60 Hz displays land on every other vsync at 30 fps.
    if (this.#last === null || t - this.#last >= this.#minMs - 1000 / 120) {
      const dt = this.#last === null ? 0 : (t - this.#last) / 1000;
      this.#last = t;
      this.tick(t, dt);
    }
    if (this.#running) this.#schedule();
  }
}
