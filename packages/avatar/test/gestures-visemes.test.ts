import { describe, expect, it } from "vitest";
import { EmotionTag, Gesture } from "@chalito/protocol";
import { GESTURES, creaturePose, sampleGesture } from "../src/gestures.js";
import { VISEMES, visemesFromFrames, type AudioFrame } from "../src/visemes.js";

describe("gesture library", () => {
  it("has every gesture the reply schema can ask for (except none)", () => {
    expect(Object.keys(GESTURES).sort()).toEqual(Gesture.options.filter((g) => g !== "none").sort());
  });

  for (const [name, g] of Object.entries(GESTURES)) {
    it(`${name}: starts and ends at rest, stays within joint-ish limits`, () => {
      const start = sampleGesture(g, 0);
      const end = sampleGesture(g, g.durationMs);
      for (const r of [...Object.values(start.bones), ...(g.loop ? [] : Object.values(end.bones))])
        expect(r!.every((v) => Math.abs(v) < 1e-9)).toBe(true);
      for (let t = 0; t <= g.durationMs; t += 50)
        for (const r of Object.values(sampleGesture(g, t).bones))
          for (const v of r!) expect(Math.abs(v)).toBeLessThanOrEqual(180);
      expect(sampleGesture(g, g.durationMs * 2).done).toBe(!g.loop);
    });
  }

  it("weight scales the motion; expression accents fade in and out", () => {
    const full = sampleGesture(GESTURES.wave, 900).bones.rightUpperArm!;
    const half = sampleGesture(GESTURES.wave, 900, 0.5).bones.rightUpperArm!;
    expect(half[2]).toBeCloseTo(full[2] / 2, 5);
    const mid = sampleGesture(GESTURES.yawn, 1400).expressions!.aa!;
    expect(mid).toBeGreaterThan(0.5);
    expect(sampleGesture(GESTURES.yawn, 0).expressions!.aa).toBeCloseTo(0, 5);
  });
});

describe("non-humanoid preset (squash-and-stretch + bob + look-at)", () => {
  it("drives every emotion tag and preserves volume", () => {
    for (const tag of EmotionTag.options)
      for (let t = 0; t < 3000; t += 37) {
        const p = creaturePose({ tag, intensity: 0.8 }, t);
        const [x, y, z] = p.scale;
        // Volume ≈ 1, except the deliberate sad/tired sag.
        const sag = tag === "sad" || tag === "tired" ? 0.06 * 0.8 : 0;
        expect(x * y * z).toBeCloseTo(1 - sag, 2);
        expect(p.offsetY).toBeGreaterThanOrEqual(0);
        expect(p.lookAtWeight).toBeGreaterThan(0);
      }
  });

  it("excited bounces more than tired; thinking tilts", () => {
    const amp = (tag: "excited" | "tired") => {
      let max = 0;
      for (let t = 0; t < 3000; t += 10) max = Math.max(max, creaturePose({ tag, intensity: 1 }, t).offsetY);
      return max;
    };
    expect(amp("excited")).toBeGreaterThan(amp("tired") * 3);
    expect(creaturePose({ tag: "thinking", intensity: 1 }, 0).tilt[2]).toBeGreaterThan(0);
  });
});

describe("visemes from output audio", () => {
  const SR = 24_000;
  const BINS = 512;
  /** A spectrum with energy peaks at the given frequencies (formants). */
  const spectrum = (peaks: [hz: number, amp: number][]) => {
    const s = new Float32Array(BINS);
    const binHz = SR / 2 / BINS;
    for (const [hz, amp] of peaks) for (let d = -2; d <= 2; d++) s[Math.round(hz / binHz) + d] = amp;
    return s;
  };
  const vowel = (peaks: [number, number][], rms = 0.2): AudioFrame => ({
    rms,
    spectrum: spectrum(peaks),
    sampleRate: SR,
  });
  const settle = (f: AudioFrame) => visemesFromFrames(Array.from({ length: 12 }, () => f)).at(-1)!;
  const top = (w: Record<string, number>) => Object.entries(w).sort((a, b) => b[1] - a[1])[0]![0];

  it("silence and breath noise keep the mouth closed", () => {
    const w = visemesFromFrames([{ rms: 0 }, { rms: 0.01 }, { rms: 0.015 }]);
    for (const f of w) for (const v of VISEMES) expect(f[v]).toBe(0);
  });

  it("vowel formants pick the matching shape", () => {
    expect(
      top(
        settle(
          vowel([
            [750, 1],
            [1200, 0.5],
          ]),
        ),
      ),
    ).toBe("aa"); // open jaw (high F1)
    expect(
      top(
        settle(
          vowel([
            [300, 1],
            [2300, 0.9],
          ]),
        ),
      ),
    ).toBe("ee"); // closed jaw, front tongue
    expect(
      top(
        settle(
          vowel([
            [320, 1],
            [800, 0.1],
          ]),
        ),
      ),
    ).toBe("ou"); // rounded, low F1/F2
  });

  it("louder opens wider; smoothing rises faster than it falls", () => {
    const quiet = settle(vowel([[750, 1]], 0.08));
    const loud = settle(vowel([[750, 1]], 0.25));
    expect(loud.aa).toBeGreaterThan(quiet.aa);
    const seq = visemesFromFrames([vowel([[750, 1]]), vowel([[750, 1]]), { rms: 0 }, { rms: 0 }]);
    expect(seq[1]!.aa).toBeGreaterThan(seq[0]!.aa);
    expect(seq[2]!.aa).toBeGreaterThan(0); // release is gradual
    expect(seq[3]!.aa).toBeLessThan(seq[2]!.aa);
  });

  it("is deterministic: the same frames give the same weights", () => {
    const frames: AudioFrame[] = Array.from({ length: 50 }, (_, i) =>
      vowel(
        [
          [300 + ((i * 53) % 500), 1],
          [900 + ((i * 97) % 1600), 0.7],
        ],
        ((i * 13) % 30) / 100,
      ),
    );
    expect(visemesFromFrames(frames)).toEqual(visemesFromFrames(frames));
    for (const f of visemesFromFrames(frames))
      for (const v of VISEMES) {
        expect(f[v]).toBeGreaterThanOrEqual(0);
        expect(f[v]).toBeLessThanOrEqual(1);
      }
  });

  it("works without a spectrum (level only)", () => {
    const w = settle({ rms: 0.25 });
    expect(w.aa).toBeGreaterThan(w.oh);
    expect(w.ee).toBe(0);
  });
});
