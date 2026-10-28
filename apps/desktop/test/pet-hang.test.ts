import { describe, expect, it } from "vitest";
import { RIG_REST } from "@chalito/avatar";
import { HANG, Pendulum, hangRig, rotateAbout } from "../src/pet/hang.js";

const FRAME = 1 / 60;
const run = (p: Pendulum, xs: (i: number) => number, frames: number) => {
  const angles: number[] = [];
  for (let i = 0; i < frames; i++) angles.push(p.step(xs(i), FRAME));
  return angles;
};

describe("pet hanging from the mouse", () => {
  it("held still it hangs straight", () => {
    const p = new Pendulum();
    expect(run(p, () => 500, 120).every((a) => a === 0)).toBe(true);
    expect(p.settled).toBe(true);
  });

  it("pulled right, the body swings left (trails behind), then back past centre", () => {
    const p = new Pendulum();
    run(p, () => 500, 10);
    const pulled = run(p, (i) => 500 + i * 10, 15);
    expect(Math.min(...pulled)).toBeLessThan(-0.05);
    const stopped = run(p, () => 500 + 15 * 10, 60);
    expect(Math.max(...stopped)).toBeGreaterThan(0);
  });

  it("settles after the drag stops", () => {
    const p = new Pendulum();
    run(p, (i) => 500 + i * 12, 30);
    run(p, () => 860, 60 * 4);
    expect(p.settled).toBe(true);
  });

  it("never swings past the limit, however hard it's yanked", () => {
    const p = new Pendulum();
    const angles = run(p, (i) => (i % 2 ? 0 : 3000), 200);
    expect(Math.max(...angles.map(Math.abs))).toBeLessThanOrEqual(HANG.maxAngle);
  });

  it("a stalled frame (dt 0) or a long hitch doesn't blow up", () => {
    const p = new Pendulum();
    expect(p.step(500, 0)).toBe(0);
    p.step(500, FRAME);
    const a = p.step(900, 5);
    expect(Number.isFinite(a)).toBe(true);
    expect(Math.abs(a)).toBeLessThanOrEqual(HANG.maxAngle);
  });

  it("turns around the grab point: the pivot stays put, the feet swing out", () => {
    const pivot = { x: 0, y: 1 };
    expect(rotateAbout(pivot, pivot, 0.5)).toEqual(pivot);
    const feet = rotateAbout({ x: 0, y: 0 }, pivot, Math.PI / 2);
    expect(feet.x).toBeCloseTo(1);
    expect(feet.y).toBeCloseTo(1);
  });

  it("holds on with both arms up and eyes open", () => {
    const r = hangRig({ ...RIG_REST, lids: 0.8 });
    expect(r).toMatchObject({ armL: 150, armR: 150, lids: 0 });
    expect(r.mouth).toBeGreaterThan(0);
  });
});
