import {
  DATA_SEGMENTS,
  FINDER_COLORS,
  FINDERS,
  PALETTE_HUES,
  RINGS,
  SEGMENTS,
  frameToSymbols,
  hslToRgb,
} from "./ring.js";

/** Minimal RGBA image, compatible with the browser's ImageData. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const BACKGROUND: [number, number, number] = [11, 11, 20];
const GAP_DEG = 0.8;

export interface RenderOptions {
  /** Rotation of the whole ring in degrees (the animation spins it). */
  rotationDeg?: number;
}

/**
 * Rasterises one frame. Apps draw the same geometry with canvas/three.js for the
 * animated version; this reference renderer is what tests and the decoder agree on.
 */
export const renderFrame = (frame: Uint8Array, size: number, opts: RenderOptions = {}): RgbaImage => {
  const symbols = frameToSymbols(frame);
  const segColor = new Map<string, [number, number, number]>();
  RINGS.forEach((_, ring) => {
    FINDERS.forEach((s, i) => segColor.set(`${ring}:${s}`, FINDER_COLORS[i] === "white" ? [255, 255, 255] : [0, 0, 0]));
    DATA_SEGMENTS.forEach((s, i) => {
      segColor.set(`${ring}:${s}`, hslToRgb(PALETTE_HUES[symbols[ring * DATA_SEGMENTS.length + i]!]!, 0.9, 0.55));
    });
  });

  const data = new Uint8ClampedArray(size * size * 4);
  const c = (size - 1) / 2;
  const segDeg = 360 / SEGMENTS;
  const rot = opts.rotationDeg ?? 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      const r = Math.hypot(dx, dy) / size;
      let color = BACKGROUND;
      const ring = RINGS.findIndex((g) => r >= g.inner && r <= g.outer);
      if (ring >= 0) {
        // 0° at 12 o'clock, clockwise.
        let a = (Math.atan2(dx, -dy) * 180) / Math.PI - rot;
        a = ((a % 360) + 360) % 360;
        const seg = Math.floor(a / segDeg);
        const within = a - seg * segDeg;
        if (within > GAP_DEG / 2 && within < segDeg - GAP_DEG / 2) color = segColor.get(`${ring}:${seg}`)!;
      }
      const o = (y * size + x) * 4;
      data[o] = color[0];
      data[o + 1] = color[1];
      data[o + 2] = color[2];
      data[o + 3] = 255;
    }
  }
  return { width: size, height: size, data };
};
