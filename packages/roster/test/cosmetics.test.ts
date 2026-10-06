import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "@chalito/config";
import { describe, expect, it } from "vitest";
import { ROSTER_IDS, VRM_BONE, placeOnCard, type CardAnchor } from "../src/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const catalog = loadCatalog();
const card = (id: string) =>
  JSON.parse(readFileSync(`${root}assets/${id}/card.json`, "utf8")) as {
    width: number;
    height: number;
    anchors: Record<string, CardAnchor>;
  };

describe("cosmetics on image cards", () => {
  it("every catalog item has its art in the roster package", () => {
    for (const [id, c] of Object.entries(catalog.cosmetics)) {
      expect(c.art).toBe(`cosmetics/${id}.webp`);
      expect(existsSync(`${root}${c.art}`)).toBe(true);
    }
  });

  it("a hat's brim lands on every built preset's head anchor, centred, drawn in front", () => {
    const hat = catalog.cosmetics.viking_hat!;
    for (const id of ROSTER_IDS.filter((i) => existsSync(`${root}assets/${i}/card.json`))) {
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

  it("back, aura and portal items go behind the body; face items in front", () => {
    const c = card("bruno");
    for (const [, item] of Object.entries(catalog.cosmetics)) {
      const z = placeOnCard(c.anchors[item.slot]!, item.card, 1, c.height / c.width).z;
      if (["back", "aura", "portal_fx"].includes(item.slot)) expect(z).toBeLessThan(0);
      else expect(z).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("cosmetics on VRMs (M7's renderer)", () => {
  it("head and face items attach to the head bone; portals sit on the ground", () => {
    expect(VRM_BONE.head).toBe("head");
    expect(VRM_BONE.face).toBe("head");
    expect(VRM_BONE.portal_fx).toBeNull();
    for (const item of Object.values(catalog.cosmetics)) expect(item.slot in VRM_BONE).toBe(true);
  });
});
