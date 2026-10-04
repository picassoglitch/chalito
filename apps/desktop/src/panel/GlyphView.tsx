import { useEffect, useMemo, useRef } from "react";
import { renderGlyphFrames } from "@chalito/glyph";
import { GlyphPayload } from "@chalito/protocol";

const SIZE = 240;
const FRAME_MS = 250;

/**
 * The `endorse_client` glyph this device signed over its code, for the trusted phone's camera.
 * A payload spans several frames: they cycle (the phone's decoder assembles them in any order).
 */
export const GlyphView = ({ glyph, label }: { glyph: unknown; label: string }) => {
  const frames = useMemo(() => {
    const g = GlyphPayload.safeParse(glyph);
    return g.success ? renderGlyphFrames(g.data, SIZE) : [];
  }, [glyph]);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx || !frames.length) return;
    let i = 0;
    const draw = () => {
      const f = frames[i++ % frames.length]!;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), 0, 0);
    };
    draw();
    if (frames.length < 2) return;
    const id = setInterval(draw, FRAME_MS);
    return () => clearInterval(id);
  }, [frames]);
  if (!frames.length) return null;
  return (
    <canvas
      ref={canvas}
      className="glyph"
      width={SIZE}
      height={SIZE}
      role="img"
      aria-label={label}
      data-frames={frames.length}
    />
  );
};
