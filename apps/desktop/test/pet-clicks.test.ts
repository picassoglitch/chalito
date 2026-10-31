import { describe, expect, it } from "vitest";
import { BURST_CLICKS, BURST_MS, ClickTracker, DOUBLE_CLICK_MS, TRICKS, pickTrick } from "../src/pet/clicks.js";

describe("pet clicks", () => {
  it("a lone click's trick waits out the double-click window, then plays once", () => {
    const c = new ClickTracker();
    expect(c.click(1000)).toBeNull();
    expect(c.due(1000 + DOUBLE_CLICK_MS - 1)).toBeNull();
    expect(c.due(1000 + DOUBLE_CLICK_MS)).toBe("trick");
    expect(c.due(5000)).toBeNull();
  });

  it("a double click opens the dashboard with no trick first", () => {
    const c = new ClickTracker();
    const seen = [c.click(1000), c.due(1100), c.click(1200), c.due(1200 + DOUBLE_CLICK_MS - 1)];
    expect(seen).toEqual([null, null, null, null]);
    expect(c.due(1200 + DOUBLE_CLICK_MS)).toBe("dashboard");
    expect(c.due(9000)).toBeNull();
  });

  it("clicking fast is play: a third quick click is a trick, not the dashboard, and the burst makes it dizzy", () => {
    const c = new ClickTracker();
    expect([1000, 1200, 1400, 1600].map((t) => c.click(t))).toEqual([null, null, "trick", "dizzy"]);
    expect(c.due(5000)).toBeNull();
    expect(BURST_CLICKS).toBe(4);
  });

  it("a fifth fast click after the dizzy is a fresh single, not half of a double click", () => {
    const c = new ClickTracker();
    expect([1000, 1200, 1400, 1600, 1800].map((t) => c.click(t))).toEqual([null, null, "trick", "dizzy", null]);
    expect(c.due(5000)).toBe("trick");
  });

  it("the double-click and burst windows are exclusive at their edges", () => {
    const c = new ClickTracker();
    expect(c.click(1000)).toBeNull();
    expect(c.due(1000 + DOUBLE_CLICK_MS)).toBe("trick");
    expect(c.click(1000 + DOUBLE_CLICK_MS)).toBeNull();
    expect(c.due(9999)).toBe("trick");
    expect(DOUBLE_CLICK_MS).toBe(300);
    const b = new ClickTracker();
    const out = [0, 600, 1200, 2000].map((t) => [b.click(t), b.due(t + DOUBLE_CLICK_MS)]);
    expect(out).toEqual([
      [null, "trick"],
      [null, "trick"],
      [null, "trick"],
      [null, "trick"],
    ]);
    expect(BURST_MS).toBe(2000);
  });

  it("the click that wakes it plays nothing alone, but still pairs into a double click", () => {
    const alone = new ClickTracker();
    expect(alone.click(1000, true)).toBeNull();
    expect(alone.due(2000)).toBeNull();
    const dbl = new ClickTracker();
    dbl.click(1000, true);
    dbl.click(1150);
    expect(dbl.due(1150 + DOUBLE_CLICK_MS)).toBe("dashboard");
  });

  it("a call or a drag cancels a click still waiting: no trick or dashboard after it", () => {
    const single = new ClickTracker();
    single.click(1000);
    single.cancel();
    expect(single.due(5000)).toBeNull();
    const dbl = new ClickTracker();
    dbl.click(1000);
    dbl.click(1100);
    dbl.cancel();
    expect(dbl.due(5000)).toBeNull();
  });

  it("a single not yet settled by the frame loop still gets its trick when the next click comes", () => {
    const c = new ClickTracker();
    expect(c.click(1000)).toBeNull();
    expect(c.click(1000 + DOUBLE_CLICK_MS + 50)).toBe("trick");
    expect(c.due(5000)).toBe("trick");
    const woke = new ClickTracker();
    woke.click(1000, true);
    expect(woke.click(2000)).toBeNull();
  });

  it("picks every trick over time and never the same one twice in a row", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    let last = null as (typeof TRICKS)[number] | null;
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = pickTrick(last, rand);
      expect(t).not.toBe(last);
      seen.add(t);
      last = t;
    }
    expect([...seen].sort()).toEqual([...TRICKS].sort());
    expect(pickTrick("hop", () => 0.9999999)).not.toBe("hop");
  });
});
