import { describe, expect, it } from "vitest";
import type { AdapterEvent } from "@chalito/adapters";
import { SESSIONS_DEFAULTS } from "@chalito/config";
import { AlertWatcher, SessionWatch, commandOf, looping, type AgentAlert, type Run } from "../src/alerts/watch.js";

const CFG = SESSIONS_DEFAULTS.alerts;
const MIN = 60_000;
const fail = (cmd: string): Run => ({ cmd, ok: false });
const pass = (cmd: string): Run => ({ cmd, ok: true });

describe("looping (the same failing command, 5 of the last 12)", () => {
  it("5 failures is stuck, 4 isn't", () => {
    expect(looping(Array(4).fill(fail("npm test")), 5, 12)).toBeNull();
    expect(looping(Array(5).fill(fail("npm test")), 5, 12)).toEqual({ cmd: "npm test", count: 5 });
  });

  it("only the last 12 runs count", () => {
    const old = [fail("npm test"), fail("npm test")];
    const recent = [...Array(3).fill(fail("npm test")), ...Array(9).fill(pass("ls"))];
    expect(looping([...old, ...recent], 5, 12)).toBeNull();
    expect(looping([...recent.slice(0, 10), ...old], 5, 12)).toEqual({ cmd: "npm test", count: 5 });
  });

  it("a command that finally passed isn't stuck, and different commands don't add up", () => {
    expect(looping([...Array(5).fill(fail("npm test")), pass("npm test")], 5, 12)).toBeNull();
    expect(looping([fail("a"), fail("b"), fail("c"), fail("a"), fail("b"), fail("c")], 5, 12)).toBeNull();
  });

  it("reads the command of a shell tool call, one line, capped", () => {
    expect(commandOf({ command: "  npm\n  test " })).toBe("npm test");
    expect(commandOf({ file_path: "/x" })).toBeNull();
    expect(commandOf({ command: "x".repeat(500) })!.length).toBe(200);
  });
});

const ev = {
  state: (state: string): AdapterEvent => ({ type: "state", state: state as never }),
  run: (id: string, command: string): AdapterEvent => ({
    type: "tool_started",
    toolUseId: id,
    toolName: "Bash",
    input: { command },
  }),
  done: (id: string, ok: boolean): AdapterEvent => ({ type: "tool_finished", toolUseId: id, ok }),
};

const failTimes = (w: SessionWatch, n: number, t: number, cmd = "pnpm test") => {
  const out: (AgentAlert | null)[] = [];
  for (let i = 0; i < n; i++) {
    w.observe(ev.run(`${cmd}${t}${i}`, cmd), t);
    out.push(w.observe(ev.done(`${cmd}${t}${i}`, false), t));
  }
  return out.filter(Boolean);
};

describe("SessionWatch", () => {
  it("stuck fires once per turn, on the 5th failure, with the command and the turn's start", () => {
    const w = new SessionWatch(CFG);
    w.observe(ev.state("running"), 1000);
    expect(failTimes(w, 8, 2000)).toEqual([{ kind: "stuck", cmd: "pnpm test", count: 5, turn: 1000 }]);
  });

  it("a new turn starts over; coming back from an approval is the same turn", () => {
    const w = new SessionWatch(CFG);
    w.observe(ev.state("running"), 1000);
    failTimes(w, 3, 1500);
    w.observe(ev.state("waiting_approval"), 1600);
    w.observe(ev.state("running"), 1700);
    expect(failTimes(w, 2, 1800)).toHaveLength(1);
    w.observe(ev.state("idle"), 1900);
    w.observe(ev.state("running"), 5000);
    expect(failTimes(w, 4, 5100)).toEqual([]);
    expect(failTimes(w, 1, 5200)).toEqual([{ kind: "stuck", cmd: "pnpm test", count: 5, turn: 5000 }]);
  });

  it("non-shell tools never count", () => {
    const w = new SessionWatch(CFG);
    w.observe(ev.state("running"), 0);
    for (let i = 0; i < 6; i++) {
      w.observe({ type: "tool_started", toolUseId: `e${i}`, toolName: "Edit", input: { file_path: "/a" } }, 0);
      expect(w.observe(ev.done(`e${i}`, false), 0)).toBeNull();
    }
  });
});

