import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { endorseGlyph, generateDeviceKeys } from "@chalito/client-keys";
import { GlyphDecoder, renderGlyphFrames } from "@chalito/glyph";
import { GlyphView } from "../src/panel/GlyphView.js";

afterEach(cleanup);

describe("endorse glyph on the sign-in screen", () => {
  it("renders the signed endorse_client glyph, and what it shows decodes back to it", async () => {
    const keys = await generateDeviceKeys();
    const now = Date.now();
    const glyph = await endorseGlyph(
      keys,
      { codeId: "AbCdEfGhIjKlMnOpQrStUv", expiresAt: now + 300_000 },
      { label: "Chalito (desktop)", now },
    );
    const { container } = render(<GlyphView glyph={glyph} label="Code to scan" />);
    const canvas = container.querySelector("canvas")!;
    expect(canvas.getAttribute("aria-label")).toBe("Code to scan");
    const frames = renderGlyphFrames(glyph, 240);
    expect(Number(canvas.dataset.frames)).toBe(frames.length);
    const d = new GlyphDecoder();
    let decoded = null;
    for (const f of frames) decoded = d.pushImage(f) ?? decoded;
    expect(decoded).toEqual(glyph);
  });

  it("renders nothing for a missing or malformed glyph", () => {
    expect(render(<GlyphView glyph={null} label="x" />).container.innerHTML).toBe("");
    expect(render(<GlyphView glyph={{ body: {} }} label="x" />).container.innerHTML).toBe("");
  });
});
