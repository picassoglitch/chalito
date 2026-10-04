import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generateBoxKeyPair, generateSigningKeyPair, randomNonce, toB64url } from "@chalito/crypto";
import type { GlyphPayload } from "@chalito/protocol";
import {
  FrameAssembler,
  GlyphDecoder,
  decodePayload,
  encodeFrames,
  encodePayload,
  generateShortCode,
  glyphFrames,
  hashShortCode,
  normalizeShortCode,
  renderFrame,
  sampleFrame,
  signGlyph,
  verifyGlyph,
} from "../src/index.js";

const now = 1_790_000_000_000;

const makeGlyph = async (label = "Laptop de Aldo", opts: { box?: boolean; ttl?: number } = {}) => {
  const keys = await generateSigningKeyPair();
  const box = opts.box ? await generateBoxKeyPair() : null;
  const g = await signGlyph(
    {
      v: 1,
      purpose: "pair_device",
      codeId: "c0dE_" + (await randomNonce()),
      issuerPubSign: await toB64url(keys.publicKey),
      ...(box ? { issuerPubBox: await toB64url(box.publicKey) } : {}),
      label,
      issuedAt: now,
      expiresAt: now + (opts.ttl ?? 5 * 60_000),
      nonce: await randomNonce(),
    },
    keys.secretKey,
  );
  return { g, keys };
};

describe("payload codec", () => {
  it("round-trips, including unicode labels and optional box key", async () => {
    for (const [label, box] of [
      ["Laptop de Aldo", false],
      ["🐻 Osito · دب", true],
      ["", false],
    ] as const) {
      const { g } = await makeGlyph(label, { box });
      const bytes = encodePayload(g);
      expect(bytes.length).toBeLessThan(260);
      expect(decodePayload(bytes)).toEqual(g);
    }
  });
  it("rejects truncated bytes", async () => {
    const { g } = await makeGlyph();
    expect(() => decodePayload(encodePayload(g).slice(0, -1))).toThrow();
  });
});

describe("fountain frames", () => {
  // A camera sees many loops (~1.2 s each); with 30% random loss a chunk can miss a few
  // loops in a row, so the bound is 10 loops (P(all-dropped) per chunk ≈ 0.3^10).
  it("recovers the payload with lost frames, in any order, across loops", async () => {
    const { g } = await makeGlyph();
    const payload = encodePayload(g);
    const loop = encodeFrames(payload);
    await fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 }), (seed) => {
        let x = seed || 1;
        const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        const asm = new FrameAssembler();
        const start = Math.floor(rnd() * loop.length);
        for (let i = 0; i < loop.length * 10; i++) {
          if (rnd() < 0.3) continue; // 30% of frames dropped
          const out = asm.push(loop[(start + i) % loop.length]!);
          if (out) {
            expect(out).toEqual(payload);
            return;
          }
        }
        throw new Error("did not complete in 10 loops");
      }),
      { numRuns: 100 },
    );
  });

  it("ignores corrupted frames (CRC)", async () => {
    const { g } = await makeGlyph();
    const loop = encodeFrames(encodePayload(g));
    const bad = loop[0]!.slice();
    bad[5]! ^= 0xff;
    const asm = new FrameAssembler();
    expect(asm.push(bad)).toBeNull();
    expect(asm.progress).toBe(0);
  });
});

describe("render → sample", () => {
  const addNoise = (img: ReturnType<typeof renderFrame>, amp: number, seed: number) => {
    let x = seed || 7;
    for (let i = 0; i < img.data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        img.data[i + c] = img.data[i + c]! + ((x / 0x7fffffff) * 2 - 1) * amp;
      }
    }
    return img;
  };

  it("decodes every frame at several scales, rotations and noise levels", async () => {
    const { g } = await makeGlyph("🐻 Osito");
    const frames = glyphFrames(g);
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(120, 200, 320),
        fc.double({ min: 0, max: 359.9, noNaN: true }),
        fc.constantFrom(0, 25, 50),
        fc.integer({ min: 1, max: 1e6 }),
        async (size, rot, noise, seed) => {
          const decoder = new GlyphDecoder();
          let result: GlyphPayload | null = null;
          for (const f of frames) {
            result = decoder.pushImage(addNoise(renderFrame(f, size, { rotationDeg: rot }), noise, seed)) ?? result;
          }
          expect(result).toEqual(g);
        },
      ),
      { numRuns: 12 },
    );
  }, 60_000);

  it("a single frame survives the round trip bit-exact", async () => {
    const { g } = await makeGlyph();
    const f = glyphFrames(g)[0]!;
    expect(sampleFrame(renderFrame(f, 160, { rotationDeg: 33 }))).toEqual(f);
  });
});

describe("verification", () => {
  it("accepts a fresh, correctly signed payload", async () => {
    const { g } = await makeGlyph();
    expect(await verifyGlyph(g, now + 1000)).toEqual({ ok: true });
  });
  it("rejects tampering, expiry and over-long pairing TTLs", async () => {
    const { g } = await makeGlyph();
    expect(await verifyGlyph({ ...g, body: { ...g.body, label: "Otro" } }, now)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await verifyGlyph(g, now + 5 * 60_000)).toEqual({ ok: false, reason: "expired" });
    const { keys } = await makeGlyph();
    const long = await signGlyph(
      { ...g.body, issuerPubSign: await toB64url(keys.publicKey), expiresAt: now + 6 * 60_000 },
      keys.secretKey,
    );
    expect(await verifyGlyph(long, now)).toEqual({ ok: false, reason: "ttl_too_long" });
  });
});

describe("short codes", () => {
  it("generates well-formed codes and normalises user input", async () => {
    const code = await generateShortCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(normalizeShortCode(code.toLowerCase().replace("-", " "))).toBe(code);
    expect(normalizeShortCode("abcd-efgo")).toBe("ABCD-EFG0");
    expect(normalizeShortCode("short")).toBeNull();
  });
  it("hashes deterministically", async () => {
    expect(await hashShortCode("ABCD-EFGH")).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashShortCode("ABCD-EFGH")).toBe(await hashShortCode("ABCD-EFGH"));
  });
});
