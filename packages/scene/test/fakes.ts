import * as THREE from "three";
import type { RoomSceneOptions, SceneRenderer } from "../src/index.js";

export const CARD = {
  width: 566,
  height: 952,
  layers: [{ src: "layer-neutral.webp" }],
  emotions: { src: { neutral: "n.webp", happy: "h.webp", sad: "s.webp", surprised: "u.webp", tired: "t.webp" } },
  shadow: { x: 0.5, y: 0.97, rx: 0.32, ry: 0.035, opacity: 0.25 },
  anchors: { head: { x: 0.47, y: 0.14, z: 1 } },
};

export const fakeTexture = (url: string) => {
  const t = new THREE.Texture();
  t.name = url;
  t.image = { width: 100, height: 60 };
  return t;
};

export interface FakeCanvas {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  listeners: string[];
  addEventListener(type: string): void;
  removeEventListener(): void;
}

export const fakeCanvas = (): FakeCanvas => ({
  width: 400,
  height: 300,
  clientWidth: 400,
  clientHeight: 300,
  listeners: [],
  addEventListener(type: string) {
    this.listeners.push(type);
  },
  removeEventListener() {},
});

export const fakeRenderer = (rendererName = "ANGLE (NVIDIA)") => {
  const calls = { render: 0 };
  const r: SceneRenderer = {
    setPixelRatio() {},
    setSize() {},
    setClearColor() {},
    render() {
      calls.render++;
    },
    dispose() {},
    getContext: () =>
      ({
        RENDERER: 0x1f01,
        getExtension: () => null,
        getParameter: () => rendererName,
      }) as unknown as WebGL2RenderingContext,
    shadowMap: { enabled: false },
    outputColorSpace: "",
  };
  return { r, calls };
};

/** A loop host that never schedules frames (tests drive renderAt themselves). */
export const idleHost = {
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
  hidden: () => false,
  onVisibilityChange: () => () => undefined,
};

export const sceneOpts = (over: Partial<RoomSceneOptions> = {}): RoomSceneOptions => {
  const canvas = fakeCanvas();
  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    roomId: "room_fam1",
    assetBase: "/roster/",
    quality: "medio",
    createRenderer: () => fakeRenderer().r,
    loadTexture: async (u) => fakeTexture(u),
    fetchJson: async () => CARD,
    loopHost: idleHost,
    ...over,
  };
};
