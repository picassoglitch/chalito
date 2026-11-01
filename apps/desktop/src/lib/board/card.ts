import { backdrop as sceneBackdrop, type DayPart } from "./backdrop.js";
import { alphaComposite, blank, crop, fillEllipse, getBBox, resizeLanczos, type Rgba } from "./pillow.js";

/** The LCD's frames in upload (and hash) order (docs/BOARD_LINK.md, "Card frames"). */
export const CARD_FRAMES = ["background", "neutral", "blink", "happy", "surprised", "tired"] as const;
export type CardFrame = (typeof CARD_FRAMES)[number];

export const LCD_W = 172;
export const LCD_H = 320;
const MAX_W = 164;
const MAX_H = 296;
const BOTTOM_MARGIN = 12;
const SCENE_BOTTOM = 36;
const BG = [255, 246, 232] as const;
export const KEY = 0x0821;
/** The board's card partition holds at most this much. */
export const MAX_CARD_BYTES = 1024 * 1024;

/** The parts of a card.json the converter reads (roster cards and custom cards alike). */
export interface CardManifest {
  width: number;
  height: number;
  emotions?: { src?: Record<string, string> };
  layers?: { src: string }[];
  shadow?: { x: number; y: number; rx: number; ry: number; opacity: number };
  rig?: unknown;
}

export interface BoardCard {
  /** sha256 hex of every frame's bytes in CARD_FRAMES order. */
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  frames: Record<CardFrame, Uint8Array>;
}

/** Python's round(): half to even. */
export const pyRound = (v: number): number => {
  const f = Math.floor(v);
  const d = v - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
};

const rgb565 = (r: number, g: number, b: number) => ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);

/** make_sprites.py to_bin: big-endian RGB565 blended onto the cream, alpha < 20 → KEY. With `under`
 * (a backdrop and where the image sits on it) edges blend onto the backdrop's pixels instead. */
export const toRgb565 = (im: Rgba, transparent: boolean, under?: { bg: Rgba; x: number; y: number }): Uint8Array => {
  const out = new Uint8Array(im.width * im.height * 2);
  const d = im.data;
  for (let i = 0, o = 0; i < d.length; i += 4, o += 2) {
    const a = d[i + 3]!;
    let v: number;
    if (transparent && a < 20) v = KEY;
    else {
      const k = a / 255;
      let b: ArrayLike<number> = BG;
      if (under) {
        const p = i / 4;
        const at = ((under.y + Math.floor(p / im.width)) * under.bg.width + under.x + (p % im.width)) * 4;
        b = under.bg.data.subarray(at, at + 3);
      }
      v = rgb565(
        pyRound(d[i]! * k + b[0]! * (1 - k)),
        pyRound(d[i + 1]! * k + b[1]! * (1 - k)),
        pyRound(d[i + 2]! * k + b[2]! * (1 - k)),
      );
      if (v === KEY) v += 1;
    }
    out[o] = v >> 8;
    out[o + 1] = v & 0xff;
  }
  return out;
};

const lidsOf = (rig: unknown): string | null => {
  const parts = (rig as { parts?: unknown } | null)?.parts;
  if (!Array.isArray(parts)) return null;
  const lids = parts.find((p) => (p as { id?: unknown })?.id === "lids") as { src?: unknown } | undefined;
  return typeof lids?.src === "string" ? lids.src : null;
};

/** Which card files make each sprite frame: a missing emotion is neutral; blink adds the rig's lids. */
export const frameFiles = (m: CardManifest): Record<Exclude<CardFrame, "background">, string[]> => {
  const neutral = m.emotions?.src?.neutral ?? m.layers?.[0]?.src;
  if (!neutral) throw new Error("card has no neutral drawing");
  const emotion = (e: string) => [m.emotions?.src?.[e] ?? neutral];
  const lids = lidsOf(m.rig);
  return {
    neutral: [neutral],
    blink: lids ? [neutral, lids] : [neutral],
    happy: emotion("happy"),
    surprised: emotion("surprised"),
    tired: emotion("tired"),
  };
};

