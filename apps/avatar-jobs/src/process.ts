import sharp, { type Metadata } from "sharp";
import { looksExecutableOrMarkup, sniffImage, type ImageType } from "./sniff.js";

/** Upload limits (brief M8). Images only in this job; VRM/glTF validation is separate. */
export const LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  minSide: 256,
  maxSide: 4096,
  maxPixels: 16_000_000,
  /** Cards are stored at most this big on the longest side. */
  outputSide: 1024,
  thumbs: [128, 256] as const,
};

export type Slot = "head" | "face" | "body" | "back" | "aura" | "portal_fx";

/** A point on the card, normalised to [0, 1] from the top-left of the card image. */
export interface Anchor {
  x: number;
  y: number;
  /** Relative depth: back items render behind the body. */
  z: number;
}

/** The 2.5D image "card" avatar: textured layers on a plane, plus anchors for cosmetics. */
export interface CardManifest {
  v: 1;
  kind: "card";
  width: number;
  height: number;
  layers: { id: string; src: string; z: number }[];
  /** Emotion → layer src. "swap" cards have one drawing per emotion; "overlay" cards one drawing and procedural overlays. */
  emotions: { mode: "swap" | "overlay"; src: Partial<Record<string, string>> };
  /** A soft contact shadow under the feet, drawn procedurally. */
  shadow: { x: number; y: number; rx: number; ry: number; opacity: number };
  anchors: Record<Slot, Anchor>;
  thumbs: Record<string, string>;
}

export class UploadRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface Validated {
  type: ImageType;
  width: number;
  height: number;
}

/** Rejects anything that isn't a well-formed PNG/JPEG/WebP within the caps. */
export const validateImage = async (bytes: Uint8Array, declared?: string): Promise<Validated> => {
  if (bytes.byteLength === 0) throw new UploadRejected("empty file");
  if (bytes.byteLength > LIMITS.maxBytes) throw new UploadRejected("file too large");
  const bad = looksExecutableOrMarkup(bytes);
  if (bad) throw new UploadRejected(`not an image (${bad})`);
  const type = sniffImage(bytes);
  if (!type) throw new UploadRejected("unsupported format (PNG, JPEG or WebP only)");
  if (declared && declared !== `image/${type}`)
    throw new UploadRejected(`declared ${declared} but the file is ${type}`);
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { failOn: "error", limitInputPixels: LIMITS.maxPixels }).metadata();
  } catch {
    throw new UploadRejected("malformed or oversized image");
  }
  const { width = 0, height = 0 } = meta;
  if (Math.min(width, height) < LIMITS.minSide) throw new UploadRejected(`image too small (min ${LIMITS.minSide}px)`);
  if (Math.max(width, height) > LIMITS.maxSide) throw new UploadRejected(`image too large (max ${LIMITS.maxSide}px)`);
  if ((meta.pages ?? 1) > 1) throw new UploadRejected("animated images aren't supported");
  // The header can be fine with the pixels truncated or corrupt: decode it all once.
  try {
    await sharp(bytes, { failOn: "truncated", limitInputPixels: LIMITS.maxPixels }).raw().toBuffer();
  } catch {
    throw new UploadRejected("malformed image");
  }
  return { type, width, height };
};

/** Decodes to clean RGBA pixels (orientation applied, every metadata chunk dropped). */
const decode = async (bytes: Uint8Array) => {
  const { data, info } = await sharp(bytes, { failOn: "error", limitInputPixels: LIMITS.maxPixels })
    .rotate()
    .resize(LIMITS.outputSide, LIMITS.outputSide, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};

/**
 * Keys a flat background to transparency: the colour is sampled from the four corners, pixels
 * close to it go clear with a soft edge, and edge pixels lose the background tint (despill).
 */
export const keyBackground = (px: { data: Buffer; width: number; height: number }, tolerance = 70, softness = 50) => {
  const { data, width, height } = px;
  const at = (x: number, y: number) => (y * width + x) * 4;
  const corners = [at(2, 2), at(width - 3, 2), at(2, height - 3), at(width - 3, height - 3)];
  const bg = [0, 1, 2].map((c) => corners.reduce((s, i) => s + data[i + c]!, 0) / corners.length);
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.hypot(data[i]! - bg[0]!, data[i + 1]! - bg[1]!, data[i + 2]! - bg[2]!);
    if (d <= tolerance) data[i + 3] = 0;
    else if (d < tolerance + softness) {
      const a = (d - tolerance) / softness;
      data[i + 3] = Math.round(data[i + 3]! * a);
      // Despill: pull the edge colour away from the background.
      for (let c = 0; c < 3; c++)
        data[i + c] = Math.max(0, Math.min(255, Math.round((data[i + c]! - bg[c]! * (1 - a)) / a)));
    }
  }
  return px;
};

/** The opaque region's bounding box (alpha above a threshold), or the whole image. */
const opaqueBox = (px: { data: Buffer; width: number; height: number }, threshold = 16) => {
  let [x0, y0, x1, y1] = [px.width, px.height, -1, -1];
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++)
      if (px.data[(y * px.width + x) * 4 + 3]! > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? { x0: 0, y0: 0, x1: px.width - 1, y1: px.height - 1, empty: true } : { x0, y0, x1, y1, empty: false };
};

