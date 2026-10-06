import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EmotionTag } from "@chalito/protocol";
import {
  CATEGORIES,
  DEFAULT_COMPANION,
  DRAWINGS,
  EMOTION_DRAWING,
  ICONS,
  ORIGINAL_IDS,
  ROSTER,
  ROSTER_IDS,
  isRosterId,
  rosterByCategory,
  rosterEntry,
  searchRoster,
} from "../src/index.js";

const file = (p: string) => new URL(`../${p}`, import.meta.url);
/** Art is generated in batches: a character counts as built once its card is on disk. */
const built = ROSTER.filter((r) => existsSync(file(r.card)));

describe("free roster", () => {
  it("is the catalog: 11 categories × 20 companions, unique ids the database accepts", () => {
    expect(ROSTER).toHaveLength(220);
    expect(ROSTER.map((r) => r.id)).toEqual([...ROSTER_IDS]);
    expect(new Set(ROSTER_IDS).size).toBe(ROSTER_IDS.length);
    // chalito.companions.avatar CHECK (20261004001100_chalito_settings.sql) and loadCardAssets.
    for (const id of ROSTER_IDS) expect(id).toMatch(/^[a-z0-9_-]{1,64}$/);
    expect(CATEGORIES).toHaveLength(11);
    for (const g of rosterByCategory()) expect(g.entries, g.category).toHaveLength(20);
    for (const r of ROSTER) {
      expect(r.name.es && r.name.en && r.blurb.es && r.blurb.en, r.id).toBeTruthy();
      expect(rosterEntry(r.id)).toBe(r);
    }
  });

  it("keeps the six originals, Chalito among people and preselected", () => {
    expect(DEFAULT_COMPANION).toBe("chalito");
    expect(rosterEntry("chalito")?.category).toBe("people");
    for (const id of ["bruno", "luna", "tito", "canela", "nube"]) expect(rosterEntry(id)?.category).toBe("animals");
    for (const id of ORIGINAL_IDS) expect(isRosterId(id)).toBe(true);
    expect(isRosterId("Not An Id!")).toBe(false);
    expect(isRosterId(undefined)).toBe(false);
  });

  it("searches names in both languages, ignoring accents and case, within a category", () => {
    expect(searchRoster("").length).toBe(220);
    expect(searchRoster("", "food").every((r) => r.category === "food")).toBe(true);
    expect(searchRoster("CHALITO").map((r) => r.id)).toContain("chalito");
    expect(searchRoster("bambu").map((r) => r.id)).toContain("bambu"); // "Bambú"
    expect(searchRoster("chalito", "animals")).toEqual([]);
  });

  it("every built companion has its assets on disk (the six originals are always built)", () => {
    for (const id of ORIGINAL_IDS) expect(built.map((r) => r.id)).toContain(id);
    for (const r of built) {
      for (const p of [r.card, ...Object.values(r.drawings), r.thumbs[128], r.thumbs[256]])
        expect(existsSync(file(p)), p).toBe(true);
      const card = JSON.parse(readFileSync(file(r.card), "utf8"));
      expect(card).toMatchObject({ v: 1, kind: "card", emotions: { mode: "swap" } });
      expect(Object.keys(card.emotions.src).sort()).toEqual([...DRAWINGS].sort());
      for (const a of Object.values(card.anchors) as { x: number; y: number }[]) {
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.x).toBeLessThanOrEqual(1);
        expect(a.y).toBeGreaterThanOrEqual(0);
        expect(a.y).toBeLessThanOrEqual(1);
      }
      // A hat sits above a face, which sits above the body.
      expect(card.anchors.head.y).toBeLessThan(card.anchors.face.y);
      expect(card.anchors.face.y).toBeLessThan(card.anchors.body.y);
    }
    for (const p of Object.values(ICONS)) expect(existsSync(file(p)), p).toBe(true);
  });

  it("every emotion tag renders one of the five drawings (the image card renders all emotions)", () => {
    for (const tag of EmotionTag.options) expect(DRAWINGS).toContain(EMOTION_DRAWING[tag]);
  });
});
