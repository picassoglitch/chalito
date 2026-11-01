/** Why the owner's card didn't reach the board, shared between windows: the pet window uploads the
 * card, the panel is where the person reads about it. */
export interface CardErrorChannel {
  get(): string | null;
  set(reason: string | null): void;
  onChange(cb: () => void): () => void;
}

/** One window only: tests and a link nobody else needs to hear about. */
export const memoryCardErrors = (): CardErrorChannel => {
  let reason: string | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => reason,
    set: (next) => {
      if (next === reason) return;
      reason = next;
      subs.forEach((f) => f());
    },
    onChange: (cb) => (subs.add(cb), () => void subs.delete(cb)),
  };
};

const KEY = "chalito-board-card-error";

// LCD — localStorage, not an event: the value outlives a panel that opens after the failure, and
// the `storage` event tells every other window of the app when it changes.
export const localCardErrors = (storage: Storage = localStorage, win: Window = window): CardErrorChannel => {
  const subs = new Set<() => void>();
  const read = () => {
    try {
      return storage.getItem(KEY);
    } catch {
      return null;
    }
  };
  win.addEventListener("storage", (e) => {
    if (e.key === KEY || e.key === null) subs.forEach((f) => f());
  });
  return {
    get: read,
    set: (next) => {
      if (next === read()) return;
      try {
        if (next === null) storage.removeItem(KEY);
        else storage.setItem(KEY, next);
      } catch (e) {
        console.warn("board: couldn't share the card error with the panel", e);
      }
      subs.forEach((f) => f());
    },
    onChange: (cb) => (subs.add(cb), () => void subs.delete(cb)),
  };
};
