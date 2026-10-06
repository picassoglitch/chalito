import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { RunResult } from "./runner.js";

/**
 * The apps' CLIs and the agent's own child processes (engine contract v2). What each app runs
 * (its official install, sign-in, status and sign-out commands) comes from its recipe
 * (recipes/*.yaml, apps/agent/src/apps); this file only runs processes. Official tools only:
 * Chalito never implements an app's consumer login, never scrapes a web session, and never reads
 * or copies a token out of an app's storage.
 */

/** The CLIs and the agent's own child processes. Injected so tests never run a real CLI. */
export interface ProviderProcs {
  /**
   * Runs `cmd` to completion with no terminal (stdin closed), killing it after `timeoutMs`
   * (code 124, like `timeout`). `onLine` sees each output line as it comes.
   */
  run(
    cmd: string,
    args: string[],
    opts: { env: Record<string, string | undefined>; timeoutMs: number; onLine?: (line: string) => void },
  ): Promise<RunResult>;
  /**
   * ACP over stdio: `initialize`, then `authenticate {methodId}`. True when the agent answers
   * the authenticate request without an error.
   */
  acpAuthenticate(
    cmd: string,
    args: string[],
    opts: { env: Record<string, string | undefined>; timeoutMs: number; methodId: string },
  ): Promise<boolean>;
  /** Opens a link in the person's default browser on this computer. */
  openUrl(url: string): Promise<void>;
  /**
   * Starts a GUI app or a launcher command detached from the agent (it keeps running after the
   * agent stops). True once it started.
   */
  launch(cmd: string, args: string[], opts: { env: Record<string, string | undefined> }): Promise<boolean>;
}

const opener = (platform: NodeJS.Platform, url: string): [string, string[]] =>
  platform === "darwin"
    ? ["open", [url]]
    : platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];

export const spawnProviderProcs = (platform: NodeJS.Platform = process.platform): ProviderProcs => ({
  run: (cmd, args, opts) =>
    new Promise((resolve) => {
      // npm and the CLIs' launchers are .cmd files on Windows, which need a shell.
      const child = spawn(cmd, args, {
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: platform === "win32" && /\.(cmd|bat)$/i.test(cmd),
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, opts.timeoutMs);
      const lines = (stream: NodeJS.ReadableStream | null, sink: (s: string) => void) => {
        if (!stream) return;
        createInterface({ input: stream, crlfDelay: Infinity }).on("line", (l) => {
          sink(`${l}\n`);
          opts.onLine?.(l);
        });
      };
      lines(child.stdout, (s) => (stdout += s));
      lines(child.stderr, (s) => (stderr += s));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: err.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr });
      });
    }),

  acpAuthenticate: (cmd, args, opts) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, {
        env: opts.env,
        stdio: ["pipe", "pipe", "ignore"],
        shell: platform === "win32" && /\.(cmd|bat)$/i.test(cmd),
        windowsHide: true,
      });
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdin.end();
        child.kill();
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), opts.timeoutMs);
      const send = (m: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
      child.on("error", () => done(false));
      child.on("close", () => done(false));
      child.stdin.on("error", () => undefined);
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
        let msg: { id?: unknown; result?: unknown; error?: unknown };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          return;
        }
        if (msg.id === 0) {
          if (msg.error) return done(false);
          send({ id: 1, method: "authenticate", params: { methodId: opts.methodId } });
        } else if (msg.id === 1) done(!msg.error);
      });
      send({
        id: 0,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
      });
    }),

  launch: (cmd, args, opts) =>
    new Promise<boolean>((resolve) => {
      const child = spawn(cmd, args, {
        env: opts.env,
        stdio: "ignore",
        detached: true,
        shell: platform === "win32" && /\.(cmd|bat)$/i.test(cmd),
        windowsHide: true,
      });
      child.on("error", () => resolve(false));
      child.on("spawn", () => {
        child.unref();
        resolve(true);
      });
    }),

  openUrl: async (url) => {
    const [cmd, args] = opener(platform, url);
    await new Promise<void>((resolve) => {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
      child.on("error", () => resolve());
      child.on("spawn", () => {
        child.unref();
        resolve();
      });
    });
  },
});

/** The first https link in a CLI's output line, if it's on one of `hosts` (or a subdomain). */
export const officialLink = (line: string, hosts: string[]): string | null => {
  for (const m of line.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try {
      const u = new URL(m[0]);
      if (hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return u.toString();
    } catch {
      /* not a URL */
    }
  }
  return null;
};

/** `x.y.z` (with any pre-release tail) from a `--version` line, at most 64 characters. */
export const parseVersion = (out: string): string | null => {
  const m = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/.exec(out);
  return m ? m[0].slice(0, 64) : null;
};
