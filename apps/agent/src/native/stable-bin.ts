import { createHash, randomUUID } from "node:crypto";
import { chmodSync, createReadStream, copyFileSync, lstatSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
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
    return (await sha256(a)) === (await sha256(b));
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
}): Promise<string> => {
  const appDir = d.env.APPDIR;
  if (d.platform !== "linux" || !d.env.APPIMAGE || !appDir || !d.execPath.startsWith(appDir.replace(/\/+$/, "") + sep))
    return d.execPath;
  const target = stableAgentPath(d.home);
  if (await sameFile(d.execPath, target)) return target;
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(d.execPath, temp);
    chmodSync(temp, 0o755);
    // rename: hooks running the old copy keep their file; new ones get the new one.
    renameSync(temp, target);
    return target;
  } catch (error) {
    d.log?.("native.stable_copy_failed", { error: error instanceof Error ? error.message : "error" });
    return d.execPath;
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Nothing was created there (the folder itself failed); agent start must not fail on it.
    }
  }
};
