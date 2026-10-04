/**
 * The pet window is transparent and full of nothing: clicks must fall through to whatever
 * is underneath except on the avatar itself. Tauri can't hit-test per pixel (D-006), so the
 * webview sends the avatar's screen-space box and the Rust side polls the cursor against it
 * (~30 Hz) and toggles `set_ignore_cursor_events`.
 */

/** A rectangle in some pixel space: x, y = top-left. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Projected avatar bounds in normalised device coordinates (-1..1, y up), e.g. from a Box3. */
export interface NdcBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** NDC bounds → CSS pixels inside a canvas of the given size (y down), clipped to the canvas. */
export const ndcToCanvas = (b: NdcBounds, canvas: { width: number; height: number }): Rect | null => {
  const x0 = ((Math.max(-1, b.minX) + 1) / 2) * canvas.width;
  const x1 = ((Math.min(1, b.maxX) + 1) / 2) * canvas.width;
  const y0 = ((1 - Math.min(1, b.maxY)) / 2) * canvas.height;
  const y1 = ((1 - Math.max(-1, b.minY)) / 2) * canvas.height;
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
};

export interface WindowGeometry {
  /** Window inner position in PHYSICAL screen pixels (Tauri `innerPosition`). */
  innerX: number;
  innerY: number;
  /** Physical pixels per CSS pixel (Tauri `scaleFactor` / devicePixelRatio). */
  scale: number;
}

/**
 * Canvas-space CSS rect (+ the canvas's offset in the page) → a PHYSICAL screen-space hit
 * box, padded so the edge of a moving avatar doesn't flicker between click-through and not.
 * Physical pixels because that's what Tauri's `cursor_position` reports.
 */
export const toScreenHitBox = (
  r: Rect | null,
  win: WindowGeometry,
  opts: { canvasLeft?: number; canvasTop?: number; padding?: number } = {},
): Rect | null => {
  if (!r) return null;
  const pad = opts.padding ?? 6;
  const s = win.scale;
  const x = win.innerX + ((opts.canvasLeft ?? 0) + r.x - pad) * s;
  const y = win.innerY + ((opts.canvasTop ?? 0) + r.y - pad) * s;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round((r.width + 2 * pad) * s),
    height: Math.round((r.height + 2 * pad) * s),
  };
};

/** Mirrors the Rust `hittest::contains` (inclusive top-left, exclusive bottom-right). */
export const contains = (r: Rect | null, px: number, py: number): boolean =>
  !!r && px >= r.x && py >= r.y && px < r.x + r.width && py < r.y + r.height;

/** Whether a new box is worth sending (the Rust side polls; don't flood IPC with 1px jitter). */
export const changedEnough = (a: Rect | null, b: Rect | null, tolerancePx = 2): boolean => {
  if (!a || !b) return a !== b;
  return (
    Math.abs(a.x - b.x) > tolerancePx ||
    Math.abs(a.y - b.y) > tolerancePx ||
    Math.abs(a.width - b.width) > tolerancePx ||
    Math.abs(a.height - b.height) > tolerancePx
  );
};
