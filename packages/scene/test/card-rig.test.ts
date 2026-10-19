import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createCardAvatar, RIG_REST } from "@chalito/avatar-three";
import { loadCardAssets, type SceneCosmetic } from "../src/index.js";
import { CARD, fakeTexture } from "./fakes.js";

const RIG = {
  v: 1,
  parts: [
    { id: "body", src: "rig-body.webp", pivot: [0.5, 0.97], z: 0 },
    { id: "armL", src: "rig-arm-l.webp", pivot: [0.3, 0.55], z: 1 },
    { id: "armR", src: "rig-arm-r.webp", pivot: [0.62, 0.55], z: 1 },
    { id: "head", src: { neutral: "rig-head-neutral.webp", happy: "rig-head-happy.webp" }, pivot: [0.5, 0.48], z: 2 },
    { id: "lids", src: "rig-lids.webp", parent: "head", pivot: [0.5, 0.48], z: 3, only: ["neutral"] },
    { id: "mouth", src: "rig-mouth.webp", parent: "head", pivot: [0.43, 0.42], z: 3, only: ["neutral"] },
  ],
};
const HAT: SceneCosmetic = { slot: "head", art: "cosmetics/top_hat.webp", card: { width: 0.5, pivot: [0.5, 1] } };
const anchors = { head: { x: 0.5, y: 0.14, z: 1 }, body: { x: 0.5, y: 0.62, z: 1 } };

const loaded: string[] = [];
const load = (card: unknown, wear: SceneCosmetic[] = [], fail?: string) =>
  loadCardAssets("/roster/", "chalito", wear, {
    fetchJson: async () => card,
    loadTexture: async (u) => {
      if (fail && u.endsWith(fail)) throw new Error("404");
      loaded.push(u);
      return fakeTexture(u);
    },
  });

describe("cutout rig (arms, head, eyelids, mouth)", () => {
  it("loads every part image once; a card without a rig loads none", async () => {
    loaded.length = 0;
    const a = await load({ ...CARD, rig: RIG });
    expect(a.rig?.spec.parts).toHaveLength(6);
    expect(Object.keys(a.rig!.textures).sort()).toEqual(
      [
        "rig-arm-l.webp",
        "rig-arm-r.webp",
        "rig-body.webp",
        "rig-head-happy.webp",
        "rig-head-neutral.webp",
        "rig-lids.webp",
        "rig-mouth.webp",
      ].sort(),
    );
    expect(loaded.filter((u) => u.includes("/rig-")).every((u) => u.startsWith("/roster/assets/chalito/"))).toBe(true);
    expect((await load(CARD)).rig).toBeNull();
  });

  it("a part that won't load, or a malformed rig, means no rig (the card moves as one piece)", async () => {
    expect((await load({ ...CARD, rig: RIG }, [], "rig-lids.webp")).rig).toBeNull();
    expect((await load({ ...CARD, rig: { ...RIG, v: 9 } })).rig).toBeNull();
  });

  it("hats ride on the head", async () => {
    const a = await load({ ...CARD, anchors, rig: RIG }, [HAT]);
    expect(a.items[0]!.part).toBe("head");
  });

  it("draws the parts instead of the flat drawing, turns them, and swaps the head with the face", async () => {
    const a = await load({ ...CARD, anchors, rig: RIG }, [HAT]);
    const card = createCardAvatar(a.spec, a.drawings, a.items, 1, a.rig);
    expect(card.rigged).toBe(true);
    const by = (n: string) => card.root.getObjectByName(n)!;
    expect(by("body").visible).toBe(false);
    card.applyRig({ armL: 90, armR: 120, head: 5, headDrop: 0.01, lids: 1, mouth: 0.6 });
    expect(by("rig-armL").rotation.z).toBeCloseTo(-Math.PI / 2, 6);
    expect(by("rig-armR").rotation.z).toBeCloseTo((120 * Math.PI) / 180, 6);
    expect(by("rig-head").rotation.z).toBeCloseTo((5 * Math.PI) / 180, 6);
    expect(by("rig-lids").visible).toBe(true);
    expect(by("rig-mouth").visible).toBe(true);
    // The hat is inside the head's group, so it turns with it.
    expect(by("item-0").parent).toBe(by("rig-head"));
    // The eyelids belong to the neutral face only.
    card.setDrawing("happy");
    expect(by("rig-lids-image").visible).toBe(false);
    expect((by("rig-head-image") as unknown as { material: { map: { name: string } } }).material.map.name).toContain(
      "rig-head-happy",
    );
    card.applyRig(RIG_REST);
    expect(by("rig-mouth").visible).toBe(false);
  });

  it("a skin draws the flat card (skins shade one drawing) and puts the parts back at rest", async () => {
    const a = await load({ ...CARD, anchors, rig: RIG }, [HAT]);
    const card = createCardAvatar(a.spec, a.drawings, a.items, 1, a.rig);
    card.applyRig({ armL: 90, armR: 120, head: 5, headDrop: 0.01, lids: 0, mouth: 0 });
    card.setSkin("gold");
    expect(card.rigged).toBe(false);
    expect(card.root.getObjectByName("body")!.visible).toBe(true);
    expect(card.root.getObjectByName("rig-head")!.rotation.z).toBe(0);
    card.applyRig({ armL: 90, armR: 120, head: 5, headDrop: 0.01, lids: 0, mouth: 0 });
    expect(card.root.getObjectByName("rig-head")!.rotation.z).toBe(0);
    card.setSkin(null);
    expect(card.rigged).toBe(true);
  });

  it("the shipped Chalito card has a rig that parses", () => {
    const card = JSON.parse(readFileSync(new URL("../../roster/assets/chalito/card.json", import.meta.url), "utf8"));
    expect(card.rig.parts.map((p: { id: string }) => p.id).sort()).toEqual(
      ["armL", "armR", "body", "head", "lids", "mouth"].sort(),
    );
  });
});
