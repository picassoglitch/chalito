import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "@chalito/config";
import { describe, expect, it } from "vitest";
import {
  FALLBACK_NECK_WIDTH,
  ROSTER_IDS,
  VRM_BONE,
  anchorFor,
  neckAnchor,
  placeItem,
  placeOnCard,
  type CardAnchor,
  type CardAnchors,
} from "../src/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const catalog = loadCatalog();
/** The drawn items (skins are a shader effect: no art, no placement). */
const accessories = Object.entries(catalog.cosmetics).flatMap(([id, c]) =>
  c.slot === "skin" ? [] : [[id, c] as const],
);
const card = (id: string) =>
  JSON.parse(readFileSync(`${root}assets/${id}/card.json`, "utf8")) as {
    width: number;
    height: number;
    anchors: Record<string, CardAnchor>;
  };
const built = ROSTER_IDS.filter((i) => existsSync(`${root}assets/${i}/card.json`));

describe("cosmetics on image cards", () => {
  it("every catalog item's art is cosmetics/<id>.webp in the roster package (once built)", () => {
    for (const [id, c] of accessories) expect(c.art).toBe(`cosmetics/${id}.webp`);
    // The launch items ship their art; the wearables' art is built later (build-roster.ts).
    for (const id of ["viking_hat", "flower_crown", "round_glasses", "star_cape", "sparkle_aura", "portal_swirl"])
      expect(existsSync(`${root}cosmetics/${id}.webp`)).toBe(true);
  });

  it("a hat's brim lands on every built preset's head anchor, centred, drawn in front", () => {
    const hat = accessories.find(([id]) => id === "viking_hat")![1];
    for (const id of built) {
      const c = card(id);
      const a = c.anchors.head!;
      const placed = placeOnCard(a, hat.card, 1, c.height / c.width);
      // The pivot point is exactly on the anchor.
      expect(placed.left + hat.card.pivot[0] * placed.width).toBeCloseTo(a.x, 9);
      expect(placed.top + hat.card.pivot[1] * placed.height).toBeCloseTo(a.y, 9);
      // Mostly on the card, horizontally centred on the figure.
      expect(placed.left).toBeGreaterThan(-0.2);
      expect(placed.left + placed.width).toBeLessThan(1.2);
      expect(placed.z).toBeGreaterThanOrEqual(0);
    }
  });

  it("back, aura and portal items go behind the body; head, face and neck items in front", () => {
    for (const id of ["bruno", "luna"]) {
      const c = card(id);
      for (const [, item] of accessories) {
        const z = placeItem(c.anchors, item.slot, item.card, 1, c.height / c.width)!.z;
        if (["back", "aura", "portal_fx"].includes(item.slot)) expect(z).toBeLessThan(0);
        else expect(z).toBeGreaterThanOrEqual(0);
        if (item.slot === "neck") expect(z).toBeGreaterThan(0);
      }
    }
  });

  it("every item lands on every built card, its pivot on its anchor", () => {
    for (const id of built) {
      const c = card(id);
      for (const [itemId, item] of accessories) {
        const a = anchorFor(c.anchors, item.slot, item.card);
        expect(a, `${itemId} on ${id}`).not.toBeNull();
        const p = placeOnCard(a!, item.card, 1, c.height / c.width);
        expect(p.left + item.card.pivot[0] * p.width).toBeCloseTo(a!.x, 9);
        expect(p.top + item.card.pivot[1] * p.height).toBeCloseTo(a!.y, 9);
        expect(p.width).toBeGreaterThan(0);
      }
    }
  });
});

