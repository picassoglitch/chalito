import { describe, expect, it, vi } from "vitest";
import { watchParent } from "../src/parent-watch.js";

const harness = (start: number) => {
  let ppid = start;
  const alive = new Set([start]);
  let tick: (() => void) | null = null;
  const cleared = vi.fn();
  const onGone = vi.fn();
  const stop = watchParent(onGone, {
    ppid: () => ppid,
    isAlive: (p) => alive.has(p),
    every: (fn) => ((tick = fn), { clear: cleared }),
  });
  return {
    onGone,
    cleared,
    stop,
    tick: () => tick!(),
    reparent: (to: number) => ((ppid = to), alive.delete(start)),
    die: () => alive.delete(start),
  };
};

describe("watchParent", () => {
  it("does nothing while the desktop app that started it runs", () => {
    const h = harness(4242);
    for (let i = 0; i < 5; i++) h.tick();
    expect(h.onGone).not.toHaveBeenCalled();
  });

  it("unix: the app died and the agent was re-parented (init or systemd --user)", () => {
    const h = harness(4242);
    h.reparent(1);
    h.tick();
    expect(h.onGone).toHaveBeenCalledTimes(1);
    expect(h.cleared).toHaveBeenCalled();
  });

  it("windows: same ppid, but that process is gone", () => {
    const h = harness(4242);
    h.die();
    h.tick();
    expect(h.onGone).toHaveBeenCalledTimes(1);
  });

  it("the returned function stops watching", () => {
    const h = harness(4242);
    h.stop();
    expect(h.cleared).toHaveBeenCalled();
  });
});
