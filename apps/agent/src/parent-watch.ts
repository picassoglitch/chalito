import { isProcessAlive } from "./instance-lock.js";

export const PARENT_POLL_MS = 2000;

/** `onGone` once the desktop app that started us exits: an orphan keeps the lock (2026-10-25).
 * Windows doesn't re-parent, so the parent pid is checked; a reused pid there goes unnoticed. */
export const watchParent = (
  onGone: () => void,
  deps: {
    ppid?: () => number;
    isAlive?: (pid: number) => boolean;
    every?: (fn: () => void, ms: number) => { clear(): void };
  } = {},
): (() => void) => {
  const ppid = deps.ppid ?? (() => process.ppid);
  const isAlive = deps.isAlive ?? isProcessAlive;
  const every =
    deps.every ??
    ((fn, ms) => {
      const t = setInterval(fn, ms);
      t.unref();
      return { clear: () => clearInterval(t) };
    });
  const parent = ppid();
  const timer = every(() => {
    if (ppid() === parent && isAlive(parent)) return;
    timer.clear();
    onGone();
  }, PARENT_POLL_MS);
  return () => timer.clear();
};
