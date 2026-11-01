import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";

/** Same spot the desktop's "Instalar el comando chalito" copies to (cli_install.rs), so both share one copy. */
export const stableAgentPath = (home: string): string => join(home, ".local", "share", "chalito", "chalito-agent");

const sha256 = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => h.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });

const sameFile = async (a: string, b: string): Promise<boolean> => {
  try {
    const sb = lstatSync(b);
    if (!sb.isFile() || sb.size !== statSync(a).size) return false;
    const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
    return ha === hb;
  } catch {
    return false;
  }
};

// #132 — an AppImage runs from /tmp/.mount_<random>, gone when it quits; hooks pointing
// there lock the AI app out, so they get a fixed copy, refreshed on update.
export const stableHookBinary = async (d: {
  execPath: string;
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  log?: (event: string, meta: Record<string, unknown>) => void;
}): Promise<{ path: string; ephemeral: boolean }> => {
  // A DMG (read-only under /Volumes; an app on an external disk is writable) or a translocated copy vanishes too.
  if (d.platform === "darwin" && (d.execPath.includes("/AppTranslocation/") || readOnlyVolume(d.execPath)))
    return { path: d.execPath, ephemeral: true };
  const appDir = d.env.APPDIR;
  if (d.platform !== "linux" || !d.env.APPIMAGE || !appDir || !d.execPath.startsWith(appDir.replace(/\/+$/, "") + sep))
    return { path: d.execPath, ephemeral: false };
  const target = stableAgentPath(d.home);
  if (await sameFile(d.execPath, target)) return { path: target, ephemeral: false };
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    sweepTemps(dirname(target));
    copyFileSync(d.execPath, temp);
    chmodSync(temp, 0o755);
    // rename: hooks running the old copy keep their file; new ones get the new one.
    renameSync(temp, target);
    return { path: target, ephemeral: false };
  } catch (error) {
    d.log?.("native.stable_copy_failed", { error: (error as NodeJS.ErrnoException).code ?? "error" });
    // An older copy still outlives the app; the mount never goes into hooks.
    return existingCopy(target) ? { path: target, ephemeral: false } : { path: d.execPath, ephemeral: true };
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch (error) {
      // ENOTDIR: the folder was never made, so there is no temp file to leave behind.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTDIR") d.log?.("native.stable_temp_left", { error: code ?? "error" });
    }
  }
};

/** Copies cut off by a kill mid-update: each is a full agent binary. */
const sweepTemps = (dir: string): void => {
  for (const name of readdirSync(dir))
    if (/^chalito-agent\.[0-9a-f-]{36}\.tmp$/.test(name)) rmSync(join(dir, name), { force: true });
};

const readOnlyVolume = (path: string): boolean => {
  if (!path.startsWith("/Volumes/")) return false;
  try {
    accessSync(dirname(path), constants.W_OK);
    return false;
  } catch {
    return true;
  }
};

const existingCopy = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};
