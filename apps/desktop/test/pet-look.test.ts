import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { RENDER_DEFAULTS } from "@chalito/scene";
import { PetLook, QualityResolver } from "../src/pet/look.js";

const tex = () => new THREE.Texture();
const assets = {
  spec: { width: 566, height: 952, shadow: { x: 0.5, y: 0.97, rx: 0.32, ry: 0.035, opacity: 0.25 } },
  drawings: { neutral: tex(), happy: tex(), surprised: tex(), tired: tex(), sad: tex() },
  items: [],
};
const frame = {
  expressions: {},
  bones: {},
  gaze: { yaw: 10, pitch: 0 },
  creature: {
    scale: [1.1, 0.9, 1] as [number, number, number],
    offsetY: 0.05,
    tilt: [0, 0, 8] as [number, number, number],
    lookAtWeight: 1,
  },
};

describe("pet render quality (render.yaml, same slider as the room)", () => {
  it("a fixed level is used as is; auto on software GL is bajo at once", () => {
    const q = new QualityResolver(() => "ANGLE (NVIDIA)");
    expect(q.set("medio")).toBe("medio");
    expect(q.frame(0)).toBeNull();
    expect(new QualityResolver(() => "Google SwiftShader").set("auto")).toBe("bajo");
  });

  it("auto probes at alto for probeSeconds, then settles from the measured FPS", () => {
    const slow = new QualityResolver(() => "ANGLE (Intel)");
    expect(slow.set("auto")).toBe("alto");
    let settled = null;
    // 20 FPS for longer than the probe.
    for (let t = 0; t <= RENDER_DEFAULTS.auto.probeSeconds * 1000 + 100 && !settled; t += 50) settled = slow.frame(t);
    expect(settled).toBe("bajo");
    const fast = new QualityResolver(() => "ANGLE (NVIDIA)");
    fast.set("auto");
    settled = null;
    for (let t = 0; t <= RENDER_DEFAULTS.auto.probeSeconds * 1000 + 100 && !settled; t += 1000 / 60)
      settled = fast.frame(t);
    expect(settled).toBe("alto");
  });

  it("bajo is the flat impostor without contact shadow; alto runs the rig with the shadow", () => {
    const look = new PetLook(assets, RENDER_DEFAULTS.levels.bajo);
    const shadow = look.card.root.getObjectByName("shadow")!;
    expect(shadow.visible).toBe(false);
    look.apply(frame, 1000);
    expect(look.card.root.scale.toArray()).toEqual([1, 1, 1]);
    expect(look.card.root.rotation.z).toBe(0);

    look.setLevel(RENDER_DEFAULTS.levels.alto);
    expect(shadow.visible).toBe(true);
    look.apply(frame, 1000);
    expect(look.card.root.scale.x).toBeCloseTo(1.1);
    expect(look.card.root.rotation.z).not.toBe(0);
  });

  it("the drawing follows the emotion", () => {
    const look = new PetLook(assets, RENDER_DEFAULTS.levels.medio);
    const body = look.card.root.getObjectByName("body") as THREE.Mesh;
    look.setEmotion("tired");
    expect((body.material as THREE.MeshBasicMaterial).map).toBe(assets.drawings.tired);
    look.setEmotion("excited");
    expect((body.material as THREE.MeshBasicMaterial).map).toBe(assets.drawings.happy);
  });
});
