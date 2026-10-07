import * as THREE from "three";
import { CreatureBinding, createCardAvatar, type AvatarFrame, type CardAvatar } from "@chalito/avatar-three";
import { EMOTION_DRAWING } from "@chalito/roster";
import type { EmotionTag } from "@chalito/protocol";
import {
  RENDER_DEFAULTS,
  isSoftwareRenderer,
  pickQuality,
  type ActorAssets,
  type LevelSettings,
  type QualityLevel,
  type RenderQuality,
} from "@chalito/scene";

/**
 * Where "auto" stands: settled on a level, or probing at alto until `probeSeconds` have passed
 * (software GL never probes: it is bajo straight away). Same rule as the room view.
 */
export class QualityResolver {
  #level: QualityLevel = "alto";
  #probe: { start: number; frames: number } | null = null;
  #settled = false;

  constructor(
    readonly rendererName: () => string | null,
    readonly cfg = RENDER_DEFAULTS,
  ) {}

  get level(): QualityLevel {
    return this.#level;
  }

  /** Sets the slider's value; returns the level to draw at now. */
  set(q: RenderQuality): QualityLevel {
    this.#probe = null;
    this.#settled = q !== "auto";
    if (q !== "auto") this.#level = q;
    else if (isSoftwareRenderer(this.rendererName())) {
      this.#level = "bajo";
      this.#settled = true;
    } else this.#level = "alto";
    return this.#level;
  }

  /** Call once per drawn frame (ms). Returns a new level when "auto" settles, else null. */
  frame(now: number): QualityLevel | null {
    if (this.#settled) return null;
    if (!this.#probe) {
      this.#probe = { start: now, frames: 0 };
      return null;
    }
    this.#probe.frames++;
    const secs = (now - this.#probe.start) / 1000;
    if (secs < this.cfg.auto.probeSeconds) return null;
    this.#settled = true;
    this.#level = pickQuality({ renderer: this.rendererName(), fps: this.#probe.frames / secs }, this.cfg);
    return this.#level;
  }
}

/**
 * The pet's companion card at a render level: bajo is the flat card impostor (no gesture rig, no
 * contact shadow), medio and alto run the avatar driver (bob, squash, lean, gestures), alto adds
 * the contact shadow. The driver keeps running either way so the pet's state stays in step.
 */
export class PetLook {
  readonly root = new THREE.Group();
  readonly card: CardAvatar;
  readonly #binding: CreatureBinding;
  #level: LevelSettings;
  #emotion: EmotionTag | null = null;

  constructor(assets: ActorAssets, level: LevelSettings) {
    this.card = createCardAvatar(assets.spec, assets.drawings, assets.items, 1);
    // The equipped skin (store), drawn over the card whatever the emotion drawing.
    this.card.setSkin(assets.skin ?? null);
    this.root.add(this.card.root);
    this.#binding = new CreatureBinding(this.card.root);
    this.#level = level;
    this.setLevel(level);
  }

  setLevel(level: LevelSettings): void {
    this.#level = level;
    const shadow = this.card.root.getObjectByName("shadow");
    if (shadow) shadow.visible = level.shadows;
    if (level.impostors) {
      this.card.root.scale.set(1, 1, 1);
      this.card.root.rotation.set(0, 0, 0);
    }
  }

  setEmotion(tag: EmotionTag): void {
    if (tag === this.#emotion) return;
    this.#emotion = tag;
    this.card.setDrawing(EMOTION_DRAWING[tag]);
  }

  apply(frame: AvatarFrame, now: number): void {
    this.card.tick(now / 1000);
    if (this.#level.impostors) {
      // The impostor only breathes: a small bob, no squash, lean or turn.
      this.card.root.position.set(0, Math.sin((now / 1000) * 2.2) * 0.012, 0);
      return;
    }
    this.#binding.apply(frame);
  }

  dispose(): void {
    this.card.dispose();
  }
}
