/**
 * Builds packages/roster from the generated source art (generate-roster.ts): each character's
 * five drawings go through the same image → card pipeline uploads use (magenta keyed out), then
 * the PWA/app icons are cut from Chalito's neutral card.
 *
 *   pnpm --filter @chalito/avatar-jobs roster:build <rawDir>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { keyBackground, makeCard } from "../src/process.js";
import { CHARACTERS, COSMETICS, EMOTIONS } from "./generate-roster.js";

const ROSTER = fileURLToPath(new URL("../../../packages/roster/", import.meta.url));

const main = async () => {
  const raw = process.argv[2];
  if (!raw) throw new Error("usage: build-roster.ts <rawDir>");
  for (const id of Object.keys(CHARACTERS)) {
    const drawings = ["neutral", ...Object.keys(EMOTIONS)].map((emotion) => ({
      emotion,
      bytes: readFileSync(join(raw, `${id}-${emotion}.png`)),
    }));
    const { files } = await makeCard(drawings, { keyBackground: true });
    const dir = join(ROSTER, "assets", id);
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f.name), f.bytes);
    process.stdout.write(`${id}: ${files.length} files\n`);
  }
  // Icons: Chalito's head and shoulders (a full body is too small at icon sizes) on warm cream,
  // which stands out from the teal hoodie. The maskable icon keeps inside the 80 % safe zone.
  const icons = join(ROSTER, "icons");
  mkdirSync(icons, { recursive: true });
  const layer = sharp(readFileSync(join(ROSTER, "assets", "chalito", "layer-neutral.webp")));
  const { width = 1, height = 1 } = await layer.metadata();
  const bust = await layer.extract({ left: 0, top: 0, width, height: Math.round(height * 0.58) }).toBuffer();
  const cream = { r: 0xff, g: 0xf4, b: 0xe0, alpha: 1 };
  const icon = async (size: number, inner: number) => {
    const figure = await sharp(bust)
      .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toBuffer();
    return sharp({ create: { width: size, height: size, channels: 4, background: cream } })
      .composite([{ input: figure, gravity: "centre" }])
      .png()
      .toBuffer();
  };
  writeFileSync(join(icons, "icon-192.png"), await icon(192, 168));
  writeFileSync(join(icons, "icon-512.png"), await icon(512, 448));
  writeFileSync(join(icons, "icon-maskable-512.png"), await icon(512, 360));
  writeFileSync(join(icons, "apple-touch-icon.png"), await icon(180, 158));
  writeFileSync(join(icons, "favicon-32.png"), await icon(32, 30));
  process.stdout.write("icons: 5 files\n");

  // Cosmetics: keyed, cropped to the object, 512 px WebP.
  const cos = join(ROSTER, "cosmetics");
  mkdirSync(cos, { recursive: true });
  for (const id of Object.keys(COSMETICS)) {
    const { data, info } = await sharp(readFileSync(join(raw, `cosmetic-${id}.png`)))
      .resize(1024, 1024, { fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const keyed = keyBackground({ data, width: info.width, height: info.height });
    const out = await sharp(keyed.data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .trim({ threshold: 1 })
      .resize(512, 512, { fit: "inside" })
      .webp({ quality: 88, alphaQuality: 90 })
      .toBuffer();
    writeFileSync(join(cos, `${id}.webp`), out);
  }
  process.stdout.write(`cosmetics: ${Object.keys(COSMETICS).length} files\n`);
};

void main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