/** Mean x of opaque pixels between two rows (where a hat or a face actually is). */
const centreX = (px: { data: Buffer; width: number; height: number }, yFrom: number, yTo: number) => {
  let sum = 0;
  let n = 0;
  for (let y = Math.max(0, yFrom); y < Math.min(px.height, yTo); y++)
    for (let x = 0; x < px.width; x++)
      if (px.data[(y * px.width + x) * 4 + 3]! > 16) {
        sum += x;
        n++;
      }
  return n ? sum / n : px.width / 2;
};

/**
 * Where the skull starts: the first row (top half) with at least 60% of the opaque pixels of the
 * fullest row up there, so ears, tufts and hair spikes above the head don't count.
 */
const skullTop = (px: { data: Buffer; width: number; height: number }) => {
  // Opaque pixels per row, not the outer span: two ears far apart are wide but thin.
  const filled: number[] = [];
  for (let y = 0; y < Math.round(px.height * 0.5); y++) {
    let n = 0;
    for (let x = 0; x < px.width; x++) if (px.data[(y * px.width + x) * 4 + 3]! > 16) n++;
    filled.push(n);
  }
  const widest = Math.max(0, ...filled);
  const y = filled.findIndex((n) => n >= widest * 0.6);
  return y < 0 ? 0 : y;
};

/**
 * Cosmetic anchors from the silhouette: head where a hat's brim sits (just below the top of the
 * skull), face a little below, feet at the bottom.
 */
export const anchorsFor = (px: { data: Buffer; width: number; height: number }): Record<Slot, Anchor> => {
  const h = px.height;
  const w = px.width;
  const pt = (x: number, y: number, z: number): Anchor => ({ x: +(x / w).toFixed(4), y: +(y / h).toFixed(4), z });
  const topBand = centreX(px, 0, Math.round(h * 0.2));
  const faceBand = centreX(px, Math.round(h * 0.2), Math.round(h * 0.45));
  const bodyBand = centreX(px, Math.round(h * 0.45), Math.round(h * 0.8));
  return {
    head: pt(topBand, skullTop(px) + h * 0.03, 1),
    face: pt(faceBand, h * 0.32, 2),
    body: pt(bodyBand, h * 0.62, 1),
    back: pt(bodyBand, h * 0.55, -1),
    aura: pt(w / 2, h * 0.5, -2),
    portal_fx: pt(w / 2, h * 0.98, -3),
  };
};

export interface CardOutput {
  manifest: CardManifest;
  files: { name: string; bytes: Buffer; contentType: string }[];
}

/**
 * Image → 2.5D card. Each input becomes a cropped, transparent WebP layer re-encoded from
 * decoded pixels (no metadata or trailing payload survives). With several emotion drawings
 * (the roster) the card swaps layers; a single upload uses procedural emotion overlays.
 */
export const makeCard = async (
  drawings: { emotion: string; bytes: Uint8Array }[],
  opts: { keyBackground?: boolean } = {},
): Promise<CardOutput> => {
  if (!drawings.length) throw new UploadRejected("no image");
  const decoded = await Promise.all(
    drawings.map(async (d) => {
      const px = await decode(d.bytes);
      return { emotion: d.emotion, px: opts.keyBackground ? keyBackground(px) : px };
    }),
  );
  // One crop for every emotion so the figure doesn't jump between drawings.
  const boxes = decoded.map((d) => opaqueBox(d.px));
  const W = decoded[0]!.px.width;
  const H = decoded[0]!.px.height;
  const pad = Math.round(Math.max(W, H) * 0.04);
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x0)) - pad);
  const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y0)) - pad);
  const x1 = Math.min(W - 1, Math.max(...boxes.map((b) => b.x1)) + pad);
  const y1 = Math.min(H - 1, Math.max(...boxes.map((b) => b.y1)) + pad);
  const crop = { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };

  const files: CardOutput["files"] = [];
  const src: Record<string, string> = {};
  let neutralCropped: { data: Buffer; width: number; height: number } | null = null;
  for (const d of decoded) {
    const img = sharp(d.px.data, { raw: { width: d.px.width, height: d.px.height, channels: 4 } }).extract(crop);
    const name = `layer-${d.emotion}.webp`;
    files.push({
      name,
      bytes: await img.clone().webp({ quality: 88, alphaQuality: 90 }).toBuffer(),
      contentType: "image/webp",
    });
    src[d.emotion] = name;
    if (!neutralCropped || d.emotion === "neutral") {
      const { data, info } = await img.clone().raw().toBuffer({ resolveWithObject: true });
      neutralCropped = { data, width: info.width, height: info.height };
    }
  }
  const base = neutralCropped!;
  const thumbs: Record<string, string> = {};
  const baseLayer = src.neutral ?? Object.values(src)[0]!;
  for (const size of LIMITS.thumbs) {
    const name = `thumb-${size}.webp`;
    files.push({
      name,
      bytes: await sharp(base.data, { raw: { width: base.width, height: base.height, channels: 4 } })
        .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 85 })
        .toBuffer(),
      contentType: "image/webp",
    });
    thumbs[String(size)] = name;
  }
  const manifest: CardManifest = {
    v: 1,
    kind: "card",
    width: base.width,
    height: base.height,
    layers: [{ id: "body", src: baseLayer, z: 0 }],
    emotions: { mode: decoded.length > 1 ? "swap" : "overlay", src },
    shadow: { x: 0.5, y: 0.97, rx: 0.32, ry: 0.035, opacity: 0.25 },
    anchors: anchorsFor(base),
    thumbs,
  };
  files.push({
    name: "card.json",
    bytes: Buffer.from(JSON.stringify(manifest, null, 2)),
    contentType: "application/json",
  });
  return { manifest, files };
};
