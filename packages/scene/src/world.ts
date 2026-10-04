import * as THREE from "three";
import {
  AvatarDriver,
  CreatureBinding,
  createCardAvatar,
  type CardAvatar,
  type CardItem,
  type CardSpec,
} from "@chalito/avatar-three";
import { EMOTION_DRAWING } from "@chalito/roster";
import type { EmotionTag } from "@chalito/protocol";
import { PORTAL, type ActorState, type SceneState } from "./choreography.js";
import type { LevelSettings } from "./quality.js";
import { hashString } from "./seed.js";

/** A companion's card, loaded: what createCardAvatar needs. */
export interface ActorAssets {
  spec: CardSpec;
  drawings: Record<string, THREE.Texture>;
  items: CardItem[];
}

interface Actor {
  holder: THREE.Group;
  card: CardAvatar;
  bubble: THREE.Group;
  driver: AvatarDriver | null;
  binding: CreatureBinding | null;
  phase: number;
  emotion: EmotionTag | null;
  gestureAt: number | null;
  /** AvatarDriver counts from its own start: epoch ms minus this. */
  origin: number | null;
}

const CARD_HEIGHT = 1;
const PORTAL_COLOR = 0x8b5cf6;

/**
 * The room's three.js scene graph: floor, portal and one card per companion, driven by a
 * SceneState each frame. No renderer and no DOM here (RoomScene owns those), so it runs in tests.
 */
export class RoomWorld {
  readonly scene = new THREE.Scene();
  readonly portal = new THREE.Group();
  readonly #ring: THREE.Mesh;
  readonly #disc: THREE.Mesh;
  readonly #burst: THREE.Mesh;
  readonly #light: THREE.PointLight;
  readonly #actors = new Map<string, Actor>();
  readonly #owned: { dispose(): void }[] = [];
  #level: LevelSettings;

