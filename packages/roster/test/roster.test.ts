import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EmotionTag } from "@chalito/protocol";
import { DEFAULT_COMPANION, DRAWINGS, EMOTION_DRAWING, ICONS, ROSTER, ROSTER_IDS } from "../src/index.js";

const file = (p: string) => new URL(`../${p}`, import.meta.url);

describe("free roster", () => {
  it("has six companions, Chalito preselected, every asset on disk", () => {
    expect(ROSTER.map((r) => r.id)).toEqual([...ROSTER_IDS]);
    expect(DEFAULT_COMPANION).toBe("chalito");
    for (const r of ROSTER) {
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
