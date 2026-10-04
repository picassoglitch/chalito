import type { CosmeticSlot } from "@chalito/protocol";

/** Where an item sits on a 2.5D card, from catalog.yaml `card`. */
export interface CardPlacement {
  /** Item width as a fraction of the card's width. */
  width: number;
  /** The item's own pivot, in its image (0..1): a hat's brim, glasses' bridge, a cape's collar. */
  pivot: [number, number];
}

export interface CardAnchor {
  x: number;
  y: number;
  z: number;
}

/** A placed item in card space (0..1 of the card's width and height). */
export interface Placed {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Draw order relative to the body (body = 0): negative behind, positive in front. */
  z: number;
}

/**
 * Puts an item on a card: its pivot lands on the slot's anchor. `itemAspect` is the item image's
 * height ÷ width; `cardAspect` the card's height ÷ width.
 */
export const placeOnCard = (anchor: CardAnchor, p: CardPlacement, itemAspect: number, cardAspect: number): Placed => {
  const width = p.width;
  const height = (p.width * itemAspect) / cardAspect;
  return {
    left: anchor.x - p.pivot[0] * width,
    top: anchor.y - p.pivot[1] * height,
    width,
    height,
    z: anchor.z,
  };
};

/** VRM humanoid bones each slot attaches to (M7's three-vrm renderer); portal_fx sits on the ground. */
export const VRM_BONE: Record<CosmeticSlot, "head" | "chest" | "upperChest" | "hips" | null> = {
  head: "head",
  face: "head",
  body: "chest",
  back: "upperChest",
  aura: "hips",
  portal_fx: null,
};
