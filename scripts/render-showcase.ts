/**
 * Real renders for the Solo landing (brief §5 M13): the actual runtime (AvatarDriver +
 * CreatureBinding + the card avatar from @chalito/avatar-three, the @chalito/roster cards and
 * catalog.yaml cosmetics) in headless Chromium with the software renderer (SwiftShader) and pinned
 * seeds. Writes apps/web/public/showcase/*.webp (+ a poster per animated scene) and manifest.json.
 *
 *   pnpm render-showcase           render and write the files
 *   pnpm check-showcase            render to a temp dir and compare with what's committed, with a
 *                                  pixel tolerance (exit 1 on drift; the fresh renders are left in
 *                                  $SHOWCASE_OUT or a temp dir for CI to upload)
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import sharp from "sharp";
import { loadCatalog } from "@chalito/config";
import { placeOnCard, type CardAnchor, type CardPlacement } from "@chalito/roster";
import type { CosmeticSlot } from "@chalito/protocol";
import type { PageActor, PageJob } from "./showcase/page.js";
import { bundle, launchSoftwareGl, serve } from "./showcase/browser.js";
import { SCENES, type Scene } from "./showcase/scenes.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROSTER_DIR = join(ROOT, "packages/roster");
const OUT_DIR = join(ROOT, "apps/web/public/showcase");
/** Simulation step: every scene is stepped from t = 0 at this rate, whatever it captures. */
const STEP_MS = 1000 / 60;
/** Room scenes run on a fixed epoch (a wander-bucket boundary), so the seeded wander is pinned too. */
const ROOM_BASE_MS = 1_760_000_016_000;
/** Tolerance for --check: a pixel differs if any channel is off by more than this… */
const CHANNEL_TOLERANCE = 0.1;
/** …and a render drifts if more than this share of its pixels differ. */
const MAX_DIFF_RATIO = 0.005;

