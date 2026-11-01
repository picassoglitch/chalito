import type { Rgba } from "./pillow.js";

// Owner, 2026-10-30: the LCD's cream room looked like "a white room"; Chalito stands on a hill under a
// sky that follows the person's local time (dawn, day, sunset, night).

type Rgb = readonly [number, number, number];

export type DayPart = "dawn" | "day" | "sunset" | "night";

/** The person's local hour → the sky to draw. */
export const dayPartAt = (date: Date): DayPart => {
  const h = date.getHours();
  return h >= 5 && h < 8 ? "dawn" : h >= 8 && h < 17 ? "day" : h >= 17 && h < 20 ? "sunset" : "night";
};

interface Look {
  sky: readonly (readonly [number, Rgb])[];
  farHill: Rgb;
  hillTop: Rgb;
  hillLow: Rgb;
  rim: Rgb;
  stars: number;
  /** Sun or moon: centre, radius, colour, glow strength. */
  orb: { x: number; y: number; r: number; c: Rgb; glow: number; moon: boolean };
  clouds: number;
  fireflies: boolean;
}

const LOOKS: Record<DayPart, Look> = {
  dawn: {
    sky: [
      [0, [70, 92, 160]],
      [130, [170, 150, 190]],
      [200, [250, 190, 170]],
      [236, [255, 222, 170]],
    ],
    farHill: [120, 110, 150],
    hillTop: [88, 150, 104],
    hillLow: [44, 96, 70],
    rim: [200, 230, 170],
    stars: 0.25,
    orb: { x: 34, y: 214, r: 13, c: [255, 214, 150], glow: 0.45, moon: false },
    clouds: 0.5,
    fireflies: false,
  },
  day: {
    sky: [
      [0, [70, 150, 230]],
      [140, [130, 196, 245]],
      [236, [210, 236, 250]],
    ],
    farHill: [120, 176, 150],
    hillTop: [104, 186, 96],
    hillLow: [56, 130, 64],
    rim: [190, 236, 150],
    stars: 0,
    orb: { x: 140, y: 34, r: 13, c: [255, 246, 200], glow: 0.5, moon: false },
    clouds: 1,
    fireflies: false,
  },
  sunset: {
    sky: [
      [0, [40, 34, 92]],
      [110, [150, 70, 120]],
      [180, [240, 120, 90]],
      [236, [255, 190, 110]],
    ],
    farHill: [100, 56, 96],
    hillTop: [70, 110, 78],
    hillLow: [34, 66, 52],
    rim: [240, 190, 130],
    stars: 0.15,
    orb: { x: 134, y: 222, r: 15, c: [255, 170, 90], glow: 0.55, moon: false },
    clouds: 0.4,
    fireflies: true,
  },
  night: {
    sky: [
      [0, [14, 16, 34]],
      [150, [30, 34, 64]],
      [236, [56, 58, 92]],
    ],
    farHill: [34, 36, 70],
    hillTop: [36, 74, 72],
    hillLow: [16, 40, 42],
    rim: [110, 150, 170],
    stars: 1,
    orb: { x: 138, y: 40, r: 11, c: [255, 243, 214], glow: 0.3, moon: true },
    clouds: 0,
    fireflies: true,
  },
};

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const skyAt = (stops: Look["sky"], y: number): Rgb => {
  for (let i = 1; i < stops.length; i++) {
    const [y1, c1] = stops[i]!;
    const [y0, c0] = stops[i - 1]!;
    if (y <= y1) return mix(c0, c1, (y - y0) / (y1 - y0));
  }
  return stops[stops.length - 1]![1];
};

/** Deterministic noise in 0..1, so the same card always hashes the same. */
const hash = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// The near hill's crest runs through `ground`, just behind the feet, so Chalito stands on it.
const farHillY = (x: number, ground: number) => ground - 48 + 7 * Math.sin(x * 0.045 + 1.3) + 4 * Math.sin(x * 0.11);
const hillY = (x: number, ground: number) => ground + ((x - 86) / 86) ** 2 * 10 - 1.5 * Math.sin(x * 0.07);

/** Soft puffs: (centre x, centre y, radius) circles per cloud. */
const CLOUDS = [
  [
    [30, 70, 12],
    [44, 64, 15],
    [58, 71, 11],
  ],
  [
    [118, 118, 10],
    [131, 112, 13],
    [144, 119, 10],
  ],
  [
    [20, 160, 9],
    [32, 155, 11],
    [44, 161, 8],
  ],
] as const;

const FIREFLIES = [
  [22, 236],
  [150, 244],
  [38, 280],
  [140, 292],
  [12, 200],
  [160, 206],
] as const;

/** The 172×320 scene behind the sprite, its ground surface at `ground` (y). Elements stay clear of the
 * panel's rounded corners. */
export const backdrop = (w: number, h: number, part: DayPart, ground = 300): Rgba => {
  const L = LOOKS[part];
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let c = skyAt(L.sky, y);
      // Stars fade out toward the horizon.
      if (L.stars && hash(x, y) > 0.993)
        c = mix(c, [255, 255, 255], (0.35 + 0.65 * hash(y, x)) * L.stars * Math.max(0, 1 - y / 170));
      const o = L.orb;
      const d = Math.hypot(x - o.x, y - o.y);
      if (d < o.r) c = o.moon ? mix(o.c, [236, 214, 180], hash(x >> 2, y >> 2) * 0.25) : o.c;
      else if (d < o.r * 3) c = mix(c, o.c, ((o.r * 3 - d) / (o.r * 2)) ** 2 * o.glow);
      if (L.clouds)
        for (const cloud of CLOUDS) {
          let inside = 0;
          for (const [cx, cy, r] of cloud)
            inside = Math.max(inside, Math.min(1, (r - Math.hypot(x - cx, y - cy)) / 2.5));
          if (inside > 0) c = mix(c, mix([255, 255, 255], skyAt(L.sky, 236), 0.25), inside * 0.85 * L.clouds);
        }
      const fy = farHillY(x, ground);
      if (y >= fy) c = mix(L.farHill, mix(L.farHill, skyAt(L.sky, 236), 0.3), Math.max(0, 1 - (y - fy) / 30));
      const hy = hillY(x, ground);
      if (y >= hy) {
        c = mix(L.hillTop, L.hillLow, Math.min(1, (y - hy) / 40));
        // A lit rim along the hill's crest and some grass speckle.
        if (y - hy < 1.5) c = mix(c, L.rim, 0.6);
        else if (hash(x, y) > 0.9) c = mix(c, L.hillTop, 0.5);
      }
      if (L.fireflies)
        for (const [fx, fyy] of FIREFLIES) {
          const fd = Math.hypot(x - fx, y - fyy);
          if (fd < 6) c = mix(c, [255, 226, 120], fd < 1.2 ? 1 : ((6 - fd) / 6) ** 2 * 0.55);
        }
      const at = (y * w + x) * 4;
      data[at] = Math.round(c[0]);
      data[at + 1] = Math.round(c[1]);
      data[at + 2] = Math.round(c[2]);
      data[at + 3] = 255;
    }
  return { width: w, height: h, data };
};
