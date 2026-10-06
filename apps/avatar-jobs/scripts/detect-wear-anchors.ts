/**
 * Finds where neck pieces (scarf, bow tie, medal) sit on each built card. The fixed-proportion
 * anchors in process.ts are fine for hats and auras but a neck varies too much across 220 shapes
 * (a chibi kid, a taco, a robot), so a vision model marks it once per character, on the neutral
 * drawing, and the result is written into card.json as anchors.neck (z 2, in front of the body).
 *
 *   GEMINI_API_KEY=… pnpm --filter @chalito/avatar-jobs exec tsx scripts/detect-wear-anchors.ts [ids…]
 *
 * Characters whose card already has anchors.neck are skipped, so reruns only fill gaps.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const MODEL = "gemini-3.1-flash-lite";
const ASSETS = fileURLToPath(new URL("../../../packages/roster/assets/", import.meta.url));

const PROMPT =
  "This is a cartoon character on a transparent background. Find the spot where a scarf or bow tie " +
  "would be worn: the neck, or, if the character has no neck, the point just under the face where head meets body. " +
  'Answer only JSON: {"x": number, "y": number, "width": number}, where x and y are that point as fractions ' +
  "of the image width and height (0 = left/top), and width is how wide the neck/upper body is there, as a fraction of the image width.";

interface Neck {
  x: number;
  y: number;
  width: number;
}

const detect = async (key: string, png: Buffer, w: number, h: number): Promise<Neck> => {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: PROMPT }, { inlineData: { mimeType: "image/png", data: png.toString("base64") } }],
        },
      ],
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const n = JSON.parse(text) as Neck;
  // The model sometimes answers in pixels: bring those back to fractions.
  if (n.x > 1) n.x /= w;
  if (n.y > 1) n.y /= h;
  if (n.width > 1) n.width /= w;
  const ok = (v: unknown, lo: number, hi: number) => typeof v === "number" && v >= lo && v <= hi;
  if (!ok(n.x, 0.1, 0.9) || !ok(n.y, 0.05, 0.9) || !ok(n.width, 0.05, 1)) throw new Error(`implausible answer ${text}`);
  return n;
};

const main = async () => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is required");
  const only = process.argv.slice(2);
  const { ROSTER_IDS } = await import("@chalito/roster");
  for (const id of only.length ? only : ROSTER_IDS) {
    const cardPath = join(ASSETS, id, "card.json");
    if (!existsSync(cardPath)) continue;
    const card = JSON.parse(readFileSync(cardPath, "utf8")) as {
      anchors: Record<string, { x: number; y: number; z: number; w?: number }>;
    };
    if (card.anchors.neck) continue;
    // White behind the figure: transparent pixels confuse the model about the silhouette.
    const layer = sharp(join(ASSETS, id, "layer-neutral.webp"));
    const { width = 1, height = 1 } = await layer.metadata();
    const png = await layer.flatten({ background: "#ffffff" }).png().toBuffer();
    try {
      const n = await detect(key, png, width, height);
      card.anchors.neck = { x: +n.x.toFixed(4), y: +n.y.toFixed(4), z: 2, w: +n.width.toFixed(4) };
      writeFileSync(cardPath, `${JSON.stringify(card, null, 2)}\n`);
      process.stdout.write(`${id} ${JSON.stringify(card.anchors.neck)}\n`);
    } catch (e) {
      process.stderr.write(`${id}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
};

void main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
