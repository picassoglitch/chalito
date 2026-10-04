/**
 * Re-derives each roster card's anchors from its shipped neutral layer (no regeneration, no API
 * calls): `pnpm --filter @chalito/avatar-jobs exec tsx scripts/reanchor-roster.ts`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { anchorsFor } from "../src/process.js";

const assets = fileURLToPath(new URL("../../../packages/roster/assets/", import.meta.url));
for (const id of ["chalito", "bruno", "luna", "tito", "canela", "nube"]) {
  const { data, info } = await sharp(`${assets}${id}/layer-neutral.webp`)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cardPath = `${assets}${id}/card.json`;
  const card = JSON.parse(readFileSync(cardPath, "utf8")) as { anchors: Record<string, unknown> };
  card.anchors = anchorsFor({ data, width: info.width, height: info.height });
  writeFileSync(cardPath, `${JSON.stringify(card, null, 2)}\n`);
  process.stdout.write(`${id}: head ${JSON.stringify(card.anchors.head)}\n`);
}
