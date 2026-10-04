// Copies @chalito/roster's art (companion cards and cosmetics) to public/roster before dev/build,
// so the PWA serves it as static files without committing a second copy. The PWA icons are the
// exception: they live in public/icons (the manifest and install prompts need fixed paths).
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
