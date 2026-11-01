// BOARD_LINK — Pillow 12's libImaging ops ported 1:1 (integer math and all), so the frames are
// byte-identical to make_sprites.py's; canvas resampling would not be.

/** Straight (non-premultiplied) RGBA, 4 bytes a pixel, rows top to bottom. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

export const blank = (width: number, height: number): Rgba => ({
  width,
  height,
  data: new Uint8Array(width * height * 4),
});

const shiftForDiv255 = (a: number) => ((a >> 8) + a) >> 8;
const mulDiv255 = (a: number, b: number) => shiftForDiv255(a * b + 128);

/** Image.alpha_composite(dst, src). */
export const alphaComposite = (dst: Rgba, src: Rgba): Rgba => {
  if (dst.width !== src.width || dst.height !== src.height) throw new Error("images do not match");
  const out = blank(dst.width, dst.height);
  const d = dst.data;
  const s = src.data;
  const o = out.data;
  for (let i = 0; i < o.length; i += 4) {
    const sa = s[i + 3]!;
    if (sa === 0) {
      o[i] = d[i]!;
      o[i + 1] = d[i + 1]!;
      o[i + 2] = d[i + 2]!;
      o[i + 3] = d[i + 3]!;
      continue;
    }
    const blend = d[i + 3]! * (255 - sa);
    const outa255 = sa * 255 + blend;
    // UINT32 division in C: floor, exact in doubles at these sizes.
    const coef1 = Math.floor((sa * 255 * 255 * 128) / outa255);
    const coef2 = 255 * 128 - coef1;
    for (let c = 0; c < 3; c++) o[i + c] = shiftForDiv255(s[i + c]! * coef1 + d[i + c]! * coef2 + (0x80 << 7)) >> 7;
    o[i + 3] = shiftForDiv255(outa255 + 0x80);
  }
  return out;
};

/** Image.getbbox() on RGBA (alpha_only): [left, top, right, bottom] of alpha > 0, or null. */
export const getBBox = (im: Rgba): [number, number, number, number] | null => {
  let x0 = im.width;
  let y0 = im.height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < im.height; y++)
    for (let x = 0; x < im.width; x++)
      if (im.data[(y * im.width + x) * 4 + 3]) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x + 1 > x1) x1 = x + 1;
        if (y + 1 > y1) y1 = y + 1;
      }
  return x1 === 0 ? null : [x0, y0, x1, y1];
};

/** Image.crop(box): outside the image is transparent black. */
export const crop = (im: Rgba, [l, t, r, b]: readonly [number, number, number, number]): Rgba => {
  const out = blank(r - l, b - t);
  for (let y = t; y < b; y++) {
    if (y < 0 || y >= im.height) continue;
    for (let x = l; x < r; x++) {
      if (x < 0 || x >= im.width) continue;
      const si = (y * im.width + x) * 4;
      out.data.set(im.data.subarray(si, si + 4), ((y - t) * out.width + (x - l)) * 4);
    }
  }
  return out;
};

const sinc = (x: number) => {
  if (x === 0) return 1;
  x = x * Math.PI;
  return Math.sin(x) / x;
};
const lanczos = (x: number) => (-3 <= x && x < 3 ? sinc(x) * sinc(x / 3) : 0);

const PRECISION_BITS = 32 - 8 - 2;
const ONE = 2 ** PRECISION_BITS;

/** Resample.c precompute_coeffs + normalize_coeffs_8bpc for LANCZOS over the whole source. */
const coeffs = (inSize: number, outSize: number) => {
  const scale = inSize / outSize;
  const filterscale = scale < 1 ? 1 : scale;
  const support = 3 * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const kk = new Int32Array(outSize * ksize);
  const bounds = new Int32Array(outSize * 2);
  const k = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let ww = 0;
    const ss = 1 / filterscale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    for (let x = 0; x < xmax; x++) {
      const w = lanczos((x + xmin - center + 0.5) * ss);
      k[x] = w;
      ww += w;
    }
    for (let x = 0; x < xmax; x++) {
      const v = ww !== 0 ? k[x]! / ww : k[x]!;
      kk[xx * ksize + x] = v < 0 ? Math.trunc(-0.5 + v * ONE) : Math.trunc(0.5 + v * ONE);
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, kk, bounds };
};