describe("AlertWatcher (stall timers on a fake clock)", () => {
  const rig = (stallTimeout = 20 * MIN) => {
    let now = 0;
    let timers: { at: number; fn: () => void; dead: boolean }[] = [];
    const raised: [string, AgentAlert][] = [];
    const w = new AlertWatcher({
      config: () => ({ ...CFG, stallTimeout }),
      now: () => now,
      schedule: (fn, ms) => {
        const t = { at: now + ms, fn, dead: false };
        timers.push(t);
        return { clear: () => void (t.dead = true) };
      },
      raise: (sid, a) => raised.push([sid, a]),
    });
    const advance = (ms: number) => {
      const end = now + ms;
      for (;;) {
        const next = timers.filter((t) => !t.dead && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        timers = timers.filter((t) => t !== next);
        next.fn();
      }
      now = end;
    };
    const armed = () => timers.filter((t) => !t.dead).length;
    return { w, raised, advance, armed, at: () => now };
  };

  it("20 quiet minutes while running raise one stall for the turn; output pushes it back", () => {
    const r = rig();
    r.w.observe("s1", ev.state("running"));
    r.advance(19 * MIN);
    r.w.observe("s1", { type: "assistant_delta", text: "…" });
    r.advance(19 * MIN);
    expect(r.raised).toEqual([]);
    r.advance(1 * MIN);
    expect(r.raised).toEqual([["s1", { kind: "stalled", turn: 0 }]]);
    r.advance(120 * MIN);
    expect(r.raised).toHaveLength(1);
    expect(r.armed()).toBe(0);
  });

  it("the timeout is configurable", () => {
    const r = rig(5 * MIN);
    r.w.observe("s1", ev.state("running"));
    r.advance(5 * MIN);
    expect(r.raised).toHaveLength(1);
  });

  it("waiting on the person, idle or a forgotten session never stall", () => {
    const r = rig();
    r.w.observe("s1", ev.state("running"));
    r.w.observe("s1", ev.state("waiting_approval"));
    r.w.observe("s2", ev.state("running"));
    r.w.observe("s2", ev.state("idle"));
    r.w.observe("s3", ev.state("running"));
    r.w.forget("s3");
    r.advance(60 * MIN);
    expect(r.raised).toEqual([]);
    expect(r.armed()).toBe(0);
  });

  it("never stalls while waiting on the person; the quiet clock restarts when they answer", async () => {
    const r = rig();
    r.w.observe("s1", ev.state("running"));
    let answer!: () => void;
    const waiting = r.w.whileWaiting("s1", new Promise<void>((res) => (answer = res)));
    r.advance(60 * MIN);
    expect(r.raised).toEqual([]);
    answer();
    await waiting;
    r.advance(19 * MIN);
    expect(r.raised).toEqual([]);
    r.advance(1 * MIN);
    expect(r.raised).toHaveLength(1);
  });

  it("a wait that never settled is dropped when the next turn starts", () => {
    const r = rig();
    r.w.observe("s1", ev.state("running"));
    void r.w.whileWaiting("s1", new Promise<void>(() => undefined));
    r.w.observe("s1", ev.state("idle"));
    r.w.observe("s1", ev.state("running"));
    r.advance(20 * MIN);
    expect(r.raised).toHaveLength(1);
  });

  it("an earlier turn's approval settling late can't unpause the question open now", async () => {
    const r = rig();
    r.w.observe("s1", ev.state("running"));
    // A stopped turn's approval stays pending until its TTL.
    let expire!: () => void;
    const stale = r.w.whileWaiting("s1", new Promise<void>((res) => (expire = res)));
    r.w.observe("s1", ev.state("idle"));
    r.w.observe("s1", ev.state("running"));
    // The new turn asks something and the person takes their time.
    void r.w.whileWaiting("s1", new Promise<void>(() => undefined));
    r.advance(5 * MIN);
    expire();
    await stale;
    r.advance(60 * MIN);
    expect(r.raised).toEqual([]);
  });

  it("a new turn can stall again", () => {
    const r = rig();
    r.w.observe("s1", ev.state("running"));
    r.advance(20 * MIN);
    r.w.observe("s1", ev.state("idle"));
    r.w.observe("s1", ev.state("running"));
    r.advance(20 * MIN);
    expect(r.raised.map(([, a]) => a)).toEqual([
      { kind: "stalled", turn: 0 },
      { kind: "stalled", turn: 20 * MIN },
    ]);
  });
});
