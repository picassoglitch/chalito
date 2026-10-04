import { clamp, easeInCubic, easeOutCubic, logNormal, rng, smoothDamp, type Rng } from "./math.js";

// ---------------------------------------------------------------- blinking

export interface BlinkOptions {
  /** Median time between blinks (ms). Spontaneous human blinking is ~15–20/min. */
  medianIntervalMs?: number;
  /** Log-space spread of the interval distribution. */
  sigma?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  /** Probability that a blink is followed by a quick second one. */
  doubleBlinkP?: number;
  /** Eyelid timings (ms): closing, fully closed, opening (opening is the slow part). */
  closeMs?: number;
  holdMs?: number;
  openMs?: number;
}

const BLINK_DEFAULTS: Required<BlinkOptions> = {
  medianIntervalMs: 3600,
  sigma: 0.45,
  minIntervalMs: 1200,
  maxIntervalMs: 12_000,
  doubleBlinkP: 0.15,
  closeMs: 75,
  holdMs: 40,
  openMs: 160,
};

/**
 * Procedural blinking: start times from a seeded log-normal interval distribution (a few
 * seconds, a long tail, never metronomic), occasional double blinks, and an asymmetric
 * eyelid curve (fast close, slower open). `rate` scales the interval (tired 0.6 = slower,
 * worried 1.4 = more often); `droop` holds the lids partly closed.
 */
export class BlinkScheduler {
  readonly #r: Rng;
  readonly #o: Required<BlinkOptions>;
  readonly #starts: number[] = [];
  #nextAt: number;

  constructor(seed: number, opts: BlinkOptions = {}, startAt = 0) {
    this.#r = rng(seed);
    this.#o = { ...BLINK_DEFAULTS, ...opts };
    this.#nextAt = startAt + this.#interval(1);
  }

  get blinkDurationMs(): number {
    return this.#o.closeMs + this.#o.holdMs + this.#o.openMs;
  }

