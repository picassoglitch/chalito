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
import { EMOTIONS, NEUTRAL, STYLE, emotionPrompt } from "../src/style.js";
import { CATALOG } from "./catalog.js";

// The style lives in src/style.ts (custom companions use it too); re-exported for build-roster.ts.
export { EMOTIONS, STYLE };

export const MODEL = "gemini-3.1-flash-image";
const MAX_CALLS = 1200;

export const CHARACTERS: Record<string, string> = {
  chalito:
    "Chalito, a small human-ish companion: a cheerful round-faced kid-like figure in an oversized teal hoodie with the hood down, short messy dark hair, big warm brown eyes, rosy cheeks, a tiny glowing yellow star clip in the hair",
  bruno:
    "Bruno, a chubby honey-brown teddy bear with a cream muzzle and belly patch, small round ears, a little red scarf",
  luna: "Luna, a fluffy grey kitten with big green eyes, white paws and chest, a pink nose, a thin crescent-moon collar charm",
  tito: "Tito, a round little owl with soft brown and cream feathers, huge amber eyes, tiny tufted ears, small wings",
  canela: "Canela, a small orange fox with a white-tipped bushy tail, white chest, dark paws, big curious eyes",
  nube: "Nube, a fluffy white bunny with long floppy ears with pink insides, a pink nose, a round cotton tail, sky-blue eyes",
  // The catalog (catalog.ts) adds the rest; the six above keep their order so their seeds don't change.
  ...Object.fromEntries(CATALOG.map((ch) => [ch.id, ch.prompt])),
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
  // Wearables that fit any body (owner 2026-10-06): neck pieces sit on a detected neck point, back
  // pieces are drawn behind the character. No shirts or suits: an overlay can't follow 220 shapes.
  // Neck (anchors.neck, detected per character by detect-wear-anchors.ts).
  bow_tie: "a single cute bow tie, teal with small white polka dots, front view, nothing else",
  bow_tie_red: "a single cute bow tie, glossy cherry red, front view, nothing else",
  necktie:
    "a short cute necktie with a small knot, navy blue with thin gold diagonal stripes, front view, nothing else",
  bell_collar:
    "a thin red collar band seen straight from the front as a flat gentle smile-shaped curve (not a ring, not seen from above), with a shiny gold jingle bell hanging from the middle, nothing else",
  pearl_necklace: "a short necklace of round white pearls seen from the front as a gentle U-shaped curve, nothing else",
  gold_medal:
    "a round shiny gold medal with a star on it hanging from a short red, white and green ribbon loop, front view, nothing else",
  marigold_necklace:
    "a short necklace of round orange cempasuchil marigold flowers seen from the front as a gentle U-shaped curve, nothing else",
  flower_lei:
    "a short Hawaiian flower lei of pink, white and yellow hibiscus flowers seen from the front as a gentle U-shaped curve, nothing else",
  // Head and face (fixed anchors work for these).
  charro_hat:
    "a small cute Mexican charro sombrero, black with silver embroidery on the wide brim, front view, the hat alone floating, no head, no face, no person",
  crown: "a small cute golden crown with three points and colorful round gems, front view, as worn on a head",
  cap: "a small cute baseball cap, bright blue with a white front panel, front view, the cap alone floating, no head, no face, no person, no logo, no letters",
  party_hat: "a small cone-shaped party hat, pink with yellow polka dots and a fluffy pompom on top, front view",
  flower_headband:
    "a thin arched headband decorated with small pink and white flowers, front view, the headband alone floating, no head, no hair, no face, no person",
  sunglasses:
    "a pair of cute black sunglasses with rounded rectangular lenses and a small shine, front view, nothing else",
  heart_glasses: "a pair of cute heart-shaped glasses with pink tinted lenses, front view, nothing else",
  mustache: "a single big curly dark-brown cartoon mustache, front view, nothing else",
  // Back (drawn behind the character).
  angel_wings: "a pair of small fluffy white angel wings spread open, seen from the front, symmetric, nothing else",
  butterfly_wings:
    "a pair of small translucent butterfly wings, pastel pink and lilac with little spots, spread open, front view, symmetric, nothing else",
  bat_wings: "a pair of small cute purple bat wings spread open, seen from the front, symmetric, nothing else",
  dragon_wings:
    "a pair of small green dragon wings with pale membranes spread open, seen from the front, symmetric, nothing else",
  hero_cape:
    "a short flowing red superhero cape seen from the front as if hanging behind shoulders, the collar at the top, nothing else",
  jetpack:
    "a small cute retro jetpack with two silver rocket tanks side by side and little orange flames at the bottom, seen from the front as if worn on the back, nothing else",
};
const OBJECT_STYLE =
  "Cute sticker-style game item art matching a chibi companion: soft cel shading, clean thick dark-brown outline, warm pastel palette, " +
  "a single centered object with generous margin. Background: a perfectly flat, uniform, solid pure magenta (#FF00FF) fill, edge to edge. No text, no letters, no border, no shadow.";