describe("neck pieces", () => {
  const anchors: CardAnchors = {
    face: { x: 0.48, y: 0.3, z: 2 },
    body: { x: 0.52, y: 0.6, z: 1 },
    back: { x: 0.52, y: 0.55, z: -1 },
  };
  const item = (id: string) => catalog.cosmetics[id]! as Extract<(typeof accessories)[number][1], { art: string }>;

  it("the six pilot characters carry a detected neck (point and width)", () => {
    for (const id of ["chalito", "bruno", "firulais", "robot", "axo", "sorpresa"]) {
      const n = card(id).anchors.neck!;
      expect(n.z).toBe(2);
      expect(n.w).toBeGreaterThan(0);
      expect(n.w).toBeLessThanOrEqual(1);
      expect(neckAnchor(card(id).anchors as CardAnchors)).toEqual(n);
    }
  });

  it("without a detected neck: under the face, halfway to the body, a typical width, in front", () => {
    const n = neckAnchor(anchors)!;
    expect(n).toMatchObject({ x: 0.48, z: 2, w: FALLBACK_NECK_WIDTH });
    expect(n.y).toBeCloseTo(0.45, 9);
    // A neck without a width gets the typical one; a card with no face or body has no neck.
    expect(neckAnchor({ neck: { x: 0.5, y: 0.4, z: 2 } })).toEqual({ x: 0.5, y: 0.4, z: 2, w: FALLBACK_NECK_WIDTH });
    expect(neckAnchor({ face: anchors.face })).toBeNull();
    expect(neckAnchor(undefined)).toBeNull();
    expect(placeItem({}, "neck", item("bow_tie").card, 1, 1)).toBeNull();
  });

  it("is sized by the neck's width, not the card's", () => {
    const narrow = { ...anchors, neck: { x: 0.5, y: 0.5, z: 2, w: 0.15 } };
    const wide = { ...anchors, neck: { x: 0.5, y: 0.5, z: 2, w: 0.35 } };
    const bow = item("bow_tie").card; // neckWidth 0.8, pivot [0.5, 0.5]
    const a = placeItem(narrow, "neck", bow, 0.5, 1.6)!;
    const b = placeItem(wide, "neck", bow, 0.5, 1.6)!;
    expect(a.width).toBeCloseTo(0.8 * 0.15, 9);
    expect(b.width).toBeCloseTo(0.8 * 0.35, 9);
    expect(a.height).toBeCloseTo((a.width * 0.5) / 1.6, 9);
    // Centred on the neck (its knot is the pivot).
    expect(a.left + a.width / 2).toBeCloseTo(0.5, 9);
    expect(a.top + a.height / 2).toBeCloseTo(0.5, 9);
    // A necktie hangs from its knot: its top just above the neck.
    const tie = placeItem(narrow, "neck", item("necktie").card, 2, 1.6)!;
    expect(tie.top).toBeCloseTo(0.5 - 0.05 * tie.height, 9);
  });

  it("a hero cape hangs from the neck's height, behind the body; wings sit at the back anchor", () => {
    const withNeck = { ...anchors, neck: { x: 0.5, y: 0.42, z: 2, w: 0.2 } };
    const cape = placeItem(withNeck, "back", item("hero_cape").card, 1.2, 1.6)!;
    expect(cape.top + 0.04 * cape.height).toBeCloseTo(0.42, 9);
    expect(cape.left + cape.width / 2).toBeCloseTo(0.52, 9); // the back anchor's x
    expect(cape.width).toBeCloseTo(0.85, 9);
    expect(cape.z).toBe(-1);
    // No detected neck: the derived one's height.
    expect(placeItem(anchors, "back", item("hero_cape").card, 1, 1)!.top).toBeCloseTo(0.45 - 0.04 * 0.85, 9);
    const wings = placeItem(withNeck, "back", item("angel_wings").card, 0.6, 1.6)!;
    expect(wings.width).toBeCloseTo(1.25, 9);
    expect(wings.top + wings.height / 2).toBeCloseTo(0.55, 9);
    expect(wings.z).toBe(-1);
  });
});

describe("cosmetics on VRMs (M7's renderer)", () => {
  it("head and face items attach to the head bone; portals sit on the ground", () => {
    expect(VRM_BONE.head).toBe("head");
    expect(VRM_BONE.face).toBe("head");
    expect(VRM_BONE.neck).toBe("neck");
    expect(VRM_BONE.portal_fx).toBeNull();
    expect(VRM_BONE.skin).toBeNull();
    for (const item of Object.values(catalog.cosmetics)) expect(item.slot in VRM_BONE).toBe(true);
  });
});
