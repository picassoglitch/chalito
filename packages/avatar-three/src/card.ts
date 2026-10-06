import * as THREE from "three";
import { createSkinMaterial, isSkinId, type SkinId, type SkinMaterial } from "./skin.js";

/**
 * The 2.5D image-card avatar (roster cards, D-059): one upright plane per drawing, cosmetics as
 * planes at the card's anchors, and a soft contact shadow. Drive `root` with CreatureBinding (bob,
 * squash, lean) and swap drawings with `setDrawing` as the emotion changes. Card space is 0..1 of
 * the card's width and height, origin top-left (as in card.json and roster's `placeOnCard`).
 * `setSkin` puts a material effect (gold, galaxy…) over the drawing; it survives drawing swaps.
 * Call `tick` from the frame loop so animated skins move.
 */
export interface CardSpec {
  width: number;
  height: number;
  shadow?: { x: number; y: number; rx: number; ry: number; opacity: number };
}

/** A cosmetic placed in card space (roster `placeOnCard`), with its loaded texture. */
export interface CardItem {
  placed: { left: number; top: number; width: number; height: number; z: number };
  texture: THREE.Texture;
}

export interface CardAvatar {
  root: THREE.Group;
  setDrawing(name: string): void;
  /** A material effect over the drawing (not the items); null (or an unknown id) is the plain drawing. */
  setSkin(skin: SkinId | null): void;
  readonly skin: SkinId | null;
  /** Animates the skin: `seconds` is any steadily increasing clock (epoch seconds are fine). */
  tick(seconds: number): void;
  dispose(): void;
}

const SKIN_PERIOD_S = 3600;

/** Draw order: the body sits at 10, items before (z < 0) or after (z > 0) it, the shadow first. */
const ORDER = { shadow: 0, body: 10 };

export const createCardAvatar = (
  spec: CardSpec,
  drawings: Record<string, THREE.Texture>,
  items: readonly CardItem[] = [],
  /** The card's height in world units; its feet stand at y = 0. */
  height = 1,
): CardAvatar => {
  const width = (height * spec.width) / spec.height;
  // Card space (u right, v down, 0..1) → local space (x centred, y up from the feet).
  const at = (u: number, v: number) => new THREE.Vector3((u - 0.5) * width, (1 - v) * height, 0);
  const root = new THREE.Group();
  root.name = "chalito-card";
  const owned: { dispose(): void }[] = [];
  const plane = (w: number, h: number, map: THREE.Texture | null, order: number, opacity = 1) => {
    if (map) map.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshBasicMaterial({ map, transparent: true, opacity, depthWrite: false });
    owned.push(geo, mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = order;
    return mesh;
  };

  if (spec.shadow) {
    const s = spec.shadow;
    const geo = new THREE.CircleGeometry(1, 48);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: s.opacity,
      depthWrite: false,
    });
    owned.push(geo, mat);
    const shadow = new THREE.Mesh(geo, mat);
    shadow.name = "shadow";
    shadow.renderOrder = ORDER.shadow;
    shadow.scale.set(s.rx * width, s.ry * height, 1);
    shadow.position.copy(at(s.x, s.y)).setZ(-0.002);
    root.add(shadow);
  }

  const first = Object.values(drawings)[0] ?? null;
  const body = plane(width, height, first, ORDER.body);
  body.name = "body";
  body.position.copy(at(0.5, 0.5));
  root.add(body);
  const plain = body.material as THREE.MeshBasicMaterial;
  let current: THREE.Texture | null = first;
  let skin: SkinId | null = null;
  let skinned: SkinMaterial | null = null;

  for (const [i, it] of items.entries()) {
    const p = it.placed;
    const mesh = plane(
      p.width * width,
      p.height * height,
      it.texture,
      ORDER.body + p.z * 2 + (p.z >= 0 ? 1 : -1) + i * 0.01,
    );
    mesh.name = `item-${i}`;
    mesh.position.copy(at(p.left + p.width / 2, p.top + p.height / 2)).setZ(p.z * 0.001);
    root.add(mesh);
  }

  return {
    root,
    get skin() {
      return skin;
    },
    setDrawing(name) {
      const map = drawings[name];
      if (!map) return;
      map.colorSpace = THREE.SRGBColorSpace;
      current = map;
      if (plain.map !== map) {
        plain.map = map;
        plain.needsUpdate = true;
      }
      if (skinned) skinned.uniforms.map.value = map;
    },
    setSkin(next) {
      const want = isSkinId(next) ? next : null;
      if (want === skin) return;
      const time = skinned?.uniforms.uTime.value ?? 0;
      skinned?.dispose();
      skinned = want ? createSkinMaterial(want, current, spec.height / spec.width) : null;
      if (skinned) skinned.uniforms.uTime.value = time;
      skin = want;
      (body as THREE.Mesh<THREE.BufferGeometry, THREE.Material>).material = skinned ?? plain;
    },
    tick(seconds) {
      // Wrapped: the shader's float32 can't hold epoch seconds (a skin loops once an hour).
      if (skinned) skinned.uniforms.uTime.value = seconds % SKIN_PERIOD_S;
    },
    dispose() {
      for (const o of owned) o.dispose();
      skinned?.dispose();
    },
  };
};