let calls = 0;

const generate = async (key: string, parts: unknown[], seed: number) => {
  if (++calls > MAX_CALLS) throw new Error(`refusing more than ${MAX_CALLS} generations`);
  const request = () =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["IMAGE"], seed, imageConfig: { aspectRatio: "1:1" } },
      }),
    });
  // A 429 (rate or spend-rate limit) is waited out with backoff; anything else (402 = no credits) stops the run.
  let res = await request();
  for (let wait = 30; res.status === 429 && wait <= 480; wait *= 2) {
    process.stderr.write(`rate limited, waiting ${wait}s\n`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await request();
  }
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
  const allIds = Object.keys(CHARACTERS);
  // A safety block answers with no image: retry once with another seed, then skip (and report) it.
  const skipped: string[] = [];
  const attempt = async (parts: unknown[], seed: number, label: string) => {
    for (const s of [seed, seed + 500]) {
      try {
        return { ...(await generate(key, parts, s)), seed: s };
      } catch (e) {
        if (!(e instanceof Error && e.message === "gemini returned no image")) throw e;
      }
    }
    skipped.push(label);
    process.stderr.write(`skipped ${label}: no image\n`);
    return null;
  };
  for (const id of ids) {
    if (!CHARACTERS[id]) throw new Error(`unknown character ${id}`);
    const seed = 1000 + allIds.indexOf(id);
    const neutralPath = join(outDir, `${id}-neutral.png`);
    if (!existsSync(neutralPath)) {
      const prompt = `${CHARACTERS[id]}. ${NEUTRAL} ${STYLE}`;
      const out = await attempt([{ text: prompt }], seed, `${id}-neutral`);
      if (!out) continue;
      const { bytes, mime } = out;
      writeFileSync(neutralPath, bytes);
      appendFileSync(
        log,
        `${JSON.stringify({ file: `${id}-neutral.png`, model: MODEL, prompt, seed: out.seed, mime, date: new Date().toISOString() })}\n`,
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
      const prompt = emotionPrompt(how);
      const out = await attempt(
        [{ text: prompt }, { inlineData: { mimeType: refMime, data: ref } }],
        seed,
        `${id}-${emotion}`,
      );
      if (!out) continue;
      const { bytes, mime } = out;
      writeFileSync(path, bytes);
      appendFileSync(
        log,
        `${JSON.stringify({ file: `${id}-${emotion}.png`, model: MODEL, prompt, seed: out.seed, reference: `${id}-neutral.png`, mime, date: new Date().toISOString() })}\n`,
      );
      process.stdout.write(`${id} ${emotion}\n`);
    }
  }
  process.stdout.write(`done: ${calls} generations${skipped.length ? `, skipped: ${skipped.join(" ")}` : ""}\n`);
};

if (process.argv[1]?.endsWith("generate-roster.ts"))
  void main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
