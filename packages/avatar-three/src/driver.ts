import {
  ACTION_MS,
  BlinkScheduler,
  EMOTIONS,
  EmotionBlender,
  GESTURES,
  LookAtSmoother,
  SaccadeGenerator,
  VISEMES,
  VRM1_CAPS,
  bodyIdle,
  creaturePose,
  emotionGesture,
  frameShape,
  sampleGesture,
  actionLayer,
  composeCreature,
  modeLayer,
  rigPose,
  type AudioFrame,
  type Bone,
  type CreatureAction,
  type CreatureMode,
  type CreaturePose,
  type EmotionGesture,
  type Gaze,
  type ModelCaps,
  type RigPose,
  type Rot,
  type VisemeWeights,
} from "@chalito/avatar";
import type { Emotion } from "@chalito/protocol";

/** Everything a renderer needs for one frame. Plain data: no three.js types. */
export interface AvatarFrame {
  /** VRM expression name → weight (emotion, blink, visemes, gesture accents). */
  expressions: Record<string, number>;
  /** Humanoid bone → extra Euler rotation in degrees (x, y, z). */
  bones: Partial<Record<Bone, Rot>>;
  /** Eye/head gaze in degrees. */
  gaze: Gaze;
  /** For non-humanoid presets (animals, image cards). */
  creature: CreaturePose;
  /** For cards with a cutout rig: arms, head, eyelids and mouth. */
  rig: RigPose;
}

export interface DriverOptions {
  seed: number;
  caps?: ModelCaps;
}

const VISEME_DEFAULTS = { noiseFloor: 0.02, fullOpenRms: 0.25, attack: 0.6, release: 0.25 };
const ZERO_VISEMES: VisemeWeights = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };

const addRot = (a: Rot | undefined, b: Rot): Rot => (a ? [a[0] + b[0], a[1] + b[1], a[2] + b[2]] : b);

/**
 * Drives @chalito/avatar's pure pieces over time: the emotion blender, blinking, saccades,
 * look-at smoothing, breathing, gestures and streaming visemes. `frame(now)` is all a
 * three-vrm (or creature) binding needs.
 */
export class AvatarDriver {
  readonly #blender: EmotionBlender;
  readonly #blink: BlinkScheduler;
  readonly #saccade: SaccadeGenerator;
  readonly #look = new LookAtSmoother();
  #emotion: Emotion = { tag: "neutral", intensity: 1 };
  #gesture: { name: EmotionGesture; start: number; weight: number } | null = null;
  #target: Gaze = { yaw: 0, pitch: 0 };
  #visemes: VisemeWeights = { ...ZERO_VISEMES };
  #sleepy = false;
  #mode: CreatureMode = "rest";
  /** When the mode last changed (the first frame after setMode, so it needs no clock). */
  #modeSince: number | null = null;
  #action: { name: CreatureAction; start: number } | null = null;
  #last: number | null = null;

  constructor(readonly opts: DriverOptions) {
    this.#blender = new EmotionBlender(opts.caps ?? VRM1_CAPS);
    this.#blink = new BlinkScheduler(opts.seed);
    this.#saccade = new SaccadeGenerator(opts.seed);
  }

  /** A reply's `{emotion}` (and its gesture, if intensity reaches the threshold). */
  setEmotion(e: Emotion, now: number): void {
    this.#emotion = e;
    this.#blender.set(e, now);
    const g = emotionGesture(e);
    if (g) this.playGesture(g, now);
  }

  playGesture(name: EmotionGesture, now: number, weight = 1): void {
    this.#gesture = { name, start: now, weight };
    // Cards show the hello and the cheer with their arms too.
    if (name === "wave") this.playAction("wave", now);
    else if (name === "celebrate") this.playAction("cheer", now);
    else if (name === "nod") this.playAction("nod", now);
  }

  /** What it's busy with while it lasts: rest, working (an AI is busy) or needs_you (an answer waits). */
  setMode(mode: CreatureMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.#modeSince = null;
  }

