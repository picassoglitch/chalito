import { describe, expect, it } from "vitest";
import {
  ACTION_MS,
  FIDGET_EVERY_MS,
  actionLayer,
  fidgetAt,
  fidgetLayer,
  type CreatureAction,
  type CreatureLayer,
} from "../src/actions.js";
import { RETRO_HOLD_MS, holdPose, keyed, steppedTime, type Held } from "../src/retro.js";
import { rigPose, type RigInput } from "../src/rig.js";

const vol = (l: CreatureLayer) => l.scale[0] * l.scale[1] * l.scale[2];

describe("retro stepping (poses held, then snapped)", () => {
  it("time steps on a fixed ~12 fps grid", () => {
    expect(RETRO_HOLD_MS).toBeGreaterThanOrEqual(1000 / 12);
    expect(RETRO_HOLD_MS).toBeLessThanOrEqual(1000 / 8);
    expect(steppedTime(0)).toBe(0);
    expect(steppedTime(RETRO_HOLD_MS - 1)).toBe(0);
    expect(steppedTime(RETRO_HOLD_MS)).toBe(RETRO_HOLD_MS);
    expect(steppedTime(1234, 100)).toBe(1200);
    // No hold: time passes through.
    expect(steppedTime(1234, 0)).toBe(1234);
  });

  for (const fps of [60, 45, 30])
    it(`at ${fps} FPS the pose changes only 8–12 times a second, and holds in between`, () => {
      let held: Held<number> | null = null;
      let changes = 0;
      let prev: number | null = null;
      for (let t = 0; t < 1000; t += 1000 / fps) {
        held = holdPose(held, t, Math.sin(t / 100));
        if (prev !== null && held.value !== prev) changes++;
        prev = held.value;
      }
      expect(changes).toBeGreaterThanOrEqual(8);
      expect(changes).toBeLessThanOrEqual(12);
    });

  it("holds the same object within a hold and takes the live one in the next", () => {
    const a = { v: 1 };
    const b = { v: 2 };
    const h1 = holdPose(null, 10, a);
    expect(holdPose(h1, 20, b).value).toBe(a);
    expect(holdPose(h1, RETRO_HOLD_MS + 1, b).value).toBe(b);
    // A clock that jumps back still snaps to what's live.
    expect(holdPose(h1, -500, b).value).toBe(b);
  });

  it("key poses snap in fast, hold, and start and end at rest", () => {
    const keys = [
      [0.2, 10],
      [0.6, 0],
    ] as const;
    expect(keyed(keys, 0)).toBe(0);
    expect(keyed(keys, 0.19)).toBe(0);
    expect(keyed(keys, 0.2 + 0.06)).toBeCloseTo(10, 6);
    // Held: the same value all through the hold.
    expect(keyed(keys, 0.3)).toBe(keyed(keys, 0.55));
    expect(keyed(keys, 0.7)).toBe(0);
    expect(keyed(keys, 1)).toBe(0);
  });
});

const input = (o: Partial<RigInput> = {}): RigInput => ({
  tMs: 0,
  mode: "rest",
  action: null,
  blink: 0,
  mouth: 0,
  gaze: { yaw: 0, pitch: 0 },
  sleepy: false,
  ...o,
});
const rigAt = (name: CreatureAction, u: number) =>
  rigPose(input({ tMs: 0, action: { name, elapsedMs: u * ACTION_MS[name] } }));

