import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { SkinEffect } from "@chalito/protocol";
import { createCardAvatar } from "../src/card.js";
import { SKIN_IDS, createSkinMaterial, isSkinId, type SkinMaterial } from "../src/skin.js";

const card = () => {
  const drawings = { neutral: new THREE.Texture(), happy: new THREE.Texture() };
  const item = { placed: { left: 0.3, top: 0, width: 0.4, height: 0.2, z: 1 }, texture: new THREE.Texture() };
  const avatar = createCardAvatar({ width: 600, height: 800 }, drawings, [item]);
  const body = avatar.root.getObjectByName("body") as THREE.Mesh;
  return { avatar, drawings, body, item: avatar.root.getObjectByName("item-0") as THREE.Mesh };
};

describe("card skins", () => {
  it("has a shader variant for every skin the catalog can sell", () => {
    expect([...SKIN_IDS].sort()).toEqual([...SkinEffect.options].sort());
    const variants = SKIN_IDS.map((s) => createSkinMaterial(s, null, 1).defines.SKIN as number);
    expect(new Set(variants).size).toBe(SKIN_IDS.length);
    expect(isSkinId("gold")).toBe(true);
    expect(isSkinId("__proto__")).toBe(false);
    expect(isSkinId(null)).toBe(false);
  });

  it("swaps the body's material for the skin's (items untouched) and back to the plain drawing", () => {
    const { avatar, drawings, body, item } = card();
    const plain = body.material;
    const itemMat = item.material;
    avatar.setSkin("galaxy");
    expect(avatar.skin).toBe("galaxy");
    const m = body.material as SkinMaterial;
    expect(m).toBeInstanceOf(THREE.ShaderMaterial);
    expect(m.transparent).toBe(true);
    expect(m.uniforms.map.value).toBe(drawings.neutral);
    expect(m.uniforms.uAspect.value).toBeCloseTo(800 / 600);
    expect(item.material).toBe(itemMat);
    avatar.setSkin(null);
    expect(avatar.skin).toBeNull();
    expect(body.material).toBe(plain);
  });

  it("keeps the skin across emotion drawing swaps", () => {
    const { avatar, drawings, body } = card();
    avatar.setSkin("gold");
    avatar.setDrawing("happy");
    expect(avatar.skin).toBe("gold");
    expect((body.material as SkinMaterial).uniforms.map.value).toBe(drawings.happy);
    // A skin put on after a swap starts from the current drawing; taking it off shows it too.
    avatar.setSkin("neon");
    expect((body.material as SkinMaterial).uniforms.map.value).toBe(drawings.happy);
    avatar.setSkin(null);
    expect((body.material as THREE.MeshBasicMaterial).map).toBe(drawings.happy);
  });

  it("animates from tick and keeps the clock when the skin changes", () => {
    const { avatar, body } = card();
    avatar.tick(3); // no skin: nothing to animate, no error
    avatar.setSkin("holo");
    avatar.tick(12.5);
    expect((body.material as SkinMaterial).uniforms.uTime.value).toBe(12.5);
    avatar.setSkin("crystal");
    expect((body.material as SkinMaterial).uniforms.uTime.value).toBe(12.5);
    // Epoch seconds wrap to what a float32 uniform holds precisely.
    avatar.tick(1_760_000_016.25);
    expect((body.material as SkinMaterial).uniforms.uTime.value).toBeCloseTo(1_760_000_016.25 % 3600, 6);
  });

  it("ignores unknown ids (an old client, a bad row) and disposes the skin's material", () => {
    const { avatar, body } = card();
    avatar.setSkin("lava" as never);
    expect(avatar.skin).toBeNull();
    avatar.setSkin("shadow");
    const m = body.material as SkinMaterial;
    let disposed = 0;
    m.addEventListener("dispose", () => disposed++);
    avatar.setSkin("pixel");
    expect(disposed).toBe(1);
    const p = body.material as SkinMaterial;
    let disposed2 = 0;
    p.addEventListener("dispose", () => disposed2++);
    avatar.dispose();
    expect(disposed2).toBe(1);
  });
});