const sha256Hex = async (parts: readonly Uint8Array[]): Promise<string> => {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** This LCD shows reds weaker and colours paler than a desktop monitor (owner's photo, 2026-10-30):
 * a little more saturation and warmth so the board looks like the pet on screen. */
export const lcdTone = (im: Rgba): Rgba => {
  const d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!;
    const g = d[i + 1]!;
    const b = d[i + 2]!;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = (c: number) => y + (c - y) * 1.3;
    d[i] = Math.max(0, Math.min(255, Math.round(sat(r) * 1.08)));
    d[i + 1] = Math.max(0, Math.min(255, Math.round(sat(g))));
    d[i + 2] = Math.max(0, Math.min(255, Math.round(sat(b) * 0.92)));
  }
  return im;
};

export interface ConvertOptions {
  /** "room" is make_sprites.py's cream; a day part draws the hill scene for it (backdrop.ts). */
  backdrop?: "room" | DayPart;
  /** Applied to each full-size frame before the crop (the card's skin, see skin-bake.ts). */
  effect?: (frame: Rgba) => Rgba;
}

/** A card as the LCD's frames, the way make_sprites.py makes them. `load` decodes one card file. */
export const convertCard = async (
  m: CardManifest,
  load: (file: string) => Promise<Rgba>,
  { backdrop = "room", effect }: ConvertOptions = {},
): Promise<BoardCard> => {
  const files = frameFiles(m);
  const used = [...new Set(Object.values(files).flat())];
  const layers = new Map<string, Rgba>();
  for (const f of used) layers.set(f, await load(f));
  const boxes = [...layers.values()].map(getBBox).filter((b) => b !== null);
  if (!boxes.length) throw new Error("card is empty");
  const box = [0, 1, 2, 3].map((i) => (i < 2 ? Math.min : Math.max)(...boxes.map((b) => b[i]!))) as [
    number,
    number,
    number,
    number,
  ];
  if (effect) {
    // Room for a skin's glow just outside the silhouette.
    const pad = Math.round(0.03 * m.width);
    const first = layers.values().next().value!;
    box[0] = Math.max(0, box[0] - pad);
    box[1] = Math.max(0, box[1] - pad);
    box[2] = Math.min(first.width, box[2] + pad);
    box[3] = Math.min(first.height, box[3] + pad);
  }
  const cw = box[2] - box[0];
  const ch = box[3] - box[1];
  // A scene leaves a strip of ground under the feet, so Chalito stands on the hill (owner, 2026-10-30).
  const bottom = backdrop === "room" ? BOTTOM_MARGIN : SCENE_BOTTOM;
  const scale = Math.min(MAX_W / cw, (MAX_H - bottom + BOTTOM_MARGIN) / ch);
  const w = pyRound(cw * scale);
  const h = pyRound(ch * scale);
  const x = Math.floor((LCD_W - w) / 2);
  const y = LCD_H - bottom - h;

  // The floor shadow, mapped from the card's canvas to the screen like the sprites.
  const sh = m.shadow ?? { x: 0.5, y: 0.97, rx: 0.32, ry: 0.035, opacity: 0.25 };
  const sx = x + (sh.x * m.width - box[0]) * scale;
  // On a scene the shadow sits right under the feet; a lower one reads as hovering.
  const sy = backdrop === "room" ? y + (sh.y * m.height - box[1]) * scale : y + h - 2;
  const rx = sh.rx * m.width * scale;
  const ry = Math.max(sh.ry * m.height * scale, 4);
  let bg = blank(LCD_W, LCD_H);
  if (backdrop !== "room") bg = sceneBackdrop(LCD_W, LCD_H, backdrop, sy - 8);
  else for (let i = 0; i < bg.data.length; i += 4) bg.data.set([...BG, 255], i);
  const shadow = blank(LCD_W, LCD_H);
  // On a scene the shadow is darker, so the feet read as touching the ground.
  const opacity = backdrop === "room" ? sh.opacity : Math.max(sh.opacity, 0.4);
  fillEllipse(
    shadow,
    [sx - rx, sy - ry, sx + rx, sy + ry],
    backdrop === "room" ? [60, 40, 30, pyRound(255 * opacity)] : [20, 30, 20, pyRound(255 * opacity)],
  );
  bg = alphaComposite(bg, shadow);
  if (backdrop !== "room") bg = lcdTone(bg);

  const sprites = {} as Record<CardFrame, Uint8Array>;
  sprites.background = toRgb565(bg, false);
  const under = backdrop === "room" ? undefined : { bg, x, y };
  for (const [name, fs] of Object.entries(files)) {
    const first = layers.get(fs[0]!)!;
    let frame = blank(first.width, first.height);
    for (const f of fs) frame = alphaComposite(frame, layers.get(f)!);
    if (effect) frame = effect(frame);
    if (backdrop !== "room") frame = lcdTone(frame);
    sprites[name as CardFrame] = toRgb565(resizeLanczos(crop(frame, box), w, h), true, under);
  }

  const frames = Object.fromEntries(CARD_FRAMES.map((f) => [f, sprites[f]])) as Record<CardFrame, Uint8Array>;
  const total = CARD_FRAMES.reduce((n, f) => n + frames[f].length, 0);
  if (total > MAX_CARD_BYTES) throw new Error("card too large for the board");
  return { key: await sha256Hex(CARD_FRAMES.map((f) => frames[f])), x, y, w, h, frames };
};
