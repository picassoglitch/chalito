import { describe, expect, it } from "vitest";
import { CompanionReply, EmotionTag } from "@chalito/protocol";
import {
  EMOTIONS,
  EmotionBlender,
  VRM0_CAPS,
  VRM1_CAPS,
  emotionGesture,
  expressionTarget,
  type ExpressionWeights,
} from "../src/emotion.js";

const sum = (w: ExpressionWeights) => Object.values(w).reduce((a, b) => a + (b ?? 0), 0);

describe("emotion → expression mapping", () => {
  it("covers every EmotionTag in @chalito/protocol", () => {
    expect(Object.keys(EMOTIONS).sort()).toEqual([...EmotionTag.options].sort());
  });

  // The expected dominant VRM expression per tag at full intensity.
  const dominant: Record<string, string> = {
    neutral: "neutral",
    happy: "happy",
    angry: "angry",
    sad: "sad",
    relaxed: "relaxed",
    surprised: "surprised",
    excited: "happy",
    tired: "relaxed",
    thinking: "neutral",
    worried: "sad",
  };
  for (const tag of EmotionTag.options) {
    it(`${tag}: full intensity is led by ${dominant[tag]}; intensity scales it; weights stay in 0..1`, () => {
      const full = expressionTarget({ tag, intensity: 1 });
      const lead = Object.entries(full).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0]![0];
      expect(lead).toBe(dominant[tag]);
      for (const v of Object.values(full)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      // (Tags led by neutral itself also get the low-intensity neutral floor, so skip the scaling check.)
      if (dominant[tag] !== "neutral") {
        const half = expressionTarget({ tag, intensity: 0.5 });
        expect(half[dominant[tag] as keyof ExpressionWeights]!).toBeCloseTo(
          (full[dominant[tag] as keyof ExpressionWeights] ?? 0) * 0.5,
          5,
        );
        // Low intensity keeps neutral underneath.
        expect(expressionTarget({ tag, intensity: 0.2 }).neutral).toBeGreaterThanOrEqual(0.8);
      }
    });
  }

  it("tags beyond the five presets bring a gesture above their threshold", () => {
    expect(emotionGesture({ tag: "excited", intensity: 0.9 })).toBe("celebrate");
    expect(emotionGesture({ tag: "excited", intensity: 0.3 })).toBeNull();
    expect(emotionGesture({ tag: "tired", intensity: 0.8 })).toBe("yawn");
    expect(emotionGesture({ tag: "thinking", intensity: 0.5 })).toBe("think");
    expect(emotionGesture({ tag: "worried", intensity: 0.9 })).toBe("shrug");
    expect(emotionGesture({ tag: "neutral", intensity: 1 })).toBeNull();
  });

  it("tired droops the eyelids and slows blinking (the recharge animation)", () => {
    expect(EMOTIONS.tired.eyelidDroop).toBeGreaterThan(0.3);
    expect(EMOTIONS.tired.blinkRate).toBeLessThan(1);
    expect(EMOTIONS.tired.energy).toBeLessThan(EMOTIONS.neutral.energy);
  });

  it("VRM 0.x has no `surprised`: it becomes an open mouth (aa) + a little happy", () => {
    const w = expressionTarget({ tag: "surprised", intensity: 1 }, VRM0_CAPS);
    expect(w.surprised).toBeUndefined();
    expect(w.aa).toBeCloseTo(0.5, 5);
    expect(w.happy).toBeCloseTo(0.15, 5);
    // Excited (happy + surprised) keeps its happy and gains the mouth.
    const x = expressionTarget({ tag: "excited", intensity: 1 }, VRM0_CAPS);
    expect(x.surprised).toBeUndefined();
    expect(x.happy).toBeGreaterThan(0.85);
    expect(x.aa).toBeGreaterThan(0);
    expect(expressionTarget({ tag: "surprised", intensity: 1 }, VRM1_CAPS).surprised).toBe(1);
  });
});

describe("EmotionBlender (ease-in/out, hold, release)", () => {
  it("eases in, holds, then eases back to neutral", () => {
    const b = new EmotionBlender(VRM1_CAPS, { transitionMs: 400, holdMs: 1000, releaseMs: 500 });
    b.set({ tag: "happy", intensity: 1 }, 0);
    const at = (t: number) => b.sample(t).happy ?? 0;
    expect(at(0)).toBe(0);
    // Ease-in-out: slow start, faster middle.
    expect(at(40)).toBeLessThan(0.05);
    expect(at(200)).toBeGreaterThan(0.4);
    expect(at(400)).toBeCloseTo(1, 5);
    expect(at(1200)).toBeCloseTo(1, 5); // hold (1000 ms × (0.6 + 0.8))
    const releaseStart = 400 + 1000 * 1.4;
    expect(at(releaseStart + 500)).toBeCloseTo(0, 5);
    expect(b.sample(releaseStart + 500).neutral).toBeCloseTo(1, 5);
  });

  it("a new emotion starts from wherever the face is (no snap)", () => {
    const b = new EmotionBlender(VRM1_CAPS, { transitionMs: 400 });
    b.set({ tag: "happy", intensity: 1 }, 0);
    const mid = b.sample(200);
    b.set({ tag: "sad", intensity: 1 }, 200);
    expect(b.sample(200)).toEqual(mid);
    expect(b.sample(800).sad).toBeCloseTo(1, 5);
    expect(b.sample(800).happy ?? 0).toBeCloseTo(0, 5);
  });

  it("weights stay bounded across a long random sequence", () => {
    const b = new EmotionBlender();
    let t = 0;
    for (let i = 0; i < 200; i++) {
      const tag = EmotionTag.options[i % EmotionTag.options.length]!;
      b.set({ tag, intensity: ((i * 37) % 100) / 100 }, t);
      for (let k = 0; k < 5; k++) {
        t += 73;
        const w = b.sample(t);
        for (const v of Object.values(w)) expect(v).toBeLessThanOrEqual(1.000001);
        expect(sum(w)).toBeGreaterThan(0);
      }
    }
  });
});

describe("the reply schema drives this (no second LLM call)", () => {
  it("rejects a companion reply without `emotion`, accepts one with it", () => {
    expect(CompanionReply.safeParse({ v: 1, say: "¡Hola!" }).success).toBe(false);
    const ok = CompanionReply.safeParse({ v: 1, say: "¡Hola!", emotion: { tag: "happy", intensity: 0.7 } });
    expect(ok.success).toBe(true);
    if (ok.success) expect(expressionTarget(ok.data.emotion).happy).toBeCloseTo(0.7, 5);
    expect(CompanionReply.safeParse({ v: 1, say: "x", emotion: { tag: "smug", intensity: 1 } }).success).toBe(false);
  });
});
