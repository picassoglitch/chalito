import type { AccessorySlot, CosmeticSlot } from "@chalito/protocol";

/**
 * Where an item sits on a 2.5D card, from catalog.yaml `card`. Two shapes:
 *  - a card-sized item (head, face, back, aura, portal): `width` is a fraction of the card's width;
 *    a back item may hang from the neck instead (`anchorY: "neck"`: a cape's collar at the neck's
 *    height, still drawn behind the body at the back anchor's x);
 *  - a neck item: `neckWidth` is a fraction of the character's own neck width (anchors.neck.w), so
 *    a bow tie fits a chibi kid and a robot alike.
 */
export type CardPlacement = CardWidthPlacement | NeckPlacement;

export interface CardWidthPlacement {
  /** Item width as a fraction of the card's width. */
  width: number;
  /** The item's own pivot, in its image (0..1): a hat's brim, glasses' bridge, a cape's collar. */
  pivot: [number, number];
  /** Back items only: take the anchor's height from the neck (a cape hangs from it). */
  anchorY?: "neck";
}

export interface NeckPlacement {
  /** Item width as a fraction of the neck anchor's width (`w`). */
  neckWidth: number;
  /** The item's own pivot, in its image (0..1): a bow tie's knot, a medal ribbon's top. */
  pivot: [number, number];
}

export const isNeckPlacement = (p: CardPlacement): p is NeckPlacement => "neckWidth" in p;

export interface CardAnchor {
  x: number;
  y: number;
  z: number;
  /** The neck anchor only: neck width as a fraction of the card's width (detect-wear-anchors.ts). */
  w?: number;
}

/** A card's anchors by slot (card.json `anchors`); `neck` may be missing (see `neckAnchor`). */
export type CardAnchors = Partial<Record<AccessorySlot, CardAnchor>>;

/** A placed item in card space (0..1 of the card's width and height). */
export interface Placed {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Draw order relative to the body (body = 0): negative behind, positive in front. */
  z: number;
}

/** The neck width assumed when a card has no detected neck (an upload, a not-yet-detected card). */
export const FALLBACK_NECK_WIDTH = 0.3;
/** Neck pieces draw in front of the body, like face items. */
export const NECK_Z = 2;

const neckWidthOf = (a: CardAnchor) => (a.w !== undefined && a.w > 0 ? a.w : FALLBACK_NECK_WIDTH);

/**
 * The card's neck anchor: the detected one (card.json anchors.neck), else derived from the face and
 * body anchors (under the face, halfway down to the body, a typical width), so uploads and cards
 * the detector hasn't reached still wear neck pieces. Null when the card has neither.
 */
export const neckAnchor = (anchors: CardAnchors | undefined): CardAnchor | null => {
  const n = anchors?.neck;
  if (n) return { x: n.x, y: n.y, z: n.z, w: neckWidthOf(n) };
  const face = anchors?.face;
  const body = anchors?.body;
  if (!face || !body) return null;
  return { x: face.x, y: (face.y + body.y) / 2, z: NECK_Z, w: FALLBACK_NECK_WIDTH };
};

/**
 * Puts an item on a card: its pivot lands on the anchor. `itemAspect` is the item image's height ÷
 * width; `cardAspect` the card's height ÷ width. A neck placement is sized by the anchor's `w`.
 */
export const placeOnCard = (anchor: CardAnchor, p: CardPlacement, itemAspect: number, cardAspect: number): Placed => {
  const width = isNeckPlacement(p) ? p.neckWidth * neckWidthOf(anchor) : p.width;
  const height = (width * itemAspect) / cardAspect;
  return {
    left: anchor.x - p.pivot[0] * width,
    top: anchor.y - p.pivot[1] * height,
    width,
    height,
    z: anchor.z,
  };
};

/**
 * The anchor an item of `slot` with placement `p` lands on, from the card's anchors: the neck slot
 * uses `neckAnchor` (detected or derived); a back item with `anchorY: "neck"` the back anchor moved
 * to the neck's height (still behind the body). Null when the card has no anchor for it (the item
 * isn't drawn).
 */
export const anchorFor = (
  anchors: CardAnchors | undefined,
  slot: AccessorySlot,
  p: CardPlacement,
): CardAnchor | null => {
  if (slot === "neck") return neckAnchor(anchors);
  const a = anchors?.[slot];
  if (!a) return null;
  if (!isNeckPlacement(p) && p.anchorY === "neck") {
    const neck = neckAnchor(anchors);
    if (neck) return { x: a.x, y: neck.y, z: a.z };
  }
  return { x: a.x, y: a.y, z: a.z };
};

/** `anchorFor`, then `placeOnCard`: where every renderer (room, pet, store preview) draws an item. */
export const placeItem = (
  anchors: CardAnchors | undefined,
  slot: AccessorySlot,
  p: CardPlacement,
  itemAspect: number,
  cardAspect: number,
): Placed | null => {
  const a = anchorFor(anchors, slot, p);
  return a ? placeOnCard(a, p, itemAspect, cardAspect) : null;
};

/**
 * VRM humanoid bones each slot attaches to (M7's three-vrm renderer); portal_fx sits on the ground
 * and a skin isn't attached anywhere (it is a material over the whole companion).
 */
export const VRM_BONE: Record<CosmeticSlot, "head" | "neck" | "chest" | "upperChest" | "hips" | null> = {
  head: "head",
  face: "head",
  neck: "neck",
  body: "chest",
  back: "upperChest",
  aura: "hips",
  portal_fx: null,
  skin: null,
};
