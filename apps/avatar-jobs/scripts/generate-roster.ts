/**
 * Generates the free roster's source art with Google AI Studio (Gemini image model), the owner's
 * standing instruction for art. Each character gets a neutral pose; the four emotion variants are
 * edits of that image, so the design stays consistent. Art is drawn on flat magenta, which
 * build-roster.ts keys out to transparency.
 *
 *   GEMINI_API_KEY=… pnpm --filter @chalito/avatar-jobs roster:generate <outDir> [ids…]
 *
 * Every call is appended to <outDir>/provenance.jsonl (model, prompt, date, seed) for
 * docs/ASSET_PROVENANCE.md. Calls are capped (MAX_CALLS) so a rerun can't run away.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MODEL = "gemini-3.1-flash-image";
const MAX_CALLS = 40;

export const STYLE =
  "Cute, friendly chibi character art for an app companion: soft cel shading, clean thick dark-brown outline, warm pastel palette, " +
  "full body, centered, facing the viewer, the whole character visible with generous margin. " +
  "Background: a perfectly flat, uniform, solid pure magenta (#FF00FF) fill, edge to edge. No shadow on the ground, no text, no letters, no border, no frame.";

export const CHARACTERS: Record<string, string> = {
  chalito:
    "Chalito, a small human-ish companion: a cheerful round-faced kid-like figure in an oversized teal hoodie with the hood down, short messy dark hair, big warm brown eyes, rosy cheeks, a tiny glowing yellow star clip in the hair",
  bruno:
    "Bruno, a chubby honey-brown teddy bear with a cream muzzle and belly patch, small round ears, a little red scarf",
  luna: "Luna, a fluffy grey kitten with big green eyes, white paws and chest, a pink nose, a thin crescent-moon collar charm",
  tito: "Tito, a round little owl with soft brown and cream feathers, huge amber eyes, tiny tufted ears, small wings",
  canela: "Canela, a small orange fox with a white-tipped bushy tail, white chest, dark paws, big curious eyes",
  nube: "Nube, a fluffy white bunny with long floppy ears with pink insides, a pink nose, a round cotton tail, sky-blue eyes",
};

export const EMOTIONS: Record<string, string> = {
  happy: "joyful: a big open smile, eyes curved with delight, arms or paws raised a little in excitement",
  sad: "sad: teary glossy eyes, a small frown, shoulders and ears drooping",
  surprised: "surprised: wide round eyes, small open 'o' mouth, hands or paws raised near the face",
  tired: "tired and sleepy: half-closed heavy eyelids, a small yawn, slightly slumped posture",
};

/** Cosmetics (pay-to-dress): single objects, front view, on the same magenta for keying. */
export const COSMETICS: Record<string, string> = {
  viking_hat:
    "a small cute horned Viking helmet, rounded grey metal with two cream horns and a brown leather band, front view",
  flower_crown:
    "a small flower crown of pink, yellow and white daisies with green leaves, front view, as worn on a head",
  round_glasses: "a pair of round dark-brown rimmed glasses with light blue lenses, front view, nothing else",
  star_cape:
    "a small midnight-blue cape covered in tiny gold stars, seen from the front as if draped behind shoulders, the collar at the top",
  sparkle_aura: "a soft glowing ring of pastel sparkles and tiny stars forming an oval halo, airy and light",
  portal_swirl:
    "a flat glowing swirl portal seen from slightly above, teal and violet light ring on the ground with small sparkles",
};
const OBJECT_STYLE =
  "Cute sticker-style game item art matching a chibi companion: soft cel shading, clean thick dark-brown outline, warm pastel palette, " +
  "a single centered object with generous margin. Background: a perfectly flat, uniform, solid pure magenta (#FF00FF) fill, edge to edge. No text, no letters, no border, no shadow.";

let calls = 0;

