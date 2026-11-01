import * as THREE from "three";
import { createSkinMaterial, type SkinId } from "@chalito/avatar-three";
import type { Rgba } from "./pillow.js";

let renderer: THREE.WebGLRenderer | null = null;

/** Rows bottom-up, the way GL addresses textures and the framebuffer. */
const flipRows = (data: Uint8Array, w: number, h: number) => {
  const out = new Uint8Array(data.length);
  const row = w * 4;
  for (let y = 0; y < h; y++) out.set(data.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
  return out;
};

/** The frame drawn through the pet's own skin shader (avatar-three skin.ts) at time 0, so the
 * board shows the colours the desktop pet wears. */
export const bakeSkin = (im: Rgba, skin: SkinId, aspect: number): Rgba => {
  const { width: w, height: h } = im;
  renderer ??= new THREE.WebGLRenderer({
    canvas: document.createElement("canvas"),
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    antialias: false,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  renderer.setClearColor(0x000000, 0);
  const tex = new THREE.DataTexture(flipRows(im.data, w, h), w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const mat = createSkinMaterial(skin, tex, aspect);
  // The fragment as computed, straight alpha, nothing blended under it.
  mat.blending = THREE.NoBlending;
  const geo = new THREE.PlaneGeometry(2, 2);
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geo, mat));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2);
  camera.position.z = 1;
  try {
    renderer.render(scene, camera);
    const gl = renderer.getContext();
    const out = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return { width: w, height: h, data: flipRows(out, w, h) };
  } finally {
    tex.dispose();
    mat.dispose();
    geo.dispose();
  }
};
