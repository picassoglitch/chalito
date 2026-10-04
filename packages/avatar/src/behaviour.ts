import type { Level } from "@chalito/protocol";
import type { EmotionGesture } from "./emotion.js";

/**
 * The pet's attention behaviour for escalation levels L0–L4 (brief §5 M7):
 *   L0 idle → L1 glance → L2 wave at the screen edge → L3 hop near the cursor → L4 centre "knock".
 * Damped in fullscreen, Do Not Disturb and quiet hours; it never steals focus except at L4.
 * In quiet hours the idle pose is "sleepy"; when credits ran out it's "tired" (the M12
 * in-character recharge).
 */
export type BehaviourState = "idle" | "sleepy" | "tired" | "glance" | "wave" | "hop" | "knock";
export type Anchor = "home" | "edge" | "near_cursor" | "center";

export interface BehaviourContext {
  /** Highest pending escalation level, or null when nothing is waiting. */
  level: Level | null;
  fullscreen: boolean;
  dnd: boolean;
  quietHours: boolean;
  /** Out of credits: the companion is "tired" until recharged. */
  lowEnergy: boolean;
  /** The user acknowledged (clicked the pet, opened the panel, acked elsewhere). */
  acked?: boolean;
}

export interface BehaviourOutput {
  state: BehaviourState;
  /** The level after damping (null = nothing to signal). */
  effectiveLevel: Level | null;
  anchor: Anchor;
  gesture: EmotionGesture | "knock" | "hop" | "glance" | null;
  /** Bring the pet window to the front and take focus. Only ever true at L4. */
  requestFocus: boolean;
  /** The level was reduced by fullscreen / DND / quiet hours. */
  damped: boolean;
}

const RANK: Record<Level, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
const BY_RANK: Level[] = ["L0", "L1", "L2", "L3", "L4"];

/**
 * Damping: quiet hours and DND hold the pet at L0, fullscreen at L1 (a glance, no movement
 * over the user's video or game). L4 always passes: the escalation engine only sends L4
 * through quiet hours for allowlisted overrides.
 */
export const effectiveLevel = (ctx: BehaviourContext): { level: Level | null; damped: boolean } => {
  if (!ctx.level) return { level: null, damped: false };
  if (ctx.level === "L4") return { level: "L4", damped: false };
  const cap = ctx.quietHours || ctx.dnd ? 0 : ctx.fullscreen ? 1 : 4;
  const r = Math.min(RANK[ctx.level], cap);
  return { level: BY_RANK[r]!, damped: r < RANK[ctx.level] };
};

const restState = (ctx: BehaviourContext): BehaviourState =>
  ctx.quietHours ? "sleepy" : ctx.lowEnergy ? "tired" : "idle";

const forLevel = (level: Level | null, ctx: BehaviourContext): Omit<BehaviourOutput, "effectiveLevel" | "damped"> => {
  switch (level) {
    case "L1":
      return { state: "glance", anchor: "home", gesture: "glance", requestFocus: false };
    case "L2":
      return { state: "wave", anchor: "edge", gesture: "wave", requestFocus: false };
    case "L3":
      return { state: "hop", anchor: "near_cursor", gesture: "hop", requestFocus: false };
    case "L4":
      return { state: "knock", anchor: "center", gesture: "knock", requestFocus: true };
    default: {
      const s = restState(ctx);
      return { state: s, anchor: "home", gesture: s === "tired" ? "yawn" : null, requestFocus: false };
    }
  }
};

/** One step of the machine without memory (what the context alone asks for). */
export const behaviourFor = (ctx: BehaviourContext): BehaviourOutput => {
  const { level, damped } = effectiveLevel(ctx);
  return { ...forLevel(level, ctx), effectiveLevel: level, damped };
};

/**
 * Stateful wrapper: escalation is immediate; de-escalation waits `minDwellMs` in the current
 * state (no flicker when levels bounce), except on an explicit ack, which returns to rest at once.
 */
export class BehaviourMachine {
  #out: BehaviourOutput | null = null;
  #since = 0;

  constructor(private readonly minDwellMs = 2500) {}

  update(ctx: BehaviourContext, now: number): BehaviourOutput {
    const want = ctx.acked ? behaviourFor({ ...ctx, level: null }) : behaviourFor(ctx);
    const cur = this.#out;
    if (!cur) return this.#set(want, now);
    const r = (o: BehaviourOutput) => (o.effectiveLevel ? RANK[o.effectiveLevel] : -1);
    if (ctx.acked || r(want) >= r(cur) || now - this.#since >= this.minDwellMs) {
      return want.state === cur.state && want.effectiveLevel === cur.effectiveLevel
        ? this.#keep(want)
        : this.#set(want, now);
    }
    // Holding a higher level a little longer; the rest pose can still change (quiet hours etc.).
    return { ...cur, requestFocus: cur.state === "knock" && effectiveLevel(ctx).level === "L4" };
  }

  #set(o: BehaviourOutput, now: number): BehaviourOutput {
    this.#out = o;
    this.#since = now;
    return o;
  }

  #keep(o: BehaviourOutput): BehaviourOutput {
    this.#out = o;
    return o;
  }
}
