import * as THREE from "three";
import type { CardItem, CardSpec } from "@chalito/avatar-three";
import { placeOnCard } from "@chalito/roster";
import type { AccessorySlot } from "@chalito/protocol";
import { isSkinId } from "@chalito/avatar-three";
import { isSceneSkin, type SceneCosmetic } from "./room-scene.js";
import type { ActorAssets } from "./world.js";

interface CardJson {
  width: number;
  height: number;
  layers: { src: string }[];
  emotions?: { src: Record<string, string> };
  shadow?: CardSpec["shadow"];
  anchors?: Partial<Record<AccessorySlot, { x: number; y: number; z: number }>>;
}

export interface CardLoaders {
  fetchJson?: (url: string) => Promise<unknown>;
  loadTexture?: (url: string) => Promise<THREE.Texture>;
}

/**
 * A roster card and its cosmetics, loaded from where @chalito/roster's assets/ and cosmetics/ are
 * served (`assetBase`, e.g. "/roster/"): the room and the desktop pet load cards the same way.
 */
export const loadCardAssets = async (
  assetBase: string,
  avatar: string,
  cosmetics: readonly SceneCosmetic[] = [],
  loaders: CardLoaders = {},
): Promise<ActorAssets> => {
  const base = assetBase.endsWith("/") ? assetBase : `${assetBase}/`;
  if (!/^[a-z0-9_-]+$/.test(avatar)) throw new Error("bad avatar id");
  const dir = `${base}assets/${avatar}/`;
  const fetchJson = loaders.fetchJson ?? (async (u: string) => (await fetch(u)).json());
  const loadTexture = loaders.loadTexture ?? ((u: string) => new THREE.TextureLoader().loadAsync(u));
  const card = (await fetchJson(`${dir}card.json`)) as CardJson;
  const srcs = card.emotions?.src ?? { neutral: card.layers[0]!.src };
  // Loaded in parallel, kept in card.json order (the first one is what a new card shows).
  const entries = Object.entries(srcs);
  const textures = await Promise.all(entries.map(([, src]) => loadTexture(dir + src)));
  const drawings: Record<string, THREE.Texture> = Object.fromEntries(entries.map(([k], i) => [k, textures[i]!]));
  const items: CardItem[] = [];
  let skin: ActorAssets["skin"] = null;
  for (const c of cosmetics) {
    if (isSceneSkin(c)) {
      // One skin per card (the slot holds one); an unknown effect draws the plain card.
      if (isSkinId(c.skin)) skin = c.skin;
      continue;
    }
    const anchor = card.anchors?.[c.slot];
    if (!anchor || !/^cosmetics\/[a-z0-9_]+\.webp$/.test(c.art)) continue;
    const texture = await loadTexture(base + c.art);
    const img = texture.image as { width?: number; height?: number } | undefined;
    const aspect = img?.width && img.height ? img.height / img.width : 1;
    items.push({ placed: placeOnCard(anchor, c.card, aspect, card.height / card.width), texture });
  }
  return { spec: { width: card.width, height: card.height, shadow: card.shadow }, drawings, items, skin };
};
