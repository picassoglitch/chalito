import { describe, expect, it } from "vitest";
import { VRM0_CAPS } from "@chalito/avatar";
import { AvatarDriver } from "../src/driver.js";

describe("AvatarDriver", () => {
  it("is deterministic for a seed and time", () => {
    const run = () => {
      const d = new AvatarDriver({ seed: 7 });
      d.setEmotion({ tag: "happy", intensity: 0.8 }, 0);
      d.lookAt({ yaw: 20, pitch: -5 });
      return [0, 33, 500, 1200].map((t) => d.frame(t));
    };
    expect(run()).toEqual(run());
  });

  it("blends toward the emotion and stays in range", () => {
    const d = new AvatarDriver({ seed: 1 });
    d.setEmotion({ tag: "happy", intensity: 1 }, 0);
    const f = d.frame(2000);
    expect(f.expressions.happy).toBeGreaterThan(0.5);
    for (const v of Object.values(f.expressions)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("VRM0 caps never ask for `surprised`", () => {
    const d = new AvatarDriver({ seed: 1, caps: VRM0_CAPS });
    d.setEmotion({ tag: "surprised", intensity: 1 }, 0);
    expect(d.frame(1500).expressions.surprised ?? 0).toBe(0);
  });

  it("plays the emotion's gesture and releases it at the end", () => {
    const d = new AvatarDriver({ seed: 3 });
    d.playGesture("wave", 0);
    expect(Math.abs(d.frame(900).bones.rightUpperArm?.[2] ?? 0)).toBeGreaterThan(30);
    d.frame(5000);
    expect(d.frame(5100).bones.rightUpperArm).toBeUndefined();
  });

  it("output audio opens the mouth; silence closes it gradually", () => {
    const d = new AvatarDriver({ seed: 2 });
    for (let i = 0; i < 8; i++) d.pushAudio({ rms: 0.25 });
    const open = d.frame(100).expressions.aa!;
    expect(open).toBeGreaterThan(0.3);
    d.pushAudio({ rms: 0 });
    const closing = d.frame(133).expressions.aa!;
    expect(closing).toBeLessThan(open);
    expect(closing).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) d.pushAudio({ rms: 0 });
    expect(d.frame(200).expressions.aa).toBe(0);
  });

  it("gaze follows the target smoothly", () => {
    const d = new AvatarDriver({ seed: 4 });
    d.frame(0);
    d.lookAt({ yaw: 30, pitch: 0 });
    const early = d.frame(50).gaze.yaw;
    let late = early;
    for (let t = 100; t <= 2000; t += 33) late = d.frame(t).gaze.yaw;
    expect(early).toBeLessThan(late);
    expect(late).toBeGreaterThan(25);
  });
});
