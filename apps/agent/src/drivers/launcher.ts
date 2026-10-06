import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { which } from "../runner.js";

/**
 * How the app drivers start programs: by absolute path with an argument list, never through a
 * shell, detached so the app outlives the agent, with no stdio (nothing the app prints reaches
 * Chalito). The tests replace it.
 */
export interface Launcher {
  spawnDetached(cmd: string, args: string[]): Promise<{ ok: boolean }>;
  exists(path: string): boolean;
  which(name: string): string | null;
}

export const systemLauncher = (env: Record<string, string | undefined>, platform: NodeJS.Platform): Launcher => ({
  spawnDetached: (cmd, args) =>
    new Promise((resolve) => {
      try {
        const child = spawn(cmd, args, {
          detached: true,
          stdio: "ignore",
          shell: false,
          windowsHide: false,
          env: env as NodeJS.ProcessEnv,
        });
        child.once("error", () => resolve({ ok: false }));
        child.once("spawn", () => {
          child.unref();
          resolve({ ok: true });
        });
      } catch {
        resolve({ ok: false });
      }
    }),
  exists: (p) => existsSync(p),
  which: (name) => which(name, env, platform),
});
