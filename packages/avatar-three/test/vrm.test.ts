import { describe, expect, it } from "vitest";
import type { Bone } from "@chalito/avatar";
import { AvatarDriver } from "../src/driver.js";
import { VrmBinding, capsOf, REST_POSE, type VrmLike } from "../src/vrm.js";

/** A mocked three-vrm VRM: records what the binding writes. */
const mockVrm = (version: "0" | "1", names: string[]) => {
  const set: Record<string, number> = {};
  const rot: Partial<Record<Bone, [number, number, number]>> = {};
  const updates: number[] = [];
  const lookAt = { autoUpdate: true, yaw: 0, pitch: 0 };
  const vrm: VrmLike = {
    meta: { metaVersion: version },
    expressionManager: {
      expressions: names.map((expressionName) => ({ expressionName })),
      setValue: (n, w) => {
        set[n] = w;
      },
    },
    humanoid: {
      getNormalizedBoneNode: (b) =>
        b === "leftHand" ? null : { rotation: { set: (x: number, y: number, z: number) => (rot[b] = [x, y, z]) } },
    },
    lookAt,
    update: (dt) => void updates.push(dt),
  };
  return { vrm, set, rot, updates, lookAt };
};

const VRM1 = ["happy", "angry", "sad", "relaxed", "surprised", "neutral", "aa", "ih", "ou", "ee", "oh", "blink"];
const DEG = Math.PI / 180;

describe("VrmBinding (mocked three-vrm)", () => {
  it("derives caps from the model and takes over look-at", () => {
    const m = mockVrm(
      "0",
      VRM1.filter((n) => n !== "surprised"),
    );
    const b = new VrmBinding(m.vrm);
    expect(b.caps.available.has("surprised")).toBe(false);
    expect(capsOf(m.vrm).available.has("happy")).toBe(true);
    expect(m.lookAt.autoUpdate).toBe(false);
  });

  it("writes expressions, bones (degrees → radians, rest pose, right side mirrored), gaze, then updates", () => {
    const m = mockVrm("1", VRM1);
    const b = new VrmBinding(m.vrm);
    b.apply(
      {
        expressions: { happy: 0.7, blink: 1, aa: 0.2, custom: 1 },
        bones: { head: [10, 0, 0], rightUpperArm: [0, 0, 75] },
        gaze: { yaw: 12, pitch: -3 },
        creature: { scale: [1, 1, 1], offsetY: 0, tilt: [0, 0, 0], lookAtWeight: 1 },
      },
      1 / 30,
    );
    expect(m.set).toMatchObject({ happy: 0.7, blink: 1, aa: 0.2, sad: 0, surprised: 0 });
    expect(m.set.custom).toBeUndefined(); // only names the driver owns
    expect(m.rot.head![0]).toBeCloseTo(10 * DEG);
    const restZ = REST_POSE.rightUpperArm![2];
    expect(m.rot.rightUpperArm![2]).toBeCloseTo(-(restZ + 75) * DEG);
    expect(m.rot.leftUpperArm![2]).toBeCloseTo(REST_POSE.leftUpperArm![2] * DEG);
    expect(m.rot.leftHand).toBeUndefined(); // missing bones are skipped
    expect(m.lookAt).toMatchObject({ yaw: 12, pitch: -3 });
    expect(m.updates).toEqual([1 / 30]);
  });

  it("skips expressions the model lacks (VRM0 surprised)", () => {
    const m = mockVrm(
      "0",
      VRM1.filter((n) => n !== "surprised"),
    );
    const d = new AvatarDriver({ seed: 1, caps: new VrmBinding(m.vrm).caps });
    const b = new VrmBinding(m.vrm);
    d.setEmotion({ tag: "surprised", intensity: 1 }, 0);
    b.apply(d.frame(1000), 0);
    expect("surprised" in m.set).toBe(false);
    expect(m.set.aa).toBeGreaterThan(0); // re-expressed as an open mouth
  });
});
