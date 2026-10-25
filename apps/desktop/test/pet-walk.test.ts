import { describe, expect, it } from "vitest";
import {
  WALK,
  WalkPlanner,
  mayWalk,
  onFloor,
  pickTarget,
  walkAt,
  walkMs,
  xBounds,
  type WalkGate,
} from "../src/pet/walk.js";

const calm: WalkGate = {
  enabled: true,
  state: "idle",
  activity: null,
  fullscreen: false,
  dnd: false,
  quietHours: false,
  dragging: false,
  hovering: false,
  acting: false,
  onFloor: true,
};

/** A fixed sequence of "random" numbers, repeating. */
const seq =
  (...v: number[]) =>
  () => {
    const x = v.shift()!;
    v.push(x);
    return x;
  };

describe("when it may walk", () => {
  it("a calm pet on the taskbar walks (tired too)", () => {
    expect(mayWalk(calm)).toBe(true);
    expect(mayWalk({ ...calm, state: "tired" })).toBe(true);
    expect(mayWalk({ ...calm, activity: "rest" })).toBe(true);
  });

  it("never while something waits, an AI works, or the person is busy or holding it", () => {
    for (const state of ["sleepy", "glance", "wave", "hop", "knock"] as const)
      expect(mayWalk({ ...calm, state }), state).toBe(false);
    for (const activity of ["working", "needs_you"] as const) expect(mayWalk({ ...calm, activity })).toBe(false);
    for (const k of ["fullscreen", "dnd", "quietHours", "dragging", "hovering", "acting"] as const)
      expect(mayWalk({ ...calm, [k]: true }), k).toBe(false);
    expect(mayWalk({ ...calm, enabled: false })).toBe(false);
    expect(mayWalk({ ...calm, onFloor: false })).toBe(false);
  });

  it("stands on the floor when its bottom meets the work area's bottom", () => {
    const work = { x: 0, y: 0, width: 1920, height: 1040 };
    expect(onFloor({ x: 500, y: 780, width: 220, height: 260 }, work, 6)).toBe(true);
    expect(onFloor({ x: 500, y: 775, width: 220, height: 260 }, work, 6)).toBe(true);
    expect(onFloor({ x: 500, y: 400, width: 220, height: 260 }, work, 6)).toBe(false);
  });
});

describe("where it walks", () => {
  const bounds = xBounds({ x: 0, y: 0, width: 1920, height: 1040 }, 220);

  it("x bounds keep the whole window on the screen", () => {
    expect(bounds).toEqual({ min: 0, max: 1700 });
    expect(xBounds({ x: -2560, y: 0, width: 200, height: 100 }, 220)).toEqual({ min: -2560, max: -2560 });
  });

  it("a step of 60–180 px, within the roam range around home and the screen", () => {
    for (let i = 0; i < 200; i++) {
      const r = seq(i / 200, ((i * 7) % 200) / 200);
      const x = 300 + ((i * 37) % 1200);
      const t = pickTarget(x, 900, bounds, r);
      const [lo, hi] = [900 - WALK.roam, 900 + WALK.roam];
      expect(Math.abs(t - x)).toBeLessThanOrEqual(WALK.stepMax);
      if (x >= lo && x <= hi) {
        expect(t).toBeGreaterThanOrEqual(lo);
        expect(t).toBeLessThanOrEqual(hi);
      } else expect(Math.abs(t - 900)).toBeLessThan(Math.abs(x - 900)); // heads back toward home
    }
    expect(Math.abs(pickTarget(900, 900, bounds, seq(0, 0.9)) - 900)).toBe(WALK.stepMin);
    expect(Math.abs(pickTarget(900, 900, bounds, seq(1, 0.9)) - 900)).toBe(WALK.stepMax);
  });

  it("turns back at the screen's edge and at the end of its range", () => {
    expect(pickTarget(1690, 1690, bounds, seq(0.5, 0.9))).toBeLessThan(1690);
    expect(pickTarget(5, 5, bounds, seq(0.5, 0.1))).toBeGreaterThan(5);
    expect(pickTarget(900 + WALK.roam, 900, bounds, seq(0.5, 0.9))).toBeLessThan(900 + WALK.roam);
  });

  it("far from home (put elsewhere) it heads back one step at a time, never a long trek", () => {
    expect(pickTarget(100, 1500, bounds, seq(1, 0.9))).toBe(100 + WALK.stepMax);
    expect(pickTarget(1650, 300, bounds, seq(0, 0.1))).toBe(1650 - WALK.stepMin);
  });

  it("a walk's duration follows its length and the screen's scale", () => {
    expect(walkMs(100, 190)).toBeCloseTo((90 / WALK.speedPxPerS) * 1000);
    expect(walkMs(190, 100, 2)).toBeCloseTo((90 / (WALK.speedPxPerS * 2)) * 1000);
  });

  it("distances scale with the screen (HiDPI)", () => {
    expect(Math.abs(pickTarget(900, 900, bounds, seq(0, 0.9), 2) - 900)).toBe(WALK.stepMin * 2);
  });

  it("walks at a steady pace and arrives exactly", () => {
    expect(walkAt(100, 190, 0)).toEqual({ x: 100, done: false });
    expect(walkAt(100, 190, 1000)).toEqual({ x: 100 + WALK.speedPxPerS, done: false });
    expect(walkAt(100, 10, 1000)).toEqual({ x: 100 - WALK.speedPxPerS, done: false });
    expect(walkAt(100, 190, 10_000)).toEqual({ x: 190, done: true });
    expect(walkAt(100, 190, 1000, 2).x).toBe(190);
  });
});