  get mode(): CreatureMode {
    return this.#mode;
  }

  /** A one-off movement that shows something happened (a finished task, an error, hello). */
  playAction(name: CreatureAction, now: number): void {
    this.#action = { name, start: now };
  }

  stopGesture(): void {
    this.#gesture = null;
  }

  /** Where to look (cursor, the user, a notification), in degrees. */
  lookAt(target: Gaze): void {
    this.#target = target;
  }

  /** Quiet hours: slow breathing, droopy lids. */
  setSleepy(on: boolean): void {
    this.#sleepy = on;
  }

  /** One analysis frame of the companion's own output audio (streaming lip-sync). */
  pushAudio(f: AudioFrame): void {
    const target = frameShape(f, VISEME_DEFAULTS);
    const next = { ...ZERO_VISEMES };
    for (const v of VISEMES) {
      const k = target[v] > this.#visemes[v] ? VISEME_DEFAULTS.attack : VISEME_DEFAULTS.release;
      const w = this.#visemes[v] + (target[v] - this.#visemes[v]) * k;
      next[v] = w < 1e-3 ? 0 : w;
    }
    this.#visemes = next;
  }

  frame(now: number): AvatarFrame {
    const dt = this.#last === null ? 0 : Math.max(0, (now - this.#last) / 1000);
    this.#last = now;
    const pose = EMOTIONS[this.#emotion.tag];
    const i = this.#emotion.intensity;

    const expressions: Record<string, number> = { ...this.#blender.sample(now) };
    const droop = Math.max(pose.eyelidDroop * i, this.#sleepy ? 0.5 : 0);
    expressions.blink = this.#blink.weightAt(now, { rate: pose.blinkRate * (this.#sleepy ? 0.6 : 1), droop });
    for (const v of VISEMES) expressions[v] = Math.max(expressions[v] ?? 0, this.#visemes[v]);

    let bones: Partial<Record<Bone, Rot>> = {};
    if (this.#gesture) {
      const g = sampleGesture(GESTURES[this.#gesture.name], now - this.#gesture.start, this.#gesture.weight);
      bones = { ...g.bones };
      for (const [k, v] of Object.entries(g.expressions ?? {})) expressions[k] = Math.max(expressions[k] ?? 0, v ?? 0);
      if (g.done) this.#gesture = null;
    }
    const body = bodyIdle(now, { energy: pose.energy * i + 0.5 * (1 - i), sleepy: this.#sleepy, seed: this.opts.seed });
    bones.chest = addRot(bones.chest, [body.chestPitch, 0, 0]);
    bones.hips = addRot(bones.hips, [0, 0, body.hipsRoll]);
    bones.head = addRot(bones.head, [-pose.headPitch * i - (this.#sleepy ? 8 : 0), 0, 0]);

    const saccade = this.#saccade.offsetAt(now);
    const smooth = this.#look.step(this.#target, dt);
    const gaze = { yaw: smooth.yaw + saccade.yaw, pitch: smooth.pitch + saccade.pitch };

    if (this.#action && now - this.#action.start >= ACTION_MS[this.#action.name]) this.#action = null;
    const action = this.#action ? { name: this.#action.name, elapsedMs: now - this.#action.start } : null;
    this.#modeSince ??= now;
    const layers = [modeLayer(this.#mode, now - this.#modeSince)];
    if (action) layers.push(actionLayer(action.name, action.elapsedMs));
    const creature = composeCreature(creaturePose(this.#emotion, now), layers);
    const mouth = Math.max(
      expressions.aa ?? 0,
      expressions.oh ?? 0,
      (expressions.ou ?? 0) * 0.7,
      expressions.ih ?? 0,
      expressions.ee ?? 0,
    );
    const rig = rigPose({
      tMs: now,
      mode: this.#mode,
      action,
      blink: expressions.blink ?? 0,
      mouth,
      gaze,
      sleepy: this.#sleepy,
    });
    return { expressions, bones, gaze, creature, rig };
  }
}