export interface ManifestAsset {
  id: string;
  kind: "still" | "animated";
  file: string;
  poster?: string;
  w: number;
  h: number;
  fps?: number;
  frames?: number;
  seed: number;
  sha256: string;
  posterSha256?: string;
  alt: { es: string; en: string };
  actors: { roster: string; cosmetics: string[] }[];
}
export interface Manifest {
  v: 1;
  generator: "scripts/render-showcase.ts";
  renderer: string;
  /** The commit the renders were made from. */
  source: string;
  assets: ManifestAsset[];
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const commit = () => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

// ---------------------------------------------------------------- inputs → page jobs
interface CardJson {
  width: number;
  height: number;
  shadow?: PageActor["spec"]["shadow"];
  emotions: { src: Record<string, string> };
  anchors: Record<string, CardAnchor>;
}

const jobFor = async (s: Scene): Promise<PageJob> => {
  const catalog = loadCatalog();
  const actors: PageActor[] = [];
  for (const a of s.actors) {
    const card = JSON.parse(readFileSync(join(ROSTER_DIR, "assets", a.roster, "card.json"), "utf8")) as CardJson;
    const items: PageActor["items"] = [];
    for (const id of a.cosmetics ?? []) {
      const c = (
        catalog.cosmetics as Record<
          string,
          { slot: string; art: string; card: { width: number; pivot: [number, number] } }
        >
      )[id];
      if (!c) throw new Error(`unknown cosmetic ${id}`);
      const anchor = card.anchors[c.slot];
      if (!anchor) throw new Error(`${a.roster} has no ${c.slot} anchor`);
      const meta = await sharp(join(ROSTER_DIR, c.art)).metadata();
      const placed = placeOnCard(anchor, c.card, meta.height! / meta.width!, card.height / card.width);
      items.push({ url: `/roster/${c.art}`, placed });
    }
    actors.push({
      x: a.x ?? 0,
      spec: { width: card.width, height: card.height, ...(card.shadow ? { shadow: card.shadow } : {}) },
      drawings: Object.fromEntries(
        Object.entries(card.emotions.src).map(([k, f]) => [k, `/roster/assets/${a.roster}/${f}`]),
      ),
      items,
      beats: a.beats ?? [],
    });
  }
  if (!s.room) return { w: s.w, h: s.h, seed: s.seed, actors };
  // Room scenes: RoomScene loads the cards itself; it needs ids, avatars and catalog placements.
  const id = (i: number) => `chl_showcase${String.fromCharCode(97 + i).repeat(18)}`;
  const cosmetics = catalog.cosmetics as Record<string, { slot: CosmeticSlot; art: string; card: CardPlacement }>;
  return {
    w: s.w,
    h: s.h,
    seed: s.seed,
    actors: [],
    room: {
      roomId: s.room.roomId,
      base: ROOM_BASE_MS,
      members: s.actors.map((a, i) => ({
        companionId: id(i),
        avatar: a.roster,
        cosmetics: (a.cosmetics ?? []).map((c) => ({
          slot: cosmetics[c]!.slot,
          art: cosmetics[c]!.art,
          card: cosmetics[c]!.card,
        })),
      })),
      events: s.room.events.map((e) => ({
        eid: e.eid,
        fromCompanionId: id(e.from),
        to: e.to.map(id),
        kind: e.kind,
        t: ROOM_BASE_MS + e.at,
      })),
    },
  };
};

// ---------------------------------------------------------------- render
interface Rendered {
  scene: Scene;
  /** Captured frames (PNG): one for stills; every frame for animations. */
  frames: Buffer[];
  poster: Buffer;
}

const renderAll = async (scenes: Scene[]): Promise<Rendered[]> => {
  const bundled = await bundle(join(ROOT, "scripts/showcase/page.ts"));
  const { server, url } = await serve(bundled, ROSTER_DIR);
  const browser = await launchSoftwareGl();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 800, height: 800 } });
    await page.goto(url);
    const out: Rendered[] = [];
    for (const s of scenes) {
      await page.evaluate(
        async (job) => (window as never as { __showcase: { load(j: unknown): Promise<void> } }).__showcase.load(job),
        await jobFor(s),
      );
      const captureAt = s.anim
        ? Array.from(
            { length: Math.round((s.anim.durationMs * s.anim.fps) / 1000) },
            (_, i) => (i * 1000) / s.anim!.fps,
          )
        : [];
      const want = new Set([...captureAt.map((t) => Math.round(t)), Math.round(s.posterAt)]);
      const end = Math.max(...want);
      const shots = new Map<number, Buffer>();
      // Step from 0 at a fixed rate; render (and read back) only at the captured times.
      const times: number[] = [];
      for (let t = 0; t <= end + 0.5; t += STEP_MS) times.push(t);
      for (const w of want) if (!times.some((t) => Math.round(t) === w)) times.push(w);
      times.sort((a, b) => a - b);
      for (const t of times) {
        const capture = want.has(Math.round(t)) && !shots.has(Math.round(t));
        const data = await page.evaluate(
          ({ t, capture }) => {
            const sc = (window as never as { __showcase: { frame(t: number): string } }).__showcase;
            const png = sc.frame(t);
            return capture ? png : null;
          },
          { t, capture },
        );
        if (data) shots.set(Math.round(t), Buffer.from(data.split(",")[1]!, "base64"));
      }
      out.push({
        scene: s,
        frames: s.anim ? captureAt.map((t) => shots.get(Math.round(t))!) : [shots.get(Math.round(s.posterAt))!],
        poster: shots.get(Math.round(s.posterAt))!,
      });
      process.stdout.write(`rendered ${s.id}\n`);
    }
    return out;
  } finally {
    await browser.close();
    server.close();
  }
};

// ---------------------------------------------------------------- encode + manifest
const WEBP = { quality: 75, effort: 6, alphaQuality: 85 } as const;

const encode = async (r: Rendered) => {
  const { scene: s } = r;
  if (!s.anim) return { file: await sharp(r.frames[0]!).webp(WEBP).toBuffer() };
  const delay = Math.round(1000 / s.anim.fps);
  const file = await sharp(r.frames, { join: { animated: true } })
    .webp({ ...WEBP, loop: 0, delay: r.frames.map(() => delay) })
    .toBuffer();
  const poster = await sharp(r.poster).webp(WEBP).toBuffer();
  return { file, poster };
};

