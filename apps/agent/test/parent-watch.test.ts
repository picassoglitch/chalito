import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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

  it("with the real timer and process: our parent (vitest) is alive, so nothing fires", async () => {
    const onGone = vi.fn();
    const stop = watchParent(onGone, {
      every: (fn, ms) => {
        const t = setInterval(fn, ms / 200);
        return { clear: () => clearInterval(t) };
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    expect(onGone).not.toHaveBeenCalled();
  });
});

describe("watchParent, real processes", () => {
  it.skipIf(process.platform === "win32")(
    "a child whose parent exits notices within a poll or two",
    async () => {
      const mod = fileURLToPath(new URL("../src/parent-watch.ts", import.meta.url));
      const child = `node --import tsx -e "import('${mod}').then((m) => m.watchParent(() => { console.log('gone'); process.exit(0); })); setInterval(() => {}, 1000)"`;
      // The parent starts the child and exits, like a crashed desktop app (the interval stands in for the daemon).
      const sh = spawn("sh", ["-c", `${child} & sleep 0.5; exit 0`], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      sh.stdout.on("data", (b: Buffer) => (out += b.toString()));
      await vi.waitFor(() => expect(out).toContain("gone"), { timeout: 8000, interval: 100 });
    },
    10_000,
  );
});
