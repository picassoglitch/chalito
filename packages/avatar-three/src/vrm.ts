import { EXPRESSIONS, VISEMES, type Bone, type ModelCaps, type Rot } from "@chalito/avatar";
import type { AvatarFrame } from "./driver.js";

/**
 * The slice of a three-vrm `VRM` this binding touches. Structural, so tests can pass a
 * mock and the real `VRM` (three-vrm 3.x) satisfies it as is.
 */
export interface RotationLike {
  set(x: number, y: number, z: number): unknown;
}
export interface BoneNodeLike {
  rotation: RotationLike;
}
export interface VrmLike {
  meta: { metaVersion: "0" | "1" };
  expressionManager?: {
    expressions: readonly { expressionName: string }[];
    setValue(name: string, weight: number): void;
  } | null;
  humanoid: { getNormalizedBoneNode(name: Bone): BoneNodeLike | null };
  lookAt?: { autoUpdate: boolean; yaw: number; pitch: number } | null;
  update(delta: number): void;
}

const DEG = Math.PI / 180;

/**
 * Rotation convention of the gesture library: mirrored per side, so +z raises an arm and
 * +y swings it forward on either side. Normalized VRM bones are in T-pose with the model
 * facing +Z, which puts the right arm on -X: right-side bones get y and z negated.
 */
const RIGHT = new Set<Bone>(["rightUpperArm", "rightLowerArm", "rightHand"]);

/** Relaxed arms instead of the T-pose (same convention as the gestures). */
export const REST_POSE: Partial<Record<Bone, Rot>> = {
  leftUpperArm: [0, 0, -70],
  rightUpperArm: [0, 0, -70],
  leftLowerArm: [0, -10, 0],
  rightLowerArm: [0, -10, 0],
};

const BONES: readonly Bone[] = [
  "hips",
  "spine",
  "chest",
  "neck",
  "head",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
];

/** Which of the expressions the driver produces this model actually has. */
export const capsOf = (vrm: VrmLike): ModelCaps => ({
  available: new Set((vrm.expressionManager?.expressions ?? []).map((e) => e.expressionName)),
});

/** Every expression name the driver can emit (emotions, blink, visemes). */
const DRIVEN = [...new Set<string>([...EXPRESSIONS, "blink", ...VISEMES])];

/**
 * Applies an {@link AvatarFrame} to a VRM: expression weights, bone rotations (rest pose +
 * gesture/idle offsets, degrees → radians), look-at yaw/pitch, then `vrm.update(dt)`.
 * Expressions the model lacks are skipped (the driver already re-expressed them, e.g.
 * VRM0 `surprised`).
 */
export class VrmBinding {
  readonly caps: ModelCaps;
  readonly #driven: string[];

  constructor(
    readonly vrm: VrmLike,
    readonly rest: Partial<Record<Bone, Rot>> = REST_POSE,
  ) {
    this.caps = capsOf(vrm);
    this.#driven = DRIVEN.filter((n) => this.caps.available.has(n));
    // We drive yaw/pitch ourselves (smoothed + saccades); three-vrm's target tracking would fight it.
    if (vrm.lookAt) vrm.lookAt.autoUpdate = false;
  }

  apply(f: AvatarFrame, dtSeconds: number): void {
    const em = this.vrm.expressionManager;
    if (em) for (const n of this.#driven) em.setValue(n, f.expressions[n] ?? 0);
    for (const b of BONES) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(b);
      if (!node) continue;
      const r = this.rest[b];
      const g = f.bones[b];
      const x = (r?.[0] ?? 0) + (g?.[0] ?? 0);
      let y = (r?.[1] ?? 0) + (g?.[1] ?? 0);
      let z = (r?.[2] ?? 0) + (g?.[2] ?? 0);
      if (RIGHT.has(b)) {
        y = -y;
        z = -z;
      }
      node.rotation.set(x * DEG, y * DEG, z * DEG);
    }
    if (this.vrm.lookAt) {
      this.vrm.lookAt.yaw = f.gaze.yaw;
      this.vrm.lookAt.pitch = f.gaze.pitch;
    }
    this.vrm.update(dtSeconds);
  }
}
