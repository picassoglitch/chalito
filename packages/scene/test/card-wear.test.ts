import { describe, expect, it } from "vitest";
import { loadCardAssets, type SceneCosmetic } from "../src/index.js";
import { CARD, fakeTexture } from "./fakes.js";

const BOW: SceneCosmetic = { slot: "neck", art: "cosmetics/bow_tie.webp", card: { neckWidth: 0.8, pivot: [0.5, 0.5] } };
const CAPE: SceneCosmetic = {
  slot: "back",
  art: "cosmetics/hero_cape.webp",
  card: { width: 0.85, pivot: [0.5, 0.04], anchorY: "neck" },
};
const WINGS: SceneCosmetic = {
  slot: "back",
  art: "cosmetics/angel_wings.webp",
  card: { width: 1.25, pivot: [0.5, 0.5] },
};
const anchors = {
  face: { x: 0.5, y: 0.32, z: 2 },
  body: { x: 0.5, y: 0.62, z: 1 },
  back: { x: 0.5, y: 0.55, z: -1 },
};
const load = (card: unknown, wear: SceneCosmetic[]) =>
  loadCardAssets("/roster/", "bruno", wear, { fetchJson: async () => card, loadTexture: async (u) => fakeTexture(u) });

describe("wearables on a card (room, desktop pet)", () => {
  it("a neck piece sits on the detected neck, sized by its width, in front of the body", async () => {
    const card = { ...CARD, anchors: { ...anchors, neck: { x: 0.45, y: 0.5, z: 2, w: 0.2 } } };
    const [bow] = (await load(card, [BOW])).items;
    expect(bow!.placed.width).toBeCloseTo(0.16, 9);
    expect(bow!.placed.left + bow!.placed.width / 2).toBeCloseTo(0.45, 9);
    expect(bow!.placed.top + bow!.placed.height / 2).toBeCloseTo(0.5, 9);
    expect(bow!.placed.z).toBeGreaterThan(0);
  });

  it("a card without a detected neck (an upload) derives one; a card with no face or body draws none", async () => {
    const [bow] = (await load({ ...CARD, anchors }, [BOW])).items;
    expect(bow!.placed.top + bow!.placed.height / 2).toBeCloseTo(0.47, 9);
    expect(bow!.placed.width).toBeCloseTo(0.8 * 0.3, 9);
    expect((await load(CARD, [BOW])).items).toEqual([]);
  });

  it("a cape hangs from the neck behind the body; wings sit at the back anchor, behind", async () => {
    const card = { ...CARD, anchors: { ...anchors, neck: { x: 0.45, y: 0.4, z: 2, w: 0.2 } } };
    const [cape, wings] = (await load(card, [CAPE, WINGS])).items;
    expect(cape!.placed.top + 0.04 * cape!.placed.height).toBeCloseTo(0.4, 9);
    expect(cape!.placed.z).toBeLessThan(0);
    expect(wings!.placed.width).toBeCloseTo(1.25, 9);
    expect(wings!.placed.top + wings!.placed.height / 2).toBeCloseTo(0.55, 9);
    expect(wings!.placed.z).toBeLessThan(0);
  });
});
