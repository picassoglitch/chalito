/**
 * Re-derives each built roster card's anchors from its shipped neutral layer (no regeneration, no API
 * calls): `pnpm --filter @chalito/avatar-jobs exec tsx scripts/reanchor-roster.ts`. A detected neck
 * (detect-wear-anchors.ts) is kept.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ROSTER_IDS } from "@chalito/roster";
import sharp from "sharp";
import { anchorsFor } from "../src/process.js";

const assets = fileURLToPath(new URL("../../../packages/roster/assets/", import.meta.url));
for (const id of ROSTER_IDS) {
  if (!existsSync(`${assets}${id}/layer-neutral.webp`)) continue; // not built yet
  const { data, info } = await sharp(`${assets}${id}/layer-neutral.webp`)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cardPath = `${assets}${id}/card.json`;
  const card = JSON.parse(readFileSync(cardPath, "utf8")) as { anchors: Record<string, unknown> };
  // The neck is detected per character (detect-wear-anchors.ts): keep a detected one, and leave a
  // missing one missing so that script fills it (renderers derive one meanwhile).
  const { neck: _derived, ...anchors } = anchorsFor({ data, width: info.width, height: info.height });
  card.anchors = { ...anchors, ...(card.anchors.neck ? { neck: card.anchors.neck } : {}) };
  writeFileSync(cardPath, `${JSON.stringify(card, null, 2)}\n`);
  process.stdout.write(`${id}: head ${JSON.stringify(card.anchors.head)}\n`);
}
