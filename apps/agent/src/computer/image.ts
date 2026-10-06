import { deflateSync } from "node:zlib";
import { SCREENSHOT_MAX } from "./tools.js";

/** The size a `w`×`h` capture is shown at: fits in `max`, aspect kept, never upscaled. */
export const fitSize = (w: number, h: number, max: { width: number; height: number } = SCREENSHOT_MAX) => {
  const s = Math.min(1, max.width / w, max.height / h);
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
};

/**
 * Area-average downscale of an RGBA buffer to RGB (alpha dropped: screens are opaque). Each
 * output pixel averages the source pixels its box covers, so text stays readable rather than
 * aliased as with nearest-neighbour.
 */
export const downscaleRgba = (
  src: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  order: "rgba" | "bgra" = "rgba",
): Buffer => {
  if (src.length < sw * sh * 4) throw new Error("capture buffer is smaller than its size");
  const out = Buffer.alloc(dw * dh * 3);
  const [ri, bi] = order === "rgba" ? [0, 2] : [2, 0];
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * sw + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += src[i + ri]!;
          g += src[i + 1]!;
          b += src[i + bi]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * dw + x) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return out;
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** A truecolour 8-bit PNG (filter 0 on every row) from tightly packed RGB. */
export const encodePngRgb = (rgb: Buffer, width: number, height: number): Buffer => {
  if (rgb.length !== width * height * 3) throw new Error("RGB buffer doesn't match its size");
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};
