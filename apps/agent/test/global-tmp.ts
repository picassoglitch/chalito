import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "chalito-tests-";
const STALE_MS = 6 * 60 * 60_000;

// Aldo 2026-11-03 — tests left ~1,000 temp folders per run and filled /tmp's inodes; each run now gets one folder.
// Every test's tmpdir() lands inside it (workers inherit TMPDIR) and it is removed when the run ends.
export default function setup(): () => void {
  const root = tmpdir();
  // A run that was killed never reached its teardown: clear those after a few hours.
  for (const name of readdirSync(root)) {
    if (!name.startsWith(PREFIX)) continue;
    const path = join(root, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Another run's folder, or already gone.
    }
  }
  // Short on purpose: Unix socket paths inside it must stay under ~104 bytes.
  const base = mkdtempSync(join(root, PREFIX));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = base;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(base, { recursive: true, force: true });
  };
}