  #interval(rate: number): number {
    const v = logNormal(this.#r, this.#o.medianIntervalMs, this.#o.sigma) / Math.max(0.1, rate);
    return clamp(v, this.#o.minIntervalMs, this.#o.maxIntervalMs);
  }

  /** Generates blink start times up to `t`. `rate` applies to blinks scheduled from now on. */
  #fill(t: number, rate: number): void {
    while (this.#nextAt <= t) {
      const at = this.#nextAt;
      this.#starts.push(at);
      let next = at + this.#interval(rate);
      if (this.#r() < this.#o.doubleBlinkP) {
        // A second blink right after the first one reopens.
        const second = at + this.blinkDurationMs + 60 + this.#r() * 120;
        this.#starts.push(second);
        next = Math.max(next, second + this.#o.minIntervalMs);
      }
      this.#nextAt = next;
    }
  }

  /** Blink start times in [from, to) (generating as needed). */
  blinksBetween(from: number, to: number, rate = 1): number[] {
    this.#fill(to, rate);
    return this.#starts.filter((s) => s >= from && s < to);
  }

  /** Eyelid closure 0 (open) … 1 (closed) at time t (ms); call with non-decreasing t. */
  weightAt(t: number, mods: { rate?: number; droop?: number } = {}): number {
    this.#fill(t, mods.rate ?? 1);
    // Per-frame use: keep only what can still affect the curve (bounded memory over hours).
    while (this.#starts.length > 8 && this.#starts[0]! < t - 10_000) this.#starts.shift();
    const { closeMs, holdMs, openMs } = this.#o;
    let w = 0;
    for (let i = this.#starts.length - 1; i >= 0; i--) {
      const dt = t - this.#starts[i]!;
      if (dt < 0) continue;
      if (dt > closeMs + holdMs + openMs) break;
      w = Math.max(
        w,
        dt < closeMs
          ? easeInCubic(dt / closeMs)
          : dt < closeMs + holdMs
            ? 1
            : 1 - easeOutCubic((dt - closeMs - holdMs) / openMs),
      );
    }
    const droop = clamp(mods.droop ?? 0);
    return clamp(droop + (1 - droop) * w);
  }
}

// ---------------------------------------------------------------- saccades & look-at

export interface Gaze {
  /** Degrees; + yaw = right, + pitch = up. */
  yaw: number;
  pitch: number;
}

/**
 * Micro-saccades around the current fixation: small, quick jumps (±`amplitude` degrees) every
 * 0.3–2.5 s, each reached in ~40 ms and held. Seeded and pure in t.
 */
export class SaccadeGenerator {
  readonly #r: Rng;
  #current: Gaze = { yaw: 0, pitch: 0 };
  #prev: Gaze = { yaw: 0, pitch: 0 };
  #jumpAt = 0;
  #nextAt: number;

  constructor(
    seed: number,
    private readonly amplitude = 2.5,
  ) {
    this.#r = rng(seed ^ 0x5acc);
    this.#nextAt = 300 + this.#r() * 2200;
  }

  offsetAt(t: number): Gaze {
    while (t >= this.#nextAt) {
      this.#prev = this.#current;
      this.#current = {
        yaw: (this.#r() * 2 - 1) * this.amplitude,
        pitch: (this.#r() * 2 - 1) * this.amplitude * 0.6,
      };
      this.#jumpAt = this.#nextAt;
      this.#nextAt += 300 + this.#r() * 2200;
    }
    const k = easeOutCubic((t - this.#jumpAt) / 40);
    return {
      yaw: this.#prev.yaw + (this.#current.yaw - this.#prev.yaw) * k,
      pitch: this.#prev.pitch + (this.#current.pitch - this.#prev.pitch) * k,
    };
  }
}

/**
 * Smooths the head/eye target (cursor, the user, a notification) with a critically damped
 * spring and a speed cap, so the companion turns naturally instead of snapping.
 */
export class LookAtSmoother {
  #gaze: Gaze = { yaw: 0, pitch: 0 };
  #v = { yaw: 0, pitch: 0 };

  constructor(
    private readonly smoothTimeS = 0.25,
    private readonly maxDegPerS = 240,
    /** Joint limits for the head (degrees). */
    private readonly limits = { yaw: 60, pitch: 35 },
  ) {}

  get gaze(): Gaze {
    return { ...this.#gaze };
  }

  step(target: Gaze, dtS: number): Gaze {
    const t = {
      yaw: clamp(target.yaw, -this.limits.yaw, this.limits.yaw),
      pitch: clamp(target.pitch, -this.limits.pitch, this.limits.pitch),
    };
    const y = smoothDamp(this.#gaze.yaw, t.yaw, this.#v.yaw, this.smoothTimeS, dtS, this.maxDegPerS);
    const p = smoothDamp(this.#gaze.pitch, t.pitch, this.#v.pitch, this.smoothTimeS, dtS, this.maxDegPerS);
    this.#gaze = { yaw: y.value, pitch: p.value };
    this.#v = { yaw: y.velocity, pitch: p.velocity };
    return this.gaze;
  }
}

// ---------------------------------------------------------------- breathing & weight shift

export interface BodyIdle {
  /** Chest rotation about X (degrees) from breathing. */
  chestPitch: number;
  /** Vertical offset of the body (metres, model scale) from breathing. */
  offsetY: number;
  /** Hips sway (degrees about Z) and side shift (metres) from slow weight shifts. */
  hipsRoll: number;
  hipsShiftX: number;
  /** Shoulder lift (degrees), coupled to inhale. */
  shoulderLift: number;
}

/**
 * Breathing (~12–16 breaths/min, slower and deeper when relaxed or sleepy, quicker when
 * excited) plus a slow, irregular weight shift built from incommensurate sines. `energy`
 * 0..1 comes from the emotion pose. Pure in t.
 */
export const bodyIdle = (tMs: number, opts: { energy?: number; sleepy?: boolean; seed?: number } = {}): BodyIdle => {
  const energy = clamp(opts.energy ?? 0.5);
  const sleepy = opts.sleepy === true;
  const t = tMs / 1000;
  const bpm = sleepy ? 9 : 11 + energy * 7;
  const depth = sleepy ? 1.4 : 1.1 - energy * 0.3;
  const phase = (t * bpm) / 60;
  // Inhale is shorter than exhale: skew the sine.
  const b = Math.sin(2 * Math.PI * phase + 0.6 * Math.sin(2 * Math.PI * phase));
  const s = (opts.seed ?? 0) % 1000;
  const sway = Math.sin(t * 0.21 + s) * 0.6 + Math.sin(t * 0.077 + s * 1.7) * 0.4;
  return {
    chestPitch: b * 1.2 * depth,
    offsetY: b * 0.004 * depth,
    hipsRoll: sway * (sleepy ? 0.5 : 1.5 + energy),
    hipsShiftX: sway * 0.01 * (sleepy ? 0.3 : 1),
    shoulderLift: Math.max(0, b) * 0.8 * depth,
  };
};