  constructor(level: LevelSettings) {
    this.#level = level;
    const own = <T extends { dispose(): void }>(x: T) => (this.#owned.push(x), x);

    const floor = new THREE.Mesh(
      own(new THREE.CircleGeometry(1, 64)),
      own(new THREE.MeshBasicMaterial({ color: 0xe7f0ea })),
    );
    floor.name = "floor";
    floor.rotation.x = -Math.PI / 2;
    floor.scale.set(2.5, 1.7, 1);
    floor.position.set(0, -0.001, -0.2);
    this.scene.add(floor);

    const glow = (geo: THREE.BufferGeometry, opacity: number) =>
      new THREE.Mesh(
        own(geo),
        own(
          new THREE.MeshBasicMaterial({
            color: PORTAL_COLOR,
            transparent: true,
            opacity,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
          }),
        ),
      );
    this.#ring = glow(new THREE.TorusGeometry(0.5, 0.05, 12, 48), 1);
    this.#ring.name = "portal-ring";
    this.#disc = glow(new THREE.CircleGeometry(0.48, 48), 0.55);
    this.#disc.name = "portal-disc";
    this.#burst = glow(new THREE.CircleGeometry(1.1, 48), 0);
    this.#burst.name = "portal-burst";
    this.#burst.position.z = 0.01;
    this.portal.name = "portal";
    this.portal.add(this.#ring, this.#disc, this.#burst);
    this.portal.position.set(PORTAL.x, 0.6, PORTAL.z);
    this.portal.visible = false;
    this.scene.add(this.portal);
    this.#light = new THREE.PointLight(0xc4b5fd, 0, 4);
    this.#light.position.set(PORTAL.x, 0.7, PORTAL.z + 0.3);
    this.scene.add(this.#light);
  }

  get level(): LevelSettings {
    return this.#level;
  }

  setLevel(level: LevelSettings): void {
    this.#level = level;
    for (const [id, a] of this.#actors) this.#rig(id, a);
  }

  has(id: string): boolean {
    return this.#actors.has(id);
  }

  /** Adds (or replaces) a companion's card once its art is loaded. */
  addActor(id: string, assets: ActorAssets): void {
    this.removeActor(id);
    const card = createCardAvatar(assets.spec, assets.drawings, assets.items, CARD_HEIGHT);
    const holder = new THREE.Group();
    holder.name = `actor:${id}`;
    holder.visible = false;
    holder.add(card.root);
    const bubble = speechBubble(this.#owned);
    bubble.position.set(0.32, CARD_HEIGHT * 1.02, 0.01);
    bubble.visible = false;
    holder.add(bubble);
    this.scene.add(holder);
    const a: Actor = {
      holder,
      card,
      bubble,
      driver: null,
      binding: null,
      phase: (hashString(id) % 1000) / 1000,
      emotion: null,
      gestureAt: null,
      origin: null,
    };
    this.#rig(id, a);
    this.#actors.set(id, a);
  }

  removeActor(id: string): void {
    const a = this.#actors.get(id);
    if (!a) return;
    this.scene.remove(a.holder);
    a.card.dispose();
    this.#actors.delete(id);
  }

  /** The gesture rig only off impostors; the contact shadow only with shadows on. */
  #rig(id: string, a: Actor): void {
    if (this.#level.impostors) {
      a.driver = null;
      a.binding = null;
      a.card.root.scale.set(1, 1, 1);
      a.card.root.position.set(0, 0, 0);
      a.card.root.rotation.set(0, 0, 0);
    } else if (!a.driver) {
      a.driver = new AvatarDriver({ seed: hashString(id) });
      a.binding = new CreatureBinding(a.card.root);
      a.emotion = null;
      a.gestureAt = null;
      a.origin = null;
    }
    const shadow = a.card.root.getObjectByName("shadow");
    if (shadow) shadow.visible = this.#level.shadows;
  }

  /** Applies the scene at time t (epoch ms). */
  update(state: SceneState, t: number): void {
    const open = state.portal.open;
    this.portal.visible = open > 0.001;
    this.portal.scale.setScalar(Math.max(open, 0.001));
    this.portal.rotation.z = (t / 1000) * 0.6;
    (this.#burst.material as THREE.MeshBasicMaterial).opacity = state.portal.burst * 0.45;
    this.#burst.scale.setScalar(0.6 + state.portal.burst * 0.8);
    this.#light.intensity = this.#level.impostors ? 0 : state.portal.burst * 3;
    for (const s of state.actors) {
      const a = this.#actors.get(s.companionId);
      if (a) this.#apply(a, s, t);
    }
  }

  #apply(a: Actor, s: ActorState, t: number): void {
    a.holder.visible = s.phase !== "absent" && s.emerge > 0.001;
    if (!a.holder.visible) return;
    const walking = s.phase === "walking" || (s.phase === "leaving" && s.emerge === 1);
    const hop = walking ? Math.abs(Math.sin((t / 1000) * 9 + a.phase * 6)) * 0.035 : 0;
    a.holder.position.set(s.x, hop, s.z);
    const squash = 1 - 0.2 * s.crouch;
    a.holder.scale.set(s.facing * s.emerge * (1 + 0.1 * s.crouch), s.emerge * squash, 1);
    a.bubble.visible = s.bubble;
    // The bubble stays readable when the card flips.
    a.bubble.scale.x = s.facing;

    a.origin ??= t;
    const local = (at: number) => Math.max(0, at - a.origin!);
    if (a.emotion !== s.emotion) {
      a.card.setDrawing(EMOTION_DRAWING[s.emotion]);
      a.driver?.setEmotion({ tag: s.emotion, intensity: 1 }, local(t));
      a.emotion = s.emotion;
    }
    if (s.gesture && s.gestureAt !== null && a.gestureAt !== s.gestureAt) {
      a.driver?.playGesture(s.gesture, local(s.gestureAt));
      a.gestureAt = s.gestureAt;
    }
    if (a.driver && a.binding) a.binding.apply(a.driver.frame(local(t)));
    else a.card.root.position.y = Math.sin((t / 1000) * 2.2 + a.phase * 6) * 0.012;
  }

  dispose(): void {
    for (const id of [...this.#actors.keys()]) this.removeActor(id);
    for (const o of this.#owned) o.dispose();
  }
}

/** A speech-bubble icon (three dots): never text. */
const speechBubble = (owned: { dispose(): void }[]): THREE.Group => {
  const g = new THREE.Group();
  g.name = "bubble";
  const mat = (color: number) => {
    const m = new THREE.MeshBasicMaterial({ color, depthWrite: false, transparent: true });
    owned.push(m);
    return m;
  };
  const geo = (x: THREE.BufferGeometry) => (owned.push(x), x);
  // A dark rim so the bubble reads on light backgrounds too.
  const rim = new THREE.Mesh(geo(new THREE.CircleGeometry(0.175, 32)), mat(0x334155));
  rim.scale.set(1.22, 0.86, 1);
  rim.position.z = -0.002;
  const body = new THREE.Mesh(geo(new THREE.CircleGeometry(0.16, 32)), mat(0xffffff));
  body.scale.set(1.25, 0.85, 1);
  const tailShape = new THREE.Shape();
  tailShape.moveTo(-0.07, -0.08);
  tailShape.lineTo(-0.16, -0.2);
  tailShape.lineTo(0.0, -0.11);
  const tail = new THREE.Mesh(geo(new THREE.ShapeGeometry(tailShape)), body.material);
  g.add(rim, body, tail);
  for (const x of [-0.08, 0, 0.08]) {
    const dot = new THREE.Mesh(geo(new THREE.CircleGeometry(0.025, 16)), mat(0x334155));
    dot.position.set(x, 0, 0.002);
    g.add(dot);
  }
  g.traverse((o) => (o.renderOrder = 50));
  return g;
};
