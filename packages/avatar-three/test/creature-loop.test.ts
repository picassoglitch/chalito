import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { AvatarDriver } from "../src/driver.js";
import { CreatureBinding } from "../src/creature.js";
import { FrameLoop, type LoopHost } from "../src/frame-loop.js";
import { createPlaceholder } from "../src/placeholder.js";

describe("creature / image-card preset on a three scene", () => {
  it("squashes, bobs and turns the placeholder toward the gaze, within the turn cap", () => {
    const scene = new THREE.Scene();
    const pet = createPlaceholder();
    scene.add(pet);
    expect(pet.getObjectByName("eyeL")).toBeTruthy();
    const d = new AvatarDriver({ seed: 5 });
    d.setEmotion({ tag: "excited", intensity: 1 }, 0);
    d.lookAt({ yaw: 90, pitch: 0 });
    const c = new CreatureBinding(pet, { x: 0, y: 0, z: 0 }, 25);
    let maxY = 0;
    for (let t = 0; t < 3000; t += 33) {
      c.apply(d.frame(t));
      maxY = Math.max(maxY, pet.position.y);
      expect(pet.scale.x * pet.scale.y * pet.scale.z).toBeCloseTo(1, 2);
      expect(Math.abs(pet.rotation.y)).toBeLessThanOrEqual((25 * Math.PI) / 180 + 1e-9);
    }
    expect(maxY).toBeGreaterThan(0.01);
    expect(pet.rotation.y).toBeGreaterThan(0);
  });
});

/** A manual clock standing in for requestAnimationFrame + document visibility. */
const fakeHost = () => {
  let hidden = false;
  let next = 1;
  const pending = new Map<number, (t: number) => void>();
  const listeners = new Set<() => void>();
  const host: LoopHost = {
    requestAnimationFrame: (cb) => {
      pending.set(next, cb);
      return next++;
    },
    cancelAnimationFrame: (id) => void pending.delete(id),
    hidden: () => hidden,
    onVisibilityChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return {
    host,
    pending,
    /** Fire vsyncs at `hz` from t0 for `ms`. */
    run(t0: number, ms: number, hz = 60) {
      for (let t = t0; t < t0 + ms; t += 1000 / hz) {
        const cbs = [...pending.values()];
        pending.clear();
        for (const cb of cbs) cb(t);
      }
    },
    setHidden(h: boolean) {
      hidden = h;
      for (const l of listeners) l();
    },
  };
};

describe("FrameLoop", () => {
  it("caps a 144 Hz display at ~30 fps", () => {
    const h = fakeHost();
    const ticks: number[] = [];
    const loop = new FrameLoop((t) => ticks.push(t), 30, h.host);
    loop.start();
    h.run(0, 1000, 144);
    expect(ticks.length).toBeGreaterThanOrEqual(28);
    expect(ticks.length).toBeLessThanOrEqual(36);
  });

  it("sleeps while hidden (no frames requested) and wakes with dt 0", () => {
    const h = fakeHost();
    const dts: number[] = [];
    const loop = new FrameLoop((_t, dt) => dts.push(dt), 30, h.host);
    loop.start();
    h.run(0, 200);
    h.setHidden(true);
    expect(loop.awake).toBe(false);
    expect(h.pending.size).toBe(0);
    const before = dts.length;
    h.run(200, 5000);
    expect(dts.length).toBe(before);
    h.setHidden(false);
    expect(loop.awake).toBe(true);
    h.run(10_000, 100);
    expect(dts[before]).toBe(0);
    loop.stop();
    expect(h.pending.size).toBe(0);
    expect(loop.running).toBe(false);
  });
});