const generate = async (key: string, parts: unknown[], seed: number) => {
  if (++calls > MAX_CALLS) throw new Error(`refusing more than ${MAX_CALLS} generations`);
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["IMAGE"], seed, imageConfig: { aspectRatio: "1:1" } },
    }),
  });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { data: string; mimeType: string } }[] } }[];
  };
  const img = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!img) throw new Error("gemini returned no image");
  return { bytes: Buffer.from(img.data, "base64"), mime: img.mimeType };
};

const main = async () => {
  const key = process.env.GEMINI_API_KEY;
  const args = process.argv.slice(2);
  const neutralOnly = args.includes("--neutral-only");
  const cosmetics = args.includes("--cosmetics");
  const [outDir, ...only] = args.filter((a) => !a.startsWith("--"));
  if (!key || !outDir) throw new Error("usage: GEMINI_API_KEY=… generate-roster.ts <outDir> [ids…]");
  mkdirSync(outDir, { recursive: true });
  const log = join(outDir, "provenance.jsonl");
  if (cosmetics) {
    for (const [i, [id, what]] of Object.entries(COSMETICS).entries()) {
      if (only.length && !only.includes(id)) continue;
      const path = join(outDir, `cosmetic-${id}.png`);
      if (existsSync(path)) continue;
      const seed = 2000 + i;
      const prompt = `${what}. ${OBJECT_STYLE}`;
      const { bytes, mime } = await generate(key, [{ text: prompt }], seed);
      writeFileSync(path, bytes);
      appendFileSync(
        log,
        `${JSON.stringify({ file: `cosmetic-${id}.png`, model: MODEL, prompt, seed, mime, date: new Date().toISOString() })}\n`,
      );
      process.stdout.write(`cosmetic ${id}\n`);
    }
    process.stdout.write(`done: ${calls} generations\n`);
    return;
  }
  const ids = only.length ? only : Object.keys(CHARACTERS);
  for (const [i, id] of ids.entries()) {
    const seed = 1000 + i;
    const neutralPath = join(outDir, `${id}-neutral.png`);
    if (!existsSync(neutralPath)) {
      const prompt = `${CHARACTERS[id]}. Neutral, calm, gently smiling expression, relaxed standing pose. ${STYLE}`;
      const { bytes, mime } = await generate(key, [{ text: prompt }], seed);
      writeFileSync(neutralPath, bytes);
      appendFileSync(
        log,
        `${JSON.stringify({ file: `${id}-neutral.png`, model: MODEL, prompt, seed, mime, date: new Date().toISOString() })}\n`,
      );
      process.stdout.write(`${id} neutral\n`);
    }
    if (neutralOnly) continue;
    const refBytes = readFileSync(neutralPath);
    const ref = refBytes.toString("base64");
    // The model may answer JPEG whatever the file is called: send the real type back.
    const refMime = refBytes[0] === 0xff && refBytes[1] === 0xd8 ? "image/jpeg" : "image/png";
    for (const [emotion, how] of Object.entries(EMOTIONS)) {
      const path = join(outDir, `${id}-${emotion}.png`);
      if (existsSync(path)) continue;
      const prompt =
        `This exact same character, with an identical design, colors, outline, proportions and art style, the same framing and size, ` +
        `on the same flat pure magenta (#FF00FF) background. Change only the expression and pose to look ${how}. No text, no letters.`;
      const { bytes, mime } = await generate(
        key,
        [{ text: prompt }, { inlineData: { mimeType: refMime, data: ref } }],
        seed,
      );
      writeFileSync(path, bytes);
      appendFileSync(
        log,
        `${JSON.stringify({ file: `${id}-${emotion}.png`, model: MODEL, prompt, seed, reference: `${id}-neutral.png`, mime, date: new Date().toISOString() })}\n`,
      );
      process.stdout.write(`${id} ${emotion}\n`);
    }
  }
  process.stdout.write(`done: ${calls} generations\n`);
};

if (process.argv[1]?.endsWith("generate-roster.ts"))
  void main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
