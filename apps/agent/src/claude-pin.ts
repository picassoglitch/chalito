import { createHash } from "node:crypto";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";

export interface ClaudePin {
  path: string;
  sha256: string;
}

export const sha256File = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (b) => h.update(b))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });

const worldWritable = (path: string) => (statSync(path).mode & 0o002) !== 0;

/**
 * Resolves a found `claude` (symlinks followed, so the pin names the real binary the
 * installer wrote) and hashes it. Done once, by a human at a terminal.
 */
export const pinClaude = async (found: string): Promise<ClaudePin> => {
  const path = realpathSync(found);
  if (!statSync(path).isFile()) throw new Error(`${path} is not a file`);
  if (worldWritable(path)) throw new Error(`${path} is world-writable; refusing to trust it`);
  return { path, sha256: await sha256File(path) };
};

export type PinCheck =
  { ok: true } | { ok: false; reason: "not_pinned" | "missing" | "world_writable" | "hash_mismatch" };

/** Daemon start: the pinned file must still exist, not be world-writable and hash the same. */
export const checkClaudePin = async (pin: ClaudePin | undefined): Promise<PinCheck> => {
  if (!pin) return { ok: false, reason: "not_pinned" };
  if (!existsSync(pin.path) || !statSync(pin.path).isFile()) return { ok: false, reason: "missing" };
  if (worldWritable(pin.path)) return { ok: false, reason: "world_writable" };
  return (await sha256File(pin.path)) === pin.sha256 ? { ok: true } : { ok: false, reason: "hash_mismatch" };
};
