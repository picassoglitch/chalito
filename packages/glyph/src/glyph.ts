import { PAIRING_TTL_MS, type GlyphPayload } from "@chalito/protocol";
import { fromB64url, signDetached, verifyDetached } from "@chalito/crypto";
import { decodePayload, encodePayload } from "./codec.js";
import { FrameAssembler, encodeFrames } from "./frames.js";
import { renderFrame, type RenderOptions, type RgbaImage } from "./render.js";
import { sampleFrame } from "./sample.js";

export const signGlyph = async (body: GlyphPayload["body"], secretKey: Uint8Array): Promise<GlyphPayload> => ({
  body,
  sig: await signDetached("chalito.glyph.v1", body, secretKey),
});

export type GlyphCheck =
  { ok: true } | { ok: false; reason: "bad_signature" | "expired" | "not_yet_valid" | "ttl_too_long" };

/** Signature by the embedded issuer key + time window. Fingerprint confirmation is the human's job. */
export const verifyGlyph = async (g: GlyphPayload, now: number, skewMs = 60_000): Promise<GlyphCheck> => {
  if (g.body.issuedAt > now + skewMs) return { ok: false, reason: "not_yet_valid" };
  if (g.body.expiresAt <= now) return { ok: false, reason: "expired" };
  if (g.body.purpose === "pair_device" && g.body.expiresAt - g.body.issuedAt > PAIRING_TTL_MS) {
    return { ok: false, reason: "ttl_too_long" };
  }
  const ok = await verifyDetached("chalito.glyph.v1", g.body, g.sig, await fromB64url(g.body.issuerPubSign));
  return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
};

/** One loop of frames for the animated ring. */
export const glyphFrames = (g: GlyphPayload): Uint8Array[] => encodeFrames(encodePayload(g));

export const renderGlyphFrames = (g: GlyphPayload, size: number, opts?: RenderOptions): RgbaImage[] =>
  glyphFrames(g).map((f) => renderFrame(f, size, opts));

/** Camera-side decoder: feed images until it returns the payload. */
export class GlyphDecoder {
  readonly #frames = new FrameAssembler();

  pushImage(img: RgbaImage): GlyphPayload | null {
    return this.pushFrame(sampleFrame(img));
  }

  pushFrame(frame: Uint8Array): GlyphPayload | null {
    const bytes = this.#frames.push(frame);
    if (!bytes) return null;
    try {
      return decodePayload(bytes);
    } catch {
      this.#frames.reset();
      return null;
    }
  }

  get progress(): number {
    return this.#frames.progress;
  }
}
