import type { RgbaImage } from "./render.js";
import { DATA_SEGMENTS, FINDERS, PALETTE_HUES, RINGS, SEGMENTS, rgbToHue, symbolsToFrame } from "./ring.js";

const sampleAt = (img: RgbaImage, ring: number, segCenterDeg: number): [number, number, number] => {
  const size = Math.min(img.width, img.height);
  const cx = (img.width - 1) / 2;
  const cy = (img.height - 1) / 2;
  const g = RINGS[ring]!;
  const rMid = ((g.inner + g.outer) / 2) * size;
  const rad = (segCenterDeg * Math.PI) / 180;
  const px = cx + Math.sin(rad) * rMid;
  const py = cy - Math.cos(rad) * rMid;
  const half = Math.max(1, Math.floor(size * 0.008));
  let r = 0;
  let gg = 0;
  let b = 0;
  let n = 0;
  for (let y = Math.round(py) - half; y <= Math.round(py) + half; y++) {
    for (let x = Math.round(px) - half; x <= Math.round(px) + half; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const o = (y * img.width + x) * 4;
      r += img.data[o]!;
      gg += img.data[o + 1]!;
      b += img.data[o + 2]!;
      n++;
    }
  }
  return [r / n, gg / n, b / n];
};

const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Finds the ring rotation from the finder pattern (white, white, black, black). */
export const findRotation = (img: RgbaImage): number => {
  const segDeg = 360 / SEGMENTS;
  let best = 0;
  let bestScore = -Infinity;
  for (let rot = 0; rot < 360; rot += 0.5) {
    let score = 0;
    for (let ring = 0; ring < RINGS.length; ring++) {
      const l = FINDERS.map((s) => luminance(sampleAt(img, ring, rot + (s + 0.5) * segDeg)));
      score += l[0]! + l[1]! - l[2]! - l[3]!;
    }
    if (score > bestScore) {
      bestScore = score;
      best = rot;
    }
  }
  return best;
};

/**
 * Reads one frame from a square-ish image where the ring is centred and fills the
 * frame (the app's viewfinder guides the user). Returns the raw 33 bytes; callers
 * check the CRC via FrameAssembler.
 */
export const sampleFrame = (img: RgbaImage): Uint8Array => {
  const rot = findRotation(img);
  const segDeg = 360 / SEGMENTS;
  const symbols: number[] = [];
  for (let ring = 0; ring < RINGS.length; ring++) {
    for (const s of DATA_SEGMENTS) {
      const [r, g, b] = sampleAt(img, ring, rot + (s + 0.5) * segDeg);
      const { hue } = rgbToHue(r, g, b);
      let bestIdx = 0;
      let bestDist = Infinity;
      PALETTE_HUES.forEach((h, i) => {
        const d = Math.min(Math.abs(hue - h), 360 - Math.abs(hue - h));
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      });
      symbols.push(bestIdx);
    }
  }
  return symbolsToFrame(symbols);
};
