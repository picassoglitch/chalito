import type { AvatarFrame } from "./driver.js";

export interface Vec3Like {
  set(x: number, y: number, z: number): unknown;
}
export interface Object3DLike {
  scale: Vec3Like;
  position: Vec3Like;
  rotation: Vec3Like;
}

const DEG = Math.PI / 180;

/**
 * Non-humanoid avatars (animals, blobs, the 2.5D image "card"): squash-and-stretch, a bob,
 * a tilt and a body turn toward the gaze, from the frame's creature pose. `base` is the
 * object's resting position.
 */
export class CreatureBinding {
  constructor(
    readonly root: Object3DLike,
    readonly base: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
    /** Image cards stay flat: they only lean, never turn sideways past this (degrees). */
    readonly maxTurn = 25,
  ) {}

  apply(f: AvatarFrame): void {
    const c = f.creature;
    this.root.scale.set(c.scale[0], c.scale[1], c.scale[2]);
    this.root.position.set(this.base.x, this.base.y + c.offsetY, this.base.z);
    const clampTurn = (v: number) => Math.max(-this.maxTurn, Math.min(this.maxTurn, v));
    const yaw = clampTurn(f.gaze.yaw * c.lookAtWeight);
    const pitch = clampTurn(f.gaze.pitch * c.lookAtWeight * 0.5);
    this.root.rotation.set((c.tilt[0] - pitch) * DEG, (c.tilt[1] + yaw) * DEG, c.tilt[2] * DEG);
  }
}
