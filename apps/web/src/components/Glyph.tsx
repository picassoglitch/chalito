"use client";
import { useEffect, useRef, useState } from "react";
import { GlyphDecoder, renderGlyphFrames } from "@chalito/glyph";
import type { GlyphPayload } from "@chalito/protocol";

/** Same pace as the desktop panel's ring; the decoder assembles frames in any order. */
const FRAME_MS = 250;

/** The animated ring a trusted device scans (ADR 0007). It loops its frames; the scanner assembles them. */
export const GlyphCanvas = ({ glyph, size = 240, label }: { glyph: GlyphPayload; size?: number; label: string }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    let frames: ImageData[];
    try {
      frames = renderGlyphFrames(glyph, size).map(
        (f) => new ImageData(new Uint8ClampedArray(f.data), f.width, f.height),
      );
    } catch {
      return;
    }
    if (!frames.length) return;
    let i = 0;
    ctx.putImageData(frames[0]!, 0, 0);
    // The ring carries data in every frame: it keeps animating even with reduced motion.
    const t = setInterval(() => ctx.putImageData(frames[(i = (i + 1) % frames.length)]!, 0, 0), FRAME_MS);
    return () => clearInterval(t);
  }, [glyph, size]);
  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      role="img"
      aria-label={label}
      data-testid="endorse-glyph"
      className="rounded-full"
    />
  );
};

export type ScanState = "starting" | "scanning" | "denied" | "unavailable";

/**
 * Camera side: samples the video into a canvas and feeds the decoder until a payload comes out.
 * Returns the raw payload; resolveForEndorsement verifies it (signature, purpose, time).
 */
export const GlyphScanner = ({
  onPayload,
  labels,
}: {
  onPayload: (payload: unknown) => void;
  labels: Record<ScanState, string>;
}) => {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<ScanState>("starting");
  const done = useRef(onPayload);
  done.current = onPayload;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let alive = true;
    const decoder = new GlyphDecoder();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia || !ctx) return setState("unavailable");
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } catch {
        return alive && setState("denied");
      }
      if (!alive || !video.current) return stream.getTracks().forEach((t) => t.stop());
      video.current.srcObject = stream;
      await video.current.play().catch(() => undefined);
      setState("scanning");
      const tick = () => {
        const v = video.current;
        if (!alive || !v) return;
        // A centred square crop: the ring fills most of the viewfinder.
        const side = Math.min(v.videoWidth, v.videoHeight);
        if (side > 0) {
          const n = Math.min(side, 320);
          canvas.width = canvas.height = n;
          ctx.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, n, n);
          const img = ctx.getImageData(0, 0, n, n);
          const payload = decoder.pushImage(img);
          if (payload) return done.current(payload);
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="grid gap-2">
      <video ref={video} muted playsInline className="aspect-square w-full max-w-xs rounded-xl bg-black object-cover" />
      <p aria-live="polite" className="text-sm text-neutral-600">
        {labels[state]}
      </p>
    </div>
  );
};
