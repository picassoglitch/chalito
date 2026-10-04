import { describe, expect, it } from "vitest";
import { BlinkScheduler, LookAtSmoother, SaccadeGenerator, bodyIdle } from "../src/idle.js";

const HOUR = 60 * 60 * 1000;

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { mean, median: s[Math.floor(s.length / 2)]!, min: s[0]!, max: s[s.length - 1]!, n: s.length };
};

describe("BlinkScheduler: interval distribution (seeded)", () => {
  const starts = new BlinkScheduler(42).blinksBetween(0, HOUR);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
  // A double blink's second blink follows the first within ~0.5 s.
  const doubles = gaps.filter((g) => g < 600);
  const singles = gaps.filter((g) => g >= 600);

  it("blinks at a human rate (≈12–24 per minute) with a ~3.6 s median interval", () => {
    const perMin = starts.length / 60;
    expect(perMin).toBeGreaterThan(12);
    expect(perMin).toBeLessThan(24);
    const s = stats(singles);
    expect(s.median).toBeGreaterThan(3000);
    expect(s.median).toBeLessThan(4300);
  });

  it("is irregular with a long tail, but within bounds (never metronomic, never frantic)", () => {
    const s = stats(singles);
    expect(s.min).toBeGreaterThanOrEqual(1200);
    expect(s.max).toBeLessThanOrEqual(12_000 + 200);
    // Long tail: the mean sits above the median, and the spread is wide.
    expect(s.mean).toBeGreaterThan(s.median);
    const sd = Math.sqrt(singles.reduce((a, g) => a + (g - s.mean) ** 2, 0) / singles.length);
    expect(sd / s.mean).toBeGreaterThan(0.3);
  });

  it("about 15% of blinks are doubles, each ~0.33–0.46 s after the first", () => {
    const share = doubles.length / (singles.length + doubles.length);
    expect(share).toBeGreaterThan(0.08);
    expect(share).toBeLessThan(0.22);
    for (const g of doubles) {
      expect(g).toBeGreaterThanOrEqual(275 + 60);
      expect(g).toBeLessThanOrEqual(275 + 180 + 1);
    }
  });

  it("is deterministic per seed and differs across seeds", () => {
    expect(new BlinkScheduler(42).blinksBetween(0, HOUR)).toEqual(starts);
    expect(new BlinkScheduler(43).blinksBetween(0, HOUR)).not.toEqual(starts);
  });

  it("the rate modifier changes the count (tired blinks less often, worried more)", () => {
    const n = (rate: number) => new BlinkScheduler(7).blinksBetween(0, HOUR, rate).length;
    expect(n(0.6)).toBeLessThan(n(1));
    expect(n(1.4)).toBeGreaterThan(n(1));
  });
});

describe("BlinkScheduler: eyelid curve", () => {
  it("closes fast, holds, reopens slower; open between blinks; droop holds the lids", () => {
    const b = new BlinkScheduler(1);
    const [t0] = b.blinksBetween(0, 20_000);
    const at = (dt: number) => new BlinkScheduler(1).weightAt(t0! + dt);
    expect(new BlinkScheduler(1).weightAt(t0! - 50)).toBe(0);
    expect(at(40)).toBeGreaterThan(0);
    expect(at(40)).toBeLessThan(1);
    expect(at(90)).toBe(1); // closed
    expect(at(75 + 40 + 40)).toBeGreaterThan(at(75 + 40 + 120)); // reopening
    expect(at(400)).toBe(0);
    expect(new BlinkScheduler(1).weightAt(t0! - 50, { droop: 0.45 })).toBeCloseTo(0.45, 5);
  });
});

describe("saccades and look-at", () => {
  it("saccades are small jumps within the amplitude", () => {
    const s = new SaccadeGenerator(5, 2.5);
    let changes = 0;
    let prev = s.offsetAt(0);
    for (let t = 0; t < 60_000; t += 16) {
      const g = s.offsetAt(t);
      expect(Math.abs(g.yaw)).toBeLessThanOrEqual(2.5);
      expect(Math.abs(g.pitch)).toBeLessThanOrEqual(1.5);
      if (Math.abs(g.yaw - prev.yaw) > 0.5) changes++;
      prev = g;
    }
    // A jump every 0.3–2.5 s: dozens per minute, not hundreds.
    expect(changes).toBeGreaterThan(15);
    expect(changes).toBeLessThan(400);
  });

  it("the look-at smoother converges without overshoot and respects head limits", () => {
    const l = new LookAtSmoother(0.2, 300, { yaw: 60, pitch: 35 });
    let maxYaw = 0;
    for (let i = 0; i < 120; i++) maxYaw = Math.max(maxYaw, l.step({ yaw: 30, pitch: -10 }, 1 / 60).yaw);
    expect(l.gaze.yaw).toBeCloseTo(30, 1);
    expect(maxYaw).toBeLessThanOrEqual(30 + 1e-6);
    for (let i = 0; i < 200; i++) l.step({ yaw: 170, pitch: 90 }, 1 / 60);
    expect(l.gaze.yaw).toBeLessThanOrEqual(60 + 1e-6);
    expect(l.gaze.pitch).toBeLessThanOrEqual(35 + 1e-6);
  });
});

describe("breathing and weight shift", () => {
  it("stays subtle, breathes faster when excited and slower when sleepy", () => {
    const crossings = (energy: number, sleepy = false) => {
      let n = 0;
      let prev = bodyIdle(0, { energy, sleepy }).chestPitch;
      for (let t = 16; t < 60_000; t += 16) {
        const c = bodyIdle(t, { energy, sleepy }).chestPitch;
        if (prev <= 0 && c > 0) n++;
        prev = c;
      }
      return n; // ≈ breaths per minute
    };
    expect(crossings(1)).toBeGreaterThan(crossings(0.2));
    expect(crossings(0.5, true)).toBeLessThan(crossings(0.5));
    expect(crossings(0.5)).toBeGreaterThanOrEqual(11);
    expect(crossings(0.5)).toBeLessThanOrEqual(17);
    for (let t = 0; t < 30_000; t += 250) {
      const b = bodyIdle(t, { energy: 1 });
      expect(Math.abs(b.chestPitch)).toBeLessThan(2);
      expect(Math.abs(b.hipsRoll)).toBeLessThan(3);
      expect(Math.abs(b.offsetY)).toBeLessThan(0.01);
    }
  });
});
