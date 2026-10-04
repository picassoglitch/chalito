import { describe, expect, it } from "vitest";
import { changedEnough, contains, ndcToCanvas, toScreenHitBox } from "../src/lib/hitbox.js";

describe("hit-box math", () => {
  it("NDC → canvas pixels (y down), clipped to the canvas", () => {
    expect(ndcToCanvas({ minX: -0.5, maxX: 0.5, minY: -1, maxY: 0 }, { width: 400, height: 200 })).toEqual({
      x: 100,
      y: 100,
      width: 200,
      height: 100,
    });
    // Partly off-screen: clipped.
    expect(ndcToCanvas({ minX: 0.5, maxX: 3, minY: 0.5, maxY: 2 }, { width: 400, height: 200 })).toEqual({
      x: 300,
      y: 0,
      width: 100,
      height: 50,
    });
    // Entirely off-screen or empty: nothing to hit.
    expect(ndcToCanvas({ minX: 1.2, maxX: 3, minY: 0, maxY: 1 }, { width: 400, height: 200 })).toBeNull();
    expect(ndcToCanvas({ minX: 0, maxX: 0, minY: 0, maxY: 1 }, { width: 400, height: 200 })).toBeNull();
  });

  it("canvas CSS rect → physical screen box: window position, HiDPI scale, padding", () => {
    const r = { x: 100, y: 50, width: 80, height: 120 };
    expect(toScreenHitBox(r, { innerX: 1000, innerY: 400, scale: 1 }, { padding: 0 })).toEqual({
      x: 1100,
      y: 450,
      width: 80,
      height: 120,
    });
    // 2x display: CSS pixels double, the window origin is already physical.
    expect(toScreenHitBox(r, { innerX: 1000, innerY: 400, scale: 2 }, { padding: 5 })).toEqual({
      x: 1000 + 95 * 2,
      y: 400 + 45 * 2,
      width: 90 * 2,
      height: 130 * 2,
    });
    // Monitors left of the primary one have negative origins.
    expect(toScreenHitBox(r, { innerX: -1920, innerY: 0, scale: 1.25 }, { padding: 0 })!.x).toBe(-1920 + 125);
    expect(toScreenHitBox(null, { innerX: 0, innerY: 0, scale: 1 })).toBeNull();
  });

  it("contains is half-open, like the Rust side", () => {
    const b = { x: 10, y: 10, width: 10, height: 10 };
    expect(contains(b, 10, 10)).toBe(true);
    expect(contains(b, 19.9, 19.9)).toBe(true);
    expect(contains(b, 20, 15)).toBe(false);
    expect(contains(null, 15, 15)).toBe(false);
  });

  it("only re-sends a box that moved more than the tolerance", () => {
    const a = { x: 0, y: 0, width: 100, height: 100 };
    expect(changedEnough(a, { ...a, x: 2 })).toBe(false);
    expect(changedEnough(a, { ...a, x: 3 })).toBe(true);
    expect(changedEnough(a, { ...a, height: 97 })).toBe(true);
    expect(changedEnough(null, a)).toBe(true);
    expect(changedEnough(a, null)).toBe(true);
    expect(changedEnough(null, null)).toBe(false);
  });
});