describe("one short move per situation", () => {
  const NEW: CreatureAction[] = ["go", "glance", "perk"];

  for (const a of NEW)
    it(`${a}: holds its key poses (a run of identical frames), keeps the volume, rig back at rest`, () => {
      let run = 0;
      let longest = 0;
      let prev: string | null = null;
      for (let t = 0; t < ACTION_MS[a]; t += 10) {
        const l = actionLayer(a, t);
        expect(vol(l)).toBeCloseTo(1, 6);
        const key = JSON.stringify([l.offsetY, l.scale, l.tilt]);
        run = key === prev ? run + 1 : 0;
        longest = Math.max(longest, run);
        prev = key;
      }
      // At least ~150 ms frozen on one pose: it reads as a held key, not a floaty tween.
      expect(longest * 10).toBeGreaterThanOrEqual(150);
      const rest = rigPose(input());
      expect(rigAt(a, 0.999)).toEqual(rest);
    });

  it("a task started: a quick forward 'let's go' with a fist pump, barely off the ground", () => {
    const mid = actionLayer("go", ACTION_MS.go * 0.4);
    expect(mid.tilt[0]).toBeGreaterThan(3);
    expect(mid.scale[1]).toBeGreaterThan(1);
    const peak = Math.max(...Array.from({ length: 90 }, (_, i) => actionLayer("go", i * 10).offsetY));
    const hop = Math.max(...Array.from({ length: 70 }, (_, i) => actionLayer("hop", i * 10).offsetY));
    expect(peak).toBeLessThan(hop / 4);
    expect(rigAt("go", 0.35).armR).toBeGreaterThan(90);
  });

  it("an agent alert: a sideways glance and a small raised hand", () => {
    expect(Math.abs(actionLayer("glance", ACTION_MS.glance * 0.3).tilt[2])).toBeGreaterThan(3);
    const r = rigAt("glance", 0.45);
    expect(r.head).toBeLessThan(-4);
    expect(r.armR).toBeGreaterThan(40);
    expect(r.armR).toBeLessThan(90);
  });

  it("a message: perks up (stretch, lean back, head up, eyes open)", () => {
    const l = actionLayer("perk", ACTION_MS.perk * 0.3);
    expect(l.scale[1]).toBeGreaterThan(1.03);
    expect(l.tilt[0]).toBeLessThan(0);
    const r = rigPose(input({ blink: 1, action: { name: "perk", elapsedMs: ACTION_MS.perk * 0.3 } }));
    expect(r.headDrop).toBeLessThan(0);
    expect(r.lids).toBe(0);
  });

  it("each situation moves differently", () => {
    const sig = (a: CreatureAction) =>
      JSON.stringify([0.15, 0.3, 0.5, 0.7].map((u) => [actionLayer(a, u * ACTION_MS[a]), rigAt(a, u)]));
    const all = (["go", "glance", "perk", "hop", "slump"] as const).map(sig);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("idle look-around and fidgets", () => {
  it("about once every FIDGET_EVERY_MS, never a jump or a squash", () => {
    for (let n = 0; n < 20; n++) {
      let frames = 0;
      for (let t = n * FIDGET_EVERY_MS; t < (n + 1) * FIDGET_EVERY_MS; t += 50) {
        const l = fidgetLayer(t);
        expect(l.offsetY).toBe(0);
        expect(l.scale).toEqual([1, 1, 1]);
        if (fidgetAt(t)) frames++;
      }
      expect(frames).toBeGreaterThan(0);
      expect(frames * 50).toBeLessThan(FIDGET_EVERY_MS / 4);
    }
  });

  it("a look turns the head; it doesn't fidget while busy, asleep or acting", () => {
    let looked = false;
    let scratched = false;
    for (let t = 0; t < 5 * FIDGET_EVERY_MS; t += 50) {
      const f = fidgetAt(t);
      if (!f || f.u < 0.1 || f.u > 0.6) continue;
      const p = rigPose(input({ tMs: t }));
      if (f.kind === "scratch") scratched ||= p.armL > 30;
      else looked ||= Math.abs(p.head) > 5;
      expect(Math.abs(rigPose(input({ tMs: t, sleepy: true })).head - 4)).toBeLessThan(3);
      expect(rigPose(input({ tMs: t, mode: "working" })).armL).toBeLessThan(16);
    }
    expect(looked || scratched).toBe(true);
  });

  it("is the same for the same time (deterministic)", () => {
    for (let t = 0; t < 30_000; t += 333) expect(fidgetAt(t)).toEqual(fidgetAt(t));
  });
});
