import { describe, expect, it } from "vitest";
import { BURST_CLICKS, ClickTracker, DOUBLE_CLICK_MS, TRICKS, pickTrick } from "../src/pet/clicks.js";

describe("pet clicks", () => {
  it("a lone click is a trick and never opens the dashboard", () => {
    const c = new ClickTracker();
    expect(c.click(1000)).toBe("trick");
    expect(c.due(5000)).toBe(false);
  });

  it("two quick clicks open the dashboard once no third follows", () => {
    const c = new ClickTracker();
    expect(c.click(1000)).toBe("trick");
    expect(c.click(1200)).toBeNull();
    expect(c.due(1200 + DOUBLE_CLICK_MS - 1)).toBe(false);
    expect(c.due(1200 + DOUBLE_CLICK_MS)).toBe(true);
    expect(c.due(9000)).toBe(false);
  });

  it("clicking fast is play: the would-be double is dropped and the burst makes it dizzy", () => {
    const c = new ClickTracker();
    const results = [1000, 1200, 1400, 1600].map((t) => c.click(t));
    expect(results).toEqual(["trick", null, "trick", "dizzy"]);
    expect(c.due(5000)).toBe(false);
    expect(BURST_CLICKS).toBe(4);
  });

  it("slow clicks stay tricks, and clicks older than the burst window don't count", () => {
    const c = new ClickTracker();
    expect([1000, 1700, 2400, 3100, 3800].map((t) => c.click(t))).toEqual([
      "trick",
      "trick",
      "trick",
      "trick",
      "trick",
    ]);
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
