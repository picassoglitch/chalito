import { useEffect, useRef } from "react";

/** Runs `fn` every `ms` while the window is visible, and once when it comes back into view. */
export const useVisiblePoll = (fn: (() => void) | null, ms: number): void => {
  const latest = useRef(fn);
  latest.current = fn;
  const on = fn !== null;
  useEffect(() => {
    if (!on) return;
    const run = () => {
      if (document.visibilityState === "visible") latest.current?.();
    };
    const timer = setInterval(run, ms);
    document.addEventListener("visibilitychange", run);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [on, ms]);
};