/** clip8: the accumulator's integer part (arithmetic shift) clamped to 0..255. */
const clip8 = (ss: number) => {
  const v = Math.floor(ss / ONE);
  return v < 0 ? 0 : v > 255 ? 255 : v;
};

/** ImagingResample on 4-band 8-bit data (here premultiplied RGBa), LANCZOS, box = whole image. */
const resample = (im: Rgba, width: number, height: number): Rgba => {
  const needH = width !== im.width;
  const needV = height !== im.height;
  const h = coeffs(im.width, width);
  const v = coeffs(im.height, height);
  const yFirst = v.bounds[0]!;
  const yLast = v.bounds[height * 2 - 2]! + v.bounds[height * 2 - 1]!;
  let src = im;
  if (needH) {
    for (let i = 0; i < height; i++) v.bounds[i * 2]! -= yFirst;
    const tmp = blank(width, yLast - yFirst);
    for (let yy = 0; yy < tmp.height; yy++) {
      const row = (yy + yFirst) * src.width;
      for (let xx = 0; xx < width; xx++) {
        const xmin = h.bounds[xx * 2]!;
        const xmax = h.bounds[xx * 2 + 1]!;
        const kb = xx * h.ksize;
        let s0 = ONE / 2;
        let s1 = s0;
        let s2 = s0;
        let s3 = s0;
        for (let x = 0; x < xmax; x++) {
          const p = (row + x + xmin) * 4;
          const kx = h.kk[kb + x]!;
          s0 += src.data[p]! * kx;
          s1 += src.data[p + 1]! * kx;
          s2 += src.data[p + 2]! * kx;
          s3 += src.data[p + 3]! * kx;
        }
        const o = (yy * width + xx) * 4;
        tmp.data[o] = clip8(s0);
        tmp.data[o + 1] = clip8(s1);
        tmp.data[o + 2] = clip8(s2);
        tmp.data[o + 3] = clip8(s3);
      }
    }
    src = tmp;
  }
  if (!needV) return needH ? src : { ...src, data: src.data.slice() };
  const out = blank(src.width, height);
  for (let yy = 0; yy < height; yy++) {
    const ymin = v.bounds[yy * 2]!;
    const ymax = v.bounds[yy * 2 + 1]!;
    const kb = yy * v.ksize;
    for (let xx = 0; xx < src.width; xx++) {
      let s0 = ONE / 2;
      let s1 = s0;
      let s2 = s0;
      let s3 = s0;
      for (let y = 0; y < ymax; y++) {
        const p = ((y + ymin) * src.width + xx) * 4;
        const ky = v.kk[kb + y]!;
        s0 += src.data[p]! * ky;
        s1 += src.data[p + 1]! * ky;
        s2 += src.data[p + 2]! * ky;
        s3 += src.data[p + 3]! * ky;
      }
      const o = (yy * src.width + xx) * 4;
      out.data[o] = clip8(s0);
      out.data[o + 1] = clip8(s1);
      out.data[o + 2] = clip8(s2);
      out.data[o + 3] = clip8(s3);
    }
  }
  return out;
};

/** Image.resize((w, h), Image.LANCZOS) on RGBA: RGBA → RGBa, resample, RGBa → RGBA. */
export const resizeLanczos = (im: Rgba, width: number, height: number): Rgba => {
  if (width === im.width && height === im.height) return { ...im, data: im.data.slice() };
  const pre = blank(im.width, im.height);
  for (let i = 0; i < im.data.length; i += 4) {
    const a = im.data[i + 3]!;
    pre.data[i] = mulDiv255(im.data[i]!, a);
    pre.data[i + 1] = mulDiv255(im.data[i + 1]!, a);
    pre.data[i + 2] = mulDiv255(im.data[i + 2]!, a);
    pre.data[i + 3] = a;
  }
  const out = resample(pre, width, height);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]!;
    if (a === 255 || a === 0) continue;
    for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, Math.floor((255 * d[i + c]!) / a));
  }
  return out;
};

