import { clamp } from "./math.js";

/** VRM mouth shapes (three-vrm presets). */
export const VISEMES = ["aa", "ih", "ou", "ee", "oh"] as const;
export type Viseme = (typeof VISEMES)[number];
export type VisemeWeights = Record<Viseme, number>;

/** One analysis frame of the companion's OUTPUT audio (what it says), e.g. from an AnalyserNode. */
export interface AudioFrame {
  /** RMS level of the frame, 0..1 (linear). */
  rms: number;
  /** Magnitude spectrum (linear, any scale), bins 0..N-1 covering 0..sampleRate/2. */
  spectrum?: ArrayLike<number>;
  sampleRate?: number;
}

export interface VisemeOptions {
  /** Below this RMS the mouth is closed (silence, breath noise). */
  noiseFloor?: number;
  /** RMS that opens the mouth fully. */
  fullOpenRms?: number;
  /** Per-frame smoothing toward the target: rising (attack) and falling (release), 0..1. */
  attack?: number;
  release?: number;
}

const ZERO: VisemeWeights = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };

/** Energy in [lo, hi) Hz of a magnitude spectrum. */
const band = (spec: ArrayLike<number>, sampleRate: number, lo: number, hi: number) => {
  const binHz = sampleRate / 2 / spec.length;
  const a = Math.max(0, Math.floor(lo / binHz));
  const b = Math.min(spec.length, Math.ceil(hi / binHz));
  let e = 0;
  for (let i = a; i < b; i++) e += (spec[i] ?? 0) ** 2;
  return e;
};

/**
 * The shape for one frame, before smoothing. Openness comes from loudness; the vowel from a
 * coarse formant picture: where F1 sits (jaw closed vs open) and whether there is high F2
 * energy (tongue front):  open + back → aa;  closed + front → ee;  open + front → ih;
 *   closed + back (rounded) → ou;  in between and back → oh.
 * Without a spectrum, loudness alone drives a neutral `aa`/`oh` mix.
 */
export const frameShape = (f: AudioFrame, o: Required<VisemeOptions>): VisemeWeights => {
  const open = clamp((f.rms - o.noiseFloor) / Math.max(1e-6, o.fullOpenRms - o.noiseFloor));
  if (open <= 0) return { ...ZERO };
  if (!f.spectrum || !f.spectrum.length || !f.sampleRate)
    return { aa: open * 0.7, ih: 0, ou: 0, ee: 0, oh: open * 0.3 };
  const sr = f.sampleRate;
  // F1 region split into closed-jaw (200–450 Hz) and open-jaw (450–1000 Hz) energy; F2 high
  // (1700–3000 Hz) marks front vowels (i/e). Back/rounded vowels have little F2-high energy.
  const closedJaw = band(f.spectrum, sr, 200, 450);
  const openJaw = band(f.spectrum, sr, 450, 1000);
  const frontF2 = band(f.spectrum, sr, 1700, 3000);
  const total = closedJaw + openJaw + frontF2;
  if (total <= 0) return { aa: open * 0.7, ih: 0, ou: 0, ee: 0, oh: open * 0.3 };
  const jawOpen = openJaw / total;
  const jawClosed = closedJaw / total;
  const front = frontF2 / total;
  const back = 1 - front;
  const raw: VisemeWeights = {
    aa: jawOpen * back * 1.4,
    ee: front * (1 - jawOpen) * 1.2,
    ih: front * jawOpen * 1.1,
    ou: jawClosed * back * back,
    oh: (jawOpen * 0.6 + jawClosed * 0.4) * back * 0.6,
  };
  const peak = Math.max(...Object.values(raw), 1e-6);
  const out = { ...ZERO };
  for (const v of VISEMES) out[v] = clamp((raw[v] / peak) * open);
  return out;
};

/**
 * Audio frames → viseme weights per frame. A pure function of the frames (same input, same
 * output), with attack/release smoothing so the mouth doesn't chatter between frames.
 */
export const visemesFromFrames = (frames: readonly AudioFrame[], opts: VisemeOptions = {}): VisemeWeights[] => {
  const o: Required<VisemeOptions> = {
    noiseFloor: opts.noiseFloor ?? 0.02,
    fullOpenRms: opts.fullOpenRms ?? 0.25,
    attack: opts.attack ?? 0.6,
    release: opts.release ?? 0.25,
  };
  const out: VisemeWeights[] = [];
  let prev = { ...ZERO };
  for (const f of frames) {
    const target = frameShape(f, o);
    const next = { ...ZERO };
    for (const v of VISEMES) {
      const k = target[v] > prev[v] ? o.attack : o.release;
      next[v] = prev[v] + (target[v] - prev[v]) * k;
      if (next[v] < 1e-3) next[v] = 0;
    }
    out.push(next);
    prev = next;
  }
  return out;
};
