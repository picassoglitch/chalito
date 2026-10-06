import * as THREE from "three";
import type { CardItem, CardSpec } from "@chalito/avatar-three";
import { placeOnCard } from "@chalito/roster";
import type { AccessorySlot } from "@chalito/protocol";
import { isSkinId } from "@chalito/avatar-three";
import { isSceneSkin, type SceneCosmetic } from "./room-scene.js";
import type { ActorAssets } from "./world.js";
import { isCardFiles, type CardRef } from "./custom-card.js";

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
 * A card and its cosmetics. A roster card (`avatar` a roster id) loads from where @chalito/roster's
 * assets/ and cosmetics/ are served (`assetBase`, e.g. "/roster/"); a card with its own files (a
 * person's custom companion, signed URLs) loads each file from `avatar.url`, with its card.json
 * given or fetched the same way. Cosmetics always come from the asset base. The room, the store
 * preview and the desktop pet load cards the same way.
 */
export const loadCardAssets = async (
  assetBase: string,
  avatar: CardRef,
  cosmetics: readonly SceneCosmetic[] = [],
  loaders: CardLoaders = {},
): Promise<ActorAssets> => {
  const base = assetBase.endsWith("/") ? assetBase : `${assetBase}/`;
  const fetchJson = loaders.fetchJson ?? (async (u: string) => (await fetch(u)).json());
  const loadTexture = loaders.loadTexture ?? ((u: string) => new THREE.TextureLoader().loadAsync(u));
  if (isCardFiles(avatar)) {
    const files = avatar;
    const fileUrl = (f: string) => {
      const u = files.url(f);
      if (!u) throw new Error(`card file missing: ${f}`);
      return u;
    };
    // An expired signed URL: one refresh per load (shared by the drawings failing together), then
    // each failed file is tried once more.
    let refreshing: Promise<void> | null = null;
    const retry = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        if (!files.refresh) throw err;
        refreshing ??= files.refresh();
        await refreshing;
        return fn();
      }
    };
    const card = (files.manifest ?? (await retry(() => fetchJson(fileUrl("card.json"))))) as CardJson;
    if (!card || !(card.width > 0) || !(card.height > 0) || !(card.emotions?.src.neutral ?? card.layers?.[0]?.src))
      throw new Error("bad card");
    const textures = await loadDrawings(card, (src) => retry(() => loadTexture(fileUrl(src))));
    return finish(base, card, textures, cosmetics, loadTexture);
  }
  if (!/^[a-z0-9_-]+$/.test(avatar)) throw new Error("bad avatar id");
  const dir = `${base}assets/${avatar}/`;
  const card = (await fetchJson(`${dir}card.json`)) as CardJson;
  return finish(base, card, await loadDrawings(card, (src) => loadTexture(dir + src)), cosmetics, loadTexture);
};

/** The card's drawings, loaded in parallel and kept in card.json order (the first is what a new card shows). */
const loadDrawings = async (
  card: CardJson,
  load: (src: string) => Promise<THREE.Texture>,
): Promise<Record<string, THREE.Texture>> => {
  const srcs = card.emotions?.src ?? { neutral: card.layers[0]!.src };
  const entries = Object.entries(srcs);
  const textures = await Promise.all(entries.map(([, src]) => load(src)));
  return Object.fromEntries(entries.map(([k], i) => [k, textures[i]!]));
};

/** Places the cosmetics (art from the asset base) on the card by its anchors. */
const finish = async (
  base: string,
  card: CardJson,
  drawings: Record<string, THREE.Texture>,
  cosmetics: readonly SceneCosmetic[],
  loadTexture: (url: string) => Promise<THREE.Texture>,
): Promise<ActorAssets> => {
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