/** ImageDraw.ellipse(xy, fill=ink) on RGBA: corners truncated to ints, ink written unblended. */
export const fillEllipse = (im: Rgba, xy: readonly [number, number, number, number], ink: readonly number[]) => {
  if (xy[2] < xy[0] || xy[3] < xy[1]) throw new Error("bad ellipse");
  const [x0, y0, x1, y1] = xy.map((v) => Math.trunc(v)) as [number, number, number, number];
  const a = x1 - x0;
  const b = y1 - y0;
  if (a < 0 || b < 0) return;
  const hline = (xa: number, y: number, xb: number) => {
    if (y < 0 || y >= im.height) return;
    if (xa < 0) xa = 0;
    else if (xa >= im.width) return;
    if (xb < 0) return;
    if (xb >= im.width) xb = im.width - 1;
    for (let x = xa; x <= xb; x++) im.data.set(ink, (y * im.width + x) * 4);
  };
  for (const [X0, Y, X1] of ellipseSpans(a, b, a + b))
    hline(x0 + Math.trunc((X0 + a) / 2), y0 + Math.trunc((Y + b) / 2), x0 + Math.trunc((X1 + a) / 2));
};

class Quarter {
  finished = false;
  cx = 0;
  cy = 0;
  readonly ex: number;
  readonly ey: number;
  readonly a2: number;
  readonly b2: number;
  readonly a2b2: number;
  constructor(a: number, b: number) {
    if (a < 0 || b < 0) this.finished = true;
    this.cx = a;
    this.cy = b % 2;
    this.ex = a % 2;
    this.ey = b;
    this.a2 = a * a;
    this.b2 = b * b;
    this.a2b2 = this.a2 * this.b2;
  }
  delta(x: number, y: number) {
    return Math.abs(this.a2 * y * y + this.b2 * x * x - this.a2b2);
  }
  next(): [number, number] | null {
    if (this.finished) return null;
    const ret: [number, number] = [this.cx, this.cy];
    if (this.cx === this.ex && this.cy === this.ey) this.finished = true;
    else {
      let nx = this.cx;
      let ny = this.cy + 2;
      let nd = this.delta(nx, ny);
      if (nx > 1) {
        let d = this.delta(this.cx - 2, this.cy + 2);
        if (nd > d) {
          nx = this.cx - 2;
          ny = this.cy + 2;
          nd = d;
        }
        d = this.delta(this.cx - 2, this.cy);
        if (nd > d) {
          nx = this.cx - 2;
          ny = this.cy;
        }
      }
      this.cx = nx;
      this.cy = ny;
    }
    return ret;
  }
}

/** Draw.c ellipse_init/ellipse_next: horizontal spans [x0, y, x1] on the doubled grid. */
function* ellipseSpans(a: number, b: number, w: number): Generator<[number, number, number]> {
  const leftmost = a % 2;
  const outer = new Quarter(a, b);
  const first = outer.next();
  if (w < 1 || !first) return;
  let [pr, py] = first;
  const inner = new Quarter(a - 2 * (w - 1), b - 2 * (w - 1));
  let pl = leftmost;
  let finished = false;
  while (!finished) {
    const y = py;
    let l = pl;
    const r = pr;
    let n: [number, number] | null;
    while ((n = outer.next()) && n[1] <= y);
    if (!n) finished = true;
    else [pr, py] = n;
    while ((n = inner.next()) && n[1] <= y) l = n[0];
    pl = n ? n[0] : leftmost;
    // Emitted in the C's buffer order (it pops the last pushed first).
    const buf: [number, number, number][] = [];
    if ((l > 0 || l < r) && y > 0) buf.push([l === 0 ? 2 : l, y, r]);
    if (y > 0) buf.push([-r, y, -l]);
    if (l > 0 || l < r) buf.push([l === 0 ? 2 : l, -y, r]);
    buf.push([-r, -y, -l]);
    while (buf.length) yield buf.pop()!;
  }
}
