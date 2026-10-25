import { describe, expect, it } from "vitest";
import {
  DRAG_THRESHOLD_PX,
  FOLLOW_FADE_MS,
  FOLLOW_MS,
  GAZE_LIMIT,
  HOVER_DWELL_MS,
  NOTICE_COOLDOWN_MS,
  POKE_COOLDOWN_MS,
  PressTracker,
  Reactions,
  cursorGaze,
  eyePoint,
  followWeight,
  pastThreshold,
} from "../src/pet/mouse.js";

describe("drag or click", () => {
  it("a press is a drag only past ~4 px", () => {
    expect(DRAG_THRESHOLD_PX).toBe(4);
    expect(pastThreshold({ x: 0, y: 0 }, { x: 3, y: 2 })).toBe(false);
    expect(pastThreshold({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(false);
    expect(pastThreshold({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(true);
    expect(pastThreshold({ x: 10, y: 10 }, { x: 10, y: 15 })).toBe(true);
  });

  it("lifting in place is a click; moving past the threshold is one drag and no click", () => {
    const p = new PressTracker();
    p.down(100, 100);
    expect(p.move(102, 101)).toBeNull();
    expect(p.up()).toBe("click");

    p.down(100, 100);
    expect(p.move(110, 100)).toBe("drag");
    expect(p.move(130, 100)).toBeNull();
    expect(p.up()).toBeNull();
  });

  it("moves without a press, a stray up or a cancelled press do nothing", () => {
    const p = new PressTracker();
    expect(p.move(500, 500)).toBeNull();
    expect(p.up()).toBeNull();
    p.down(0, 0);
    p.cancel();
    expect(p.up()).toBeNull();
  });
});

describe("eyes on the cursor", () => {
  const eye = { x: 1000, y: 500 };

  it("straight ahead when the cursor is at the eyes; right and up are positive", () => {
    expect(cursorGaze(eye, eye, 1)).toEqual({ yaw: 0, pitch: 0 });
    const g = cursorGaze({ x: 1200, y: 300 }, eye, 1);
    expect(g.yaw).toBeGreaterThan(5);
    expect(g.pitch).toBeGreaterThan(5);
    const l = cursorGaze({ x: 800, y: 700 }, eye, 1);
    expect(l.yaw).toBeLessThan(-5);
    expect(l.pitch).toBeLessThan(-5);
  });

  it("capped: a cursor across the screen is a glance, not a full turn", () => {
    const far = cursorGaze({ x: 99_999, y: -99_999 }, eye, 1);
    expect(far.yaw).toBeCloseTo(GAZE_LIMIT.yaw);
    expect(far.pitch).toBeCloseTo(GAZE_LIMIT.pitch);
    expect(cursorGaze({ x: -99_999, y: 99_999 }, eye, 1)).toEqual({ yaw: -GAZE_LIMIT.yaw, pitch: -GAZE_LIMIT.pitch });
  });

  it("measures in logical px: the same physical offset turns less on a HiDPI screen", () => {
    const at1 = cursorGaze({ x: 1200, y: 500 }, eye, 1).yaw;
    const at2 = cursorGaze({ x: 1200, y: 500 }, eye, 2).yaw;
    expect(at2).toBeLessThan(at1);
    expect(cursorGaze({ x: 1200, y: 500 }, eye, 0).yaw).toBeCloseTo(at1);
  });

  it("the eyes sit centred, a third down the hit box", () => {
    expect(eyePoint({ x: 100, y: 200, width: 80, height: 120 })).toEqual({ x: 140, y: 236 });
  });

  it("follows a moving cursor, then drifts back to centre", () => {
    expect(followWeight(0)).toBe(1);
    expect(followWeight(FOLLOW_MS)).toBe(1);
    expect(followWeight(FOLLOW_MS + FOLLOW_FADE_MS / 2)).toBeCloseTo(0.5);
    expect(followWeight(FOLLOW_MS + FOLLOW_FADE_MS)).toBe(0);
    expect(followWeight(Infinity)).toBe(0);
  });
});

describe("hover and poke reactions", () => {
  it("notices a cursor that rests on it, once per hover, then waits out a cooldown", () => {
    const r = new Reactions();
    expect(r.hover(true, 0)).toBe(false);
    expect(r.hover(true, HOVER_DWELL_MS - 1)).toBe(false);
    expect(r.hover(true, HOVER_DWELL_MS)).toBe(true);
    expect(r.hover(true, HOVER_DWELL_MS + 2000)).toBe(false);
    // Out and back in soon after: no second notice inside the cooldown.
    expect(r.hover(false, 3000)).toBe(false);
    expect(r.hover(true, 3100)).toBe(false);
    expect(r.hover(true, 3100 + HOVER_DWELL_MS)).toBe(false);
    r.hover(false, 4000);
    const later = HOVER_DWELL_MS + NOTICE_COOLDOWN_MS + 10;
    r.hover(true, later);
    expect(r.hover(true, later + HOVER_DWELL_MS)).toBe(true);
  });

  it("a cursor passing over doesn't count; nor does hovering while it's not calm", () => {
    const r = new Reactions();
    r.hover(true, 0);
    r.hover(false, 100);
    expect(r.hover(true, 200)).toBe(false);
    expect(r.hover(true, 200 + HOVER_DWELL_MS, false)).toBe(false);
    expect(r.hover(true, 300 + HOVER_DWELL_MS)).toBe(true);
  });

  it("pokes react with a short cooldown; a poke counts as this hover's reaction", () => {
    const r = new Reactions();
    expect(r.poke(1000)).toBe(true);
    expect(r.poke(1000 + POKE_COOLDOWN_MS - 1)).toBe(false);
    expect(r.poke(1000 + POKE_COOLDOWN_MS)).toBe(true);
    r.hover(true, 5000);
    r.poke(5000 + POKE_COOLDOWN_MS * 2);
    expect(r.hover(true, 5000 + HOVER_DWELL_MS + POKE_COOLDOWN_MS * 2)).toBe(false);
  });
});
