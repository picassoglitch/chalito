/** Keep a failed or obsolete image load from locking the pet onto the wrong appearance. */
export class PetCardLoader<T> {
  #key: string | null = null;
  #generation = 0;

  async load(key: string, fetch: () => Promise<T>): Promise<T | null> {
    if (key === this.#key) return null;
    this.#key = key;
    const generation = ++this.#generation;
    try {
      const assets = await fetch();
      return generation === this.#generation ? assets : null;
    } catch (error) {
      if (generation !== this.#generation) return null;
      this.#key = null;
      throw error;
    }
  }

  dispose(): void {
    this.#generation++;
    this.#key = null;
  }
}

/** Retry delays for a pet look that keeps failing: doubling, capped; a different look starts over. */
export class RetryBackoff {
  #key: string | null = null;
  #ms: number;

  constructor(
    private readonly firstMs = 3_000,
    private readonly maxMs = 5 * 60_000,
  ) {
    this.#ms = firstMs;
  }

  next(key: string): number {
    if (key !== this.#key) {
      this.#key = key;
      this.#ms = this.firstMs;
    }
    const ms = this.#ms;
    this.#ms = Math.min(this.maxMs, ms * 2);
    return ms;
  }

  reset(): void {
    this.#key = null;
    this.#ms = this.firstMs;
  }
}
