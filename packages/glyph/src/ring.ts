import { FRAME_BYTES } from "./frames.js";

/**
 * Ring geometry. Two concentric rings of 48 segments around the companion's silhouette.
 * Segments 0, 12, 24, 36 of each ring are finders (white, white, black, black), which
 * give orientation; the other 44 per ring carry 3 bits each as one of 8 hues.
 * 2 rings × 44 × 3 bits = 264 bits = one 33-byte frame.
 */
export const SEGMENTS = 48;
export const FINDERS = [0, 12, 24, 36] as const;
export const FINDER_COLORS = ["white", "white", "black", "black"] as const;
export const RINGS = [
  { inner: 0.41, outer: 0.48 },
  { inner: 0.32, outer: 0.39 },
] as const;

/** 8 saturated hues, 45° apart. */
export const PALETTE_HUES = [0, 45, 90, 135, 180, 225, 270, 315] as const;

const isFinder = (s: number) => (FINDERS as readonly number[]).includes(s);
export const DATA_SEGMENTS = Array.from({ length: SEGMENTS }, (_, i) => i).filter((s) => !isFinder(s));

export const frameToSymbols = (frame: Uint8Array): number[] => {
  if (frame.length !== FRAME_BYTES) throw new Error("glyph: bad frame length");
  const symbols: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const byte of frame) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 3) {
      bits -= 3;
      symbols.push((acc >> bits) & 7);
    }
    acc &= (1 << bits) - 1;
  }
  return symbols; // 264 bits / 3 = 88 symbols, no remainder
};

export const symbolsToFrame = (symbols: number[]): Uint8Array => {
  const out = new Uint8Array(FRAME_BYTES);
  let acc = 0;
  let bits = 0;
  let i = 0;
  for (const s of symbols) {
    acc = (acc << 3) | (s & 7);
    bits += 3;
    if (bits >= 8) {
      bits -= 8;
      out[i++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  return out;
};

export const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
};

export const rgbToHue = (r: number, g: number, b: number): { hue: number; sat: number; lum: number } => {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  const lum = (max + min) / 2;
  if (d === 0) return { hue: 0, sat: 0, lum };
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { hue: h, sat: d / (1 - Math.abs(2 * lum - 1) || 1), lum };
};
