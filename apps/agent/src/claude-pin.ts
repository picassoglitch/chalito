import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";

export interface ClaudePin {
  path: string;
  sha256: string;
}

const worldWritableMode = (mode: number) => (mode & 0o002) !== 0;

/** Whether anyone on this computer can replace the file: it, or the folder that holds it, is world-writable. */
const parentWorldWritable = (path: string) => {
  try {
    return worldWritableMode(statSync(dirname(path)).mode);
  } catch {
    return true;
  }
};

export class PinRefused extends Error {
  constructor(readonly reason: "not_a_file" | "world_writable" | "missing") {
    super(reason);
    this.name = "PinRefused";
  }
}

/**
 * Hashes the file through one open descriptor: the type and permissions are read with fstat on
 * that descriptor and the bytes from it, so a swap of the path between the check and the read
 * can't slip another file in.
 */
export const sha256Fd = async (path: string): Promise<string> => {
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    throw new PinRefused("missing");
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new PinRefused("not_a_file");
    if (worldWritableMode(st.mode)) throw new PinRefused("world_writable");
    const h = createHash("sha256");
    for await (const chunk of fh.createReadStream({ autoClose: false })) h.update(chunk as Buffer);
    return h.digest("hex");
  } finally {
    await fh.close();
  }
};

/** Kept for callers that hash a file they don't pin (same descriptor-based read). */
export const sha256File = sha256Fd;

/**
 * Resolves a found `claude` (symlinks followed, so the pin names the real binary the installer
 * wrote) and hashes it. Refused when the file or its folder is world-writable. Done by a human:
 * at a terminal (`chalito <tool> pin`) or with the desktop panel's local "Usar".
 */
export const pinClaude = async (found: string): Promise<ClaudePin> => {
  const path = realpathSync.native(found);
  if (!statSync(path).isFile()) throw new Error(`${path} is not a file`);
  if (worldWritableMode(statSync(path).mode) || parentWorldWritable(path))
    throw new Error(`${path} (or its folder) is world-writable; refusing to trust it`);
  return { path, sha256: await sha256Fd(path) };
};

export type PinCheck =
  { ok: true } | { ok: false; reason: "not_pinned" | "missing" | "world_writable" | "hash_mismatch" };

/**
 * Daemon start (the exec path): the pinned file must still exist, neither it nor its folder may be
 * world-writable, and it must hash the same. Always a fresh read through one descriptor, never a
 * cache.
 */
export const checkClaudePin = async (pin: ClaudePin | undefined): Promise<PinCheck> => {
  if (!pin) return { ok: false, reason: "not_pinned" };
  if (parentWorldWritable(pin.path)) return { ok: false, reason: "world_writable" };
  try {
    return (await sha256Fd(pin.path)) === pin.sha256 ? { ok: true } : { ok: false, reason: "hash_mismatch" };
  } catch (e) {
    if (e instanceof PinRefused)
      return { ok: false, reason: e.reason === "world_writable" ? "world_writable" : "missing" };
    return { ok: false, reason: "missing" };
  }
};
