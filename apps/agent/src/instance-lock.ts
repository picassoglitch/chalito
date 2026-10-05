import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * One agent per computer. The OS service (`chalito service install`) and the desktop app's
 * supervisor can both start `chalito run`; two daemons on one identity would both answer the
 * same commands and approvals. The second one exits instead (EXIT_ALREADY_RUNNING).
 */
export class AlreadyRunningError extends Error {
  override name = "AlreadyRunningError";
  constructor(readonly pid: number) {
    super(`Another Chalito agent is already running on this computer (pid ${pid}).`);
  }
}

/** `chalito run` exit codes the desktop supervisor tells apart (sysexits.h). */
export const EXIT_ALREADY_RUNNING = 75; // EX_TEMPFAIL
export const EXIT_NEEDS_SETUP = 78; // EX_CONFIG: an OnboardingError the person has to fix

export const lockPath = (dir: string): string => join(dir, "agent.lock");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it's just not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Takes `~/.chalito/agent.lock` (O_EXCL, our pid inside). A lock left by a process that no
 * longer exists is taken over. Returns the release function.
 */
export const acquireInstanceLock = (
  dir: string,
  deps: { pid?: number; isAlive?: (pid: number) => boolean } = {},
): (() => void) => {
  const pid = deps.pid ?? process.pid;
  const isAlive = deps.isAlive ?? alive;
  const file = lockPath(dir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(pid));
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (readFileSync(file, "utf8").trim() === String(pid)) rmSync(file, { force: true });
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let holder = NaN;
      try {
        holder = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
      } catch {
        /* removed meanwhile: retry */
      }
      if (Number.isInteger(holder) && holder > 0 && holder !== pid && isAlive(holder))
        throw new AlreadyRunningError(holder);
      rmSync(file, { force: true });
    }
  }
  throw new Error(`Couldn't take ${file}`);
};
