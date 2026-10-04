// Copies @chalito/roster's art (companion cards and cosmetics) to public/roster before dev/build,
// so every window serves it as static files under /roster/ (the room scene's assetBase), the same
// layout as the PWA (apps/web/scripts/copy-roster.mjs). Not committed: see .gitignore.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const roster = join(dirname(fileURLToPath(import.meta.resolve("@chalito/roster"))), "..");
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "roster");
rmSync(out, { recursive: true, force: true });
for (const dir of ["assets", "cosmetics"]) {
  const src = join(roster, dir);
  if (!existsSync(src)) throw new Error(`@chalito/roster has no ${dir}/`);
  mkdirSync(join(out, dir), { recursive: true });
  cpSync(src, join(out, dir), { recursive: true });
}
process.stdout.write(`roster art → ${out}\n`);
