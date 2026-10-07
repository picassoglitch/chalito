/**
 * Builds packages/roster from the generated source art (generate-roster.ts): each catalog
 * character's five drawings go through the same image → card pipeline uploads use (magenta keyed
 * out), then the PWA/app icons are cut from Chalito's neutral card. Characters (and cosmetics)
 * whose raw files aren't all in <rawDir> yet are skipped with a warning, so partial builds work;
 * their existing assets, if any, are left as they are.
 *
 *   pnpm --filter @chalito/avatar-jobs roster:build <rawDir>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { keyBackground, makeCard } from "../src/process.js";
import { CHARACTERS, COSMETICS, EMOTIONS } from "./generate-roster.js";

const ROSTER = fileURLToPath(new URL("../../../packages/roster/", import.meta.url));

const main = async () => {
  const raw = process.argv[2];
  if (!raw) throw new Error("usage: build-roster.ts <rawDir>");
  const skipped: string[] = [];
  let built = 0;
  for (const id of Object.keys(CHARACTERS)) {
    const emotions = ["neutral", ...Object.keys(EMOTIONS)];
    const missing = emotions.filter((e) => !existsSync(join(raw, `${id}-${e}.png`)));
    if (missing.length) {
      skipped.push(id);
      process.stderr.write(`warning: ${id}: no ${missing.join(", ")} drawing(s) in ${raw}, skipped\n`);
      continue;
    }
    const drawings = emotions.map((emotion) => ({ emotion, bytes: readFileSync(join(raw, `${id}-${emotion}.png`)) }));
    const { files, manifest } = await makeCard(drawings, { keyBackground: true });
    const dir = join(ROSTER, "assets", id);
    mkdirSync(dir, { recursive: true });
    // The neck is detected per character (detect-wear-anchors.ts), not derived: keep a detected one
    // from the previous build, else leave it missing for that script to fill.
    const prev = join(dir, "card.json");
    const detected = existsSync(prev)
      ? (JSON.parse(readFileSync(prev, "utf8")) as { anchors?: { neck?: unknown } }).anchors?.neck
      : undefined;
    const { neck: _derived, ...anchors } = manifest.anchors;
    const card = { ...manifest, anchors: { ...anchors, ...(detected ? { neck: detected } : {}) } };
    for (const f of files) {
      const bytes = f.name === "card.json" ? Buffer.from(JSON.stringify(card, null, 2)) : f.bytes;
      writeFileSync(join(dir, f.name), bytes);
    }
    process.stdout.write(`${id}: ${files.length} files\n`);
    built++;
  }
  process.stdout.write(`characters: ${built} built, ${skipped.length} skipped\n`);
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
  let cosmetics = 0;
  for (const id of Object.keys(COSMETICS)) {
    const src = join(raw, `cosmetic-${id}.png`);
    if (!existsSync(src)) {
      process.stderr.write(`warning: cosmetic ${id}: no ${src}, skipped\n`);
      continue;
    }
    const { data, info } = await sharp(readFileSync(src))
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
    cosmetics++;
  }
  process.stdout.write(`cosmetics: ${cosmetics} files\n`);
};

void main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