const write = async (rendered: Rendered[], dir: string): Promise<Manifest> => {
  mkdirSync(dir, { recursive: true });
  const assets: ManifestAsset[] = [];
  for (const r of rendered) {
    const s = r.scene;
    const { file, poster } = await encode(r);
    writeFileSync(join(dir, `${s.id}.webp`), file);
    if (poster) writeFileSync(join(dir, `${s.id}-poster.webp`), poster);
    assets.push({
      id: s.id,
      kind: s.anim ? "animated" : "still",
      file: `showcase/${s.id}.webp`,
      ...(poster ? { poster: `showcase/${s.id}-poster.webp` } : {}),
      w: s.w,
      h: s.h,
      ...(s.anim ? { fps: s.anim.fps, frames: r.frames.length } : {}),
      seed: s.seed,
      sha256: sha256(file),
      ...(poster ? { posterSha256: sha256(poster) } : {}),
      alt: s.alt,
      actors: s.actors.map((a) => ({ roster: a.roster, cosmetics: a.cosmetics ?? [] })),
    });
  }
  const manifest: Manifest = {
    v: 1,
    generator: "scripts/render-showcase.ts",
    renderer: "chromium (headless) + SwiftShader, three r186",
    source: commit(),
    assets,
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
};

// ---------------------------------------------------------------- check
/** Fraction of pixels that differ beyond the tolerance (all frames of an animation). */
const diffRatio = async (a: string, b: string): Promise<number> => {
  const raw = async (f: string) => sharp(f, { pages: -1 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [x, y] = await Promise.all([raw(a), raw(b)]);
  if (x.info.width !== y.info.width || x.info.height !== y.info.height) return 1;
  const n = pixelmatch(x.data, y.data, undefined, x.info.width, x.info.height, { threshold: CHANNEL_TOLERANCE });
  return n / (x.info.width * x.info.height);
};

export const checkAgainst = async (committedDir: string, freshDir: string): Promise<string[]> => {
  const problems: string[] = [];
  const committed = JSON.parse(readFileSync(join(committedDir, "manifest.json"), "utf8")) as Manifest;
  const fresh = JSON.parse(readFileSync(join(freshDir, "manifest.json"), "utf8")) as Manifest;
  const strip = (m: Manifest) => m.assets.map(({ sha256: _a, posterSha256: _b, ...rest }) => rest);
  if (JSON.stringify(strip(committed)) !== JSON.stringify(strip(fresh)))
    problems.push("manifest entries differ (scenes, sizes, frames, seeds, alt or actors): run pnpm render-showcase");
  for (const a of fresh.assets) {
    for (const f of [a.file, a.poster].filter((x): x is string => !!x)) {
      const name = f.replace(/^showcase\//, "");
      const c = join(committedDir, name);
      if (!existsSync(c)) {
        problems.push(`${name}: missing from the committed showcase`);
        continue;
      }
      const ratio = await diffRatio(c, join(freshDir, name));
      if (ratio > MAX_DIFF_RATIO) problems.push(`${name}: ${(ratio * 100).toFixed(2)}% of pixels differ`);
    }
  }
  return problems;
};

const main = async () => {
  const check = process.argv.includes("--check");
  const rendered = await renderAll(SCENES);
  if (!check) {
    const m = await write(rendered, OUT_DIR);
    process.stdout.write(`wrote ${m.assets.length} assets to ${OUT_DIR}\n`);
    return;
  }
  const fresh = process.env.SHOWCASE_OUT ?? mkdtempSync(join(tmpdir(), "chalito-showcase-"));
  await write(rendered, fresh);
  const problems = await checkAgainst(OUT_DIR, fresh);
  if (problems.length) {
    process.stderr.write(
      `showcase drifted (fresh renders in ${fresh}):\n${problems.map((p) => `  - ${p}`).join("\n")}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`showcase matches the committed renders (${SCENES.length} scenes)\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
