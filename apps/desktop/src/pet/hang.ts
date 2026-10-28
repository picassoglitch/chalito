import type { RigPose } from "@chalito/avatar";

/** Held by the mouse it hangs from where it was grabbed and swings (owner, 2026-10-26). Pure, so tests drive it. */
export const HANG = {
  /** Pull back to hanging straight (logical px/s²) over the arm's length (px): a ~0.8 s swing. */
  gravity: 1800,
  length: 120,
  /** Per second: a few swings, then still. */
  damping: 3.5,
  /** Never swings past this (radians), so the feet stay inside the window. */
  maxAngle: 0.6,
  /** Smoothing of the window's speed (s): the WM sends moves unevenly. */
  speedTau: 0.06,
  /** Below this angle and speed a released pet counts as settled. */
  restAngle: 0.01,
};

/** A pendulum hanging from the cursor, driven by how the window moves. Angle in radians, + swings right. */
export class Pendulum {
  angle = 0;
  #vel = 0;
  #x: number | null = null;
  #vx = 0;

  constructor(readonly cfg = HANG) {}

  /** One frame: `x` is the window's left edge in logical px, `dt` in seconds. */
  step(x: number, dt: number): number {
    const c = this.cfg;
    const h = Math.min(Math.max(dt, 0), 0.05);
    if (h === 0) return this.angle;
    const prevVx = this.#vx;
    if (this.#x !== null) {
      const raw = (x - this.#x) / h;
      this.#vx += (raw - this.#vx) * Math.min(1, h / c.speedTau);
    }
    this.#x = x;
    const ax = (this.#vx - prevVx) / h;
    // The pivot accelerating right throws the body left: θ'' = -(g/L)·sinθ - (a/L)·cosθ - d·θ'.
    const acc = (-c.gravity * Math.sin(this.angle) - ax * Math.cos(this.angle)) / c.length - c.damping * this.#vel;
    this.#vel += acc * h;
    this.angle = Math.max(-c.maxAngle, Math.min(c.maxAngle, this.angle + this.#vel * h));
    if (Math.abs(this.angle) === c.maxAngle) this.#vel = 0;
    return this.angle;
  }

  get settled(): boolean {
    return Math.abs(this.angle) < this.cfg.restAngle && Math.abs(this.#vel) < this.cfg.restAngle;
  }

  reset(): void {
    this.angle = 0;
    this.#vel = 0;
    this.#x = null;
    this.#vx = 0;
  }
}

/** `p` turned by `angle` (radians, counter-clockwise) around `pivot`. */
export const rotateAbout = (
  p: { x: number; y: number },
  pivot: { x: number; y: number },
  angle: number,
): { x: number; y: number } => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = p.x - pivot.x;
  const dy = p.y - pivot.y;
  return { x: pivot.x + dx * c - dy * s, y: pivot.y + dx * s + dy * c };
};

/** Arms up holding on, eyes wide, mouth a little open ("whoa"). */
export const hangRig = (rig: RigPose): RigPose => ({
  ...rig,
  armL: 150,
  armR: 150,
  lids: 0,
  mouth: Math.max(rig.mouth, 0.35),
});
