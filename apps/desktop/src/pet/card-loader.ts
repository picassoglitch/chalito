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
