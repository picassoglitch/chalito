/**
 * Scene AC (brief §5 M11): quality `bajo` renders at ≥ 30 FPS on the CI software renderer.
 * Runs @chalito/scene's RoomScene in headless Chromium + SwiftShader with six companions and
 * checks both what its capped loop delivered and what it can draw (exit 1 below 30).
 *
 *   pnpm scene-perf
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, launchSoftwareGl, serve } from "./showcase/browser.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_FPS = 30;
/** The loop is capped at 30 on a 60 Hz rAF: allow timer jitter on the capped number only. */
const LOOP_SLACK = 0.9;

const main = async () => {
  const { server, url } = await serve(
    await bundle(join(ROOT, "scripts/scene/perf-page.ts")),
    join(ROOT, "packages/roster"),
  );
  const browser = await launchSoftwareGl();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 800, height: 600 } });
    await page.goto(url);
    const r = await page.evaluate(() =>
      (
        window as never as { __perf: { run(q: string, ms: number): Promise<Record<string, number | string>> } }
      ).__perf.run("bajo", 5000),
    );
    process.stdout.write(`scene-perf: ${JSON.stringify(r)}\n`);
    const loop = r.loopFps as number;
    const draw = r.drawFps as number;
    if (r.level !== "bajo" || draw < MIN_FPS || loop < MIN_FPS * LOOP_SLACK) {
      process.stderr.write(
        `scene-perf: bajo must draw ≥ ${MIN_FPS} FPS (loop ${loop.toFixed(1)}, draw ${draw.toFixed(1)})\n`,
      );
      process.exit(1);
    }
  } finally {
    await browser.close();
    server.close();
  }
};

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
