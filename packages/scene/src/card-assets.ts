import * as THREE from "three";
import { parseRig, rigFiles, type CardItem, type CardRig, type CardSpec } from "@chalito/avatar-three";
import { anchorFor, placeOnCard, type CardAnchors } from "@chalito/roster";
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
  anchors?: CardAnchors;
  rig?: unknown;
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
    const load = (src: string) => retry(() => loadTexture(fileUrl(src)));
    const [textures, rig] = await Promise.all([loadDrawings(card, load), loadRig(card, load)]);
    return finish(base, card, textures, cosmetics, loadTexture, rig);
  }
  if (!/^[a-z0-9_-]+$/.test(avatar)) throw new Error("bad avatar id");
  const dir = `${base}assets/${avatar}/`;
  const card = (await fetchJson(`${dir}card.json`)) as CardJson;
  const load = (src: string) => loadTexture(dir + src);
  const [drawings, rig] = await Promise.all([loadDrawings(card, load), loadRig(card, load)]);
  return finish(base, card, drawings, cosmetics, loadTexture, rig);
};

/**
 * The card's cutout rig with its part images, or null: no rig, a malformed one, or any part that
 * won't load (the card then moves as one piece rather than with a part missing).
 */
const loadRig = async (card: CardJson, load: (src: string) => Promise<THREE.Texture>): Promise<CardRig | null> => {
  const spec = parseRig(card.rig);
  if (!spec) return null;
  try {
    const files = rigFiles(spec);
    const textures = await Promise.all(files.map((f) => load(f)));
    return { spec, textures: Object.fromEntries(files.map((f, i) => [f, textures[i]!])) };
  } catch {
    return null;
  }
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

/** Places the cosmetics (art from the asset base) on the card by its anchors (roster `placeItem`). */
const finish = async (
  base: string,
  card: CardJson,
  drawings: Record<string, THREE.Texture>,
  cosmetics: readonly SceneCosmetic[],
  loadTexture: (url: string) => Promise<THREE.Texture>,
  rig: CardRig | null = null,
): Promise<ActorAssets> => {
  const items: CardItem[] = [];
  let skin: ActorAssets["skin"] = null;
  for (const c of cosmetics) {
    if (isSceneSkin(c)) {
      // One skin per card (the slot holds one); an unknown effect draws the plain card.
      if (isSkinId(c.skin)) skin = c.skin;
      continue;
    }
    // A neck item lands on the card's neck (detected, or derived from face and body); a cape that
    // hangs from the neck at the neck's height, behind the body.
    const anchor = anchorFor(card.anchors, c.slot, c.card);
    if (!anchor || !/^cosmetics\/[a-z0-9_]+\.webp$/.test(c.art)) continue;
    const texture = await loadTexture(base + c.art);
    const img = texture.image as { width?: number; height?: number } | undefined;
    const aspect = img?.width && img.height ? img.height / img.width : 1;
    const placed = placeOnCard(anchor, c.card, aspect, card.height / card.width);
    // Hats and glasses ride on a rigged head.
    items.push(c.slot === "head" || c.slot === "face" ? { placed, texture, part: "head" } : { placed, texture });
  }
  return { spec: { width: card.width, height: card.height, shadow: card.shadow }, drawings, items, skin, rig };
};
