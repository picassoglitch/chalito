/**
 * The image model (Google AI Studio, Gemini image generation: generateContent with an IMAGE
 * response), as the roster script calls it (scripts/generate-roster.ts), behind an interface so
 * tests never call it.
 */
export type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

export type ImageResult =
  | { ok: true; bytes: Buffer; mime: string }
  /**
   * `refused`: the model or its safety filters declined (no retry, never billed).
   * `provider`: an error; `retryable` for network errors, 429 and 5xx.
   */
  | { ok: false; kind: "refused" | "provider"; retryable: boolean; detail: string };

export interface ImageModel {
  generate(parts: Part[]): Promise<ImageResult>;
}

/** Finish reasons that mean "declined", not "broken" (Gemini API FinishReason). */
const REFUSED = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "RECITATION",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
  "IMAGE_OTHER",
  "NO_IMAGE",
]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

type GenerateResponse = {
  promptFeedback?: { blockReason?: string };
  candidates?: {
    finishReason?: string;
    content?: { parts?: { text?: string; inlineData?: { data?: string; mimeType?: string } }[] };
  }[];
};

export const geminiImageModel = (o: { apiKey: string; model: string; fetch?: typeof fetch }): ImageModel => ({
  async generate(parts) {
    let res: Response;
    try {
      res = await (o.fetch ?? fetch)(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(o.model)}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": o.apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            // TEXT too, so the model can decline in words (NO_PERSON) instead of drawing something.
            generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1" } },
          }),
          signal: AbortSignal.timeout(120_000),
        },
      );
    } catch (err) {
      return { ok: false, kind: "provider", retryable: true, detail: err instanceof Error ? err.name : "network" };
    }
    if (!res.ok) {
      const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
      return { ok: false, kind: "provider", retryable, detail: `http ${res.status}` };
    }
    const json = (await res.json().catch(() => null)) as GenerateResponse | null;
    if (!json) return { ok: false, kind: "provider", retryable: true, detail: "bad json" };
    if (json.promptFeedback?.blockReason)
      return { ok: false, kind: "refused", retryable: false, detail: `blocked: ${json.promptFeedback.blockReason}` };
    const cand = json.candidates?.[0];
    const img = cand?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
    if (img?.data && IMAGE_TYPES.has(img.mimeType ?? ""))
      return { ok: true, bytes: Buffer.from(img.data, "base64"), mime: img.mimeType! };
    if (cand?.finishReason && REFUSED.has(cand.finishReason))
      return { ok: false, kind: "refused", retryable: false, detail: `finish: ${cand.finishReason}` };
    // No image and no safety reason: the model answered in words (e.g. NO_PERSON). A refusal too.
    return { ok: false, kind: "refused", retryable: false, detail: `no image (${cand?.finishReason ?? "none"})` };
  },
});
