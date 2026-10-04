import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs OS commands (launchctl, systemctl, schtasks, pkexec, $EDITOR). Injected so tests never touch the OS. */
export interface ProcessRunner {
  /** `interactive` hands the terminal to the child (editors, auth prompts) and captures nothing. */
  run(cmd: string, args: string[], opts?: { interactive?: boolean }): Promise<RunResult>;
}

export const spawnRunner: ProcessRunner = {
  run: (cmd, args, opts = {}) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: opts.interactive ? "inherit" : ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()));
      child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
      // ENOENT and friends: report like a shell would instead of throwing.
      child.on("error", (err) => resolve({ code: 127, stdout, stderr: err.message }));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    }),
};

/** `which`: the first executable called `name` on PATH (PATHEXT on Windows), or null. */
export const which = (
  name: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  const exts = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(platform === "win32" ? ";" : delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try {
        if (!statSync(p).isFile()) continue;
        if (platform !== "win32") accessSync(p, constants.X_OK);
        return p;
      } catch {
        /* not here */
      }
    }
  }
  return null;
};