describe("walk cooldowns", () => {
  const bounds = { min: 0, max: 1700 };

  it("not right after launch; then a gap between walks", () => {
    const p = new WalkPlanner(seq(0.5, 0.9), 0);
    expect(p.plan(WALK.firstAfterMs - 1, calm, 900, 900, bounds)).toBeNull();
    const t = p.plan(WALK.firstAfterMs, calm, 900, 900, bounds);
    expect(t).not.toBeNull();
    const gap = WALK.gapMinMs + 0.5 * (WALK.gapMaxMs - WALK.gapMinMs);
    expect(p.nextAt).toBe(WALK.firstAfterMs + gap);
    expect(p.plan(WALK.firstAfterMs + gap - 1, calm, t!, 900, bounds)).toBeNull();
    expect(p.plan(WALK.firstAfterMs + gap, calm, t!, 900, bounds)).not.toBeNull();
  });

  it("never while busy, and waiting doesn't use up the turn", () => {
    const p = new WalkPlanner(seq(0.5, 0.9), 0);
    const due = WALK.firstAfterMs;
    expect(p.plan(due, { ...calm, state: "knock" }, 900, 900, bounds)).toBeNull();
    expect(p.plan(due + 1, { ...calm, dragging: true }, 900, 900, bounds)).toBeNull();
    expect(p.nextAt).toBe(due);
    expect(p.plan(due + 2, calm, 900, 900, bounds)).not.toBeNull();
  });

  it("stays put for a while after the person moved it", () => {
    const p = new WalkPlanner(seq(0.5, 0.9), 0);
    p.personMoved(80_000);
    expect(p.plan(WALK.firstAfterMs, calm, 900, 900, bounds)).toBeNull();
    expect(p.plan(80_000 + WALK.afterPersonMs - 1, calm, 900, 900, bounds)).toBeNull();
    expect(p.plan(80_000 + WALK.afterPersonMs, calm, 900, 900, bounds)).not.toBeNull();
  });

  it("no room to walk (window as wide as the screen): no walk, still waits a gap", () => {
    const p = new WalkPlanner(seq(0.5, 0.9), 0);
    expect(p.plan(WALK.firstAfterMs, calm, 0, 0, { min: 0, max: 0 })).toBeNull();
    expect(p.nextAt).toBeGreaterThan(WALK.firstAfterMs);
  });
});
