import { describe, expect, it } from "vitest";
import { concat, downsample, wav } from "../src/lib/offline-voice/audio.js";
import { createEndpointer, rms, type EndReason } from "../src/lib/offline-voice/vad.js";

const RATE = 48_000;
const FRAME = 2048;
const FRAME_MS = (FRAME / RATE) * 1000;

/** A seeded PRNG so the "room" is the same on every run. */
const prng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

/** Room-like audio: hum + hiss, with speech as voiced syllables (a pitch and two formants under an envelope). */
const room = (
  segments: { ms: number; speech: boolean }[],
  opts: { hum?: number; hiss?: number; voice?: number } = {},
) => {
  const rand = prng(7);
  const { hum = 0.01, hiss = 0.006, voice = 0.25 } = opts;
  const out: number[] = [];
  let t = 0;
  for (const seg of segments) {
    const n = Math.round((seg.ms / 1000) * RATE);
    for (let i = 0; i < n; i++, t++) {
      const s = t / RATE;
      let x = hum * Math.sin(2 * Math.PI * 60 * s) + hiss * (rand() * 2 - 1);
      if (seg.speech) {
        const syl = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i % 9600)) / 9600); // ~5 syllables a second
        const f0 = 140 + 20 * Math.sin(2 * Math.PI * 2 * s);
        x +=
          voice *
          syl *
          (0.6 * Math.sin(2 * Math.PI * f0 * s) +
            0.3 * Math.sin(2 * Math.PI * 700 * s) +
            0.1 * Math.sin(2 * Math.PI * 1200 * s));
      }
      out.push(x);
    }
  }
  return new Float32Array(out);
};

/** Feeds audio frame by frame the way the mic hands it over; returns why it stopped and when. */
const listen = (pcm: Float32Array, opts?: Parameters<typeof createEndpointer>[0]) => {
  const ep = createEndpointer(opts);
  for (let at = 0; at + FRAME <= pcm.length; at += FRAME) {
    const end: EndReason | null = ep.push(rms(pcm.subarray(at, at + FRAME)), FRAME_MS);
    if (end) return { end, atMs: ((at + FRAME) / RATE) * 1000, ep };
  }
  return { end: null, atMs: (pcm.length / RATE) * 1000, ep };
};

/** A frame with exactly this loudness. */
const level = (l: number, n = 160) => Float32Array.from({ length: n }, (_, i) => (i % 2 ? l : -l));

describe("VAD: end of speech over a learned noise floor", () => {
  it("rms of silence, of a square wave, and of nothing", () => {
    expect(rms(new Float32Array(10))).toBe(0);
    expect(rms(level(0.3))).toBeCloseTo(0.3, 6);
    expect(rms(new Float32Array(0))).toBe(0);
  });

  it("learns the room from the first 250 ms", () => {
    const { ep } = listen(room([{ ms: 400, speech: false }]));
    // The floor is the room's own loudness, well under the speech threshold.
    expect(ep.floor).toBeGreaterThan(0.004);
    expect(ep.floor).toBeLessThan(0.02);
    expect(ep.spoke).toBe(false);
  });

  it("ends after the person stops talking, not while they talk", () => {
    const pcm = room([
      { ms: 300, speech: false },
      { ms: 1500, speech: true },
      { ms: 2000, speech: false },
    ]);
    const r = listen(pcm, { silenceMs: 1200 });
    expect(r.end).toBe("silence");
    expect(r.ep.spoke).toBe(true);
    // 300 ms room + 1.5 s speech + ~1.2 s quiet; the syllable dips don't end it early.
    expect(r.atMs).toBeGreaterThan(1800 + 1100);
    expect(r.atMs).toBeLessThan(1800 + 1500);
  });

  it("a loud fan is not speech: nothing said ends as 'nothing'", () => {
    const r = listen(room([{ ms: 8000, speech: false }], { hum: 0.08, hiss: 0.04 }), { noSpeechMs: 6000 });
    expect(r.end).toBe("nothing");
    expect(r.atMs).toBeGreaterThanOrEqual(6000);
  });

  it("speech over a loud fan still counts once it's 3x the floor", () => {
    const pcm = room(
      [
        { ms: 300, speech: false },
        { ms: 1000, speech: true },
        { ms: 1600, speech: false },
      ],
      { hum: 0.05, hiss: 0.02, voice: 0.6 },
    );
    expect(listen(pcm).end).toBe("silence");
  });

  it("someone who talks from the first instant isn't learned as the floor for good", () => {
    const pcm = room([
      { ms: 900, speech: true },
      { ms: 400, speech: false },
      { ms: 900, speech: true },
      { ms: 1600, speech: false },
    ]);
    const r = listen(pcm);
    expect(r.ep.spoke).toBe(true);
    expect(r.end).toBe("silence");
  });

  it("caps a long utterance at maxMs", () => {
    const ep = createEndpointer({ maxMs: 1000 });
    let end: EndReason | null = null;
    for (let t = 0; t < 2000 && !end; t += 50) end = ep.push(t < 250 ? 0.005 : 0.5, 50);
    expect(end).toBe("max");
  });

  it("a click shorter than minSpeechMs is not speech", () => {
    const ep = createEndpointer({ noSpeechMs: 1000 });
    const seq = [...Array(5).fill(0.005), 0.5, ...Array(30).fill(0.005)] as number[];
    const ends = seq.map((l) => ep.push(l, 50));
    expect(ep.spoke).toBe(false);
    expect(ends).toContain("nothing");
  });
});

describe("audio for whisper", () => {
  it("concatenates mic chunks in order", () => {
    expect([...concat([Float32Array.of(1, 2), Float32Array.of(3)])]).toEqual([1, 2, 3]);
  });

  it("downsamples 48 kHz to 16 kHz by averaging, keeping the duration", () => {
    const pcm = room([{ ms: 1000, speech: true }]);
    const out = downsample(pcm, 48_000);
    expect(out.length).toBe(16_000);
    expect(downsample(Float32Array.of(0.3, 0.3, 0.3, 0.6, 0.6, 0.6), 48_000)[1]).toBeCloseTo(0.6, 6);
    expect(downsample(pcm, 16_000)).toBe(pcm);
    expect(() => downsample(pcm, 8000)).toThrow(/upsample/);
  });

  it("writes a 16-bit mono WAV whisper.cpp can read", () => {
    const bytes = wav(Float32Array.of(0, 1, -1, 2), 16_000);
    const v = new DataView(bytes.buffer);
    const ascii = (at: number, n: number) => String.fromCharCode(...bytes.subarray(at, at + n));
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 8)).toBe("WAVEfmt ");
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32767, 32767]);
  });
});
