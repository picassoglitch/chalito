/** Small, dependency-free math for the companion runtime. Everything here is deterministic. */

export const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Ease-in-out (cubic): slow start, slow finish, the default for expression changes. */
export const easeInOutCubic = (t: number) => {
  const x = clamp(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};
export const easeOutCubic = (t: number) => 1 - (1 - clamp(t)) ** 3;
export const easeInCubic = (t: number) => clamp(t) ** 3;

/** A seeded PRNG (mulberry32): the same seed gives the same companion, frame for frame. */
export const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
export type Rng = ReturnType<typeof rng>;

/** Standard normal (Box–Muller). */
export const normal = (r: Rng) => {
  const u = Math.max(r(), 1e-12);
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/** Log-normal with the given median and log-space sigma. */
export const logNormal = (r: Rng, median: number, sigma: number) => median * Math.exp(sigma * normal(r));

/**
 * Critically damped smoothing toward a target (Unity-style SmoothDamp): no overshoot,
 * reaches the target in about `smoothTime`. Pure: returns the new value and velocity.
 */
export const smoothDamp = (
  current: number,
  target: number,
  velocity: number,
  smoothTime: number,
  dt: number,
  maxSpeed = Infinity,
): { value: number; velocity: number } => {
  // No time passed (first frame, duplicate timestamps): nothing moves. The overshoot branch
  // below divides by dt.
  if (!(dt > 0)) return { value: current, velocity };
  const st = Math.max(1e-4, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const maxChange = maxSpeed * st;
  const change = clamp(current - target, -maxChange, maxChange);
  const tgt = current - change;
  const temp = (velocity + omega * change) * dt;
  let v = (velocity - omega * temp) * exp;
  let out = tgt + (change + temp) * exp;
  // Don't overshoot.
  if (target - current > 0 === out > target) {
    out = target;
    v = (out - target) / dt;
  }
  return { value: out, velocity: v };
};
