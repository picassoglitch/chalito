import { createRequire } from "node:module";

/**
 * The PTY layer for remote terminals. Two backends, chosen at runtime:
 *
 * - **Bun's built-in PTY** (`Bun.spawn(argv, { terminal })`, Bun ≥ 1.3.5; CI pins 1.4.2) on macOS
 *   and Linux when the agent runs under Bun, i.e. the shipped `bun build --compile` binary. It
 *   needs no native addon, so nothing has to be embedded in the executable. It has no flow
 *   control: the output stream bounds what it buffers instead (output.ts).
 * - **@lydell/node-pty** (prebuilt N-API binaries of Microsoft's node-pty, ConPTY on Windows; no
 *   node-gyp at install) under Node (development, tests) and on Windows. node-pty itself can't
 *   write under Bun (its master fd is a `tty.ReadStream`, which Bun can't write to), and a dynamic
 *   require isn't embedded by `bun build --compile`, which is why it isn't the default under Bun.
 *
 * Loaded lazily, the first time a terminal starts. Everything above this file talks to
 * `PtyBackend`, which the tests replace.
 */

export interface PtyExit {
  exitCode: number;
  signal?: number | string | null;
}

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  onData: (data: string) => void;
  onExit: (e: PtyExit) => void;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** SIGHUP by default (as closing a terminal); SIGKILL when it didn't go. Windows ignores the signal. */
  kill(signal?: "SIGHUP" | "SIGKILL"): void;
  /** Flow control, where the backend has it (node-pty). */
  pause?(): void;
  resume?(): void;
}

export interface PtyBackend {
  readonly name: string;
  spawn(file: string, args: string[], o: PtySpawnOptions): PtyProcess;
}

export class PtyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PtyUnavailableError";
  }
}

// ---- Bun ----------------------------------------------------------------------------

interface BunTerminal {
  write(data: string | Uint8Array): number;
  resize(cols: number, rows: number): void;
  close(): void;
}
interface BunSubprocess {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly signalCode: string | null;
  readonly terminal?: BunTerminal;
  kill(signal?: string | number): void;
}
interface BunLike {
  spawn(
    argv: string[],
    opts: {
      cwd: string;
      env: Record<string, string>;
      terminal: { cols: number; rows: number; data: (t: BunTerminal, data: Uint8Array) => void };
    },
  ): BunSubprocess;
}

export const bunBackend = (bun: BunLike): PtyBackend => ({
  name: "bun",
  spawn: (file, args, o) => {
    const decoder = new TextDecoder();
    const proc = bun.spawn([file, ...args], {
      cwd: o.cwd,
      env: o.env,
      terminal: {
        cols: o.cols,
        rows: o.rows,
        data: (_t, data) => o.onData(decoder.decode(data, { stream: true })),
      },
    });
    const term = proc.terminal;
    if (!term) {
      proc.kill("SIGKILL");
      throw new PtyUnavailableError("This Bun has no built-in PTY (Bun 1.3.5 or newer is needed).");
    }
    void proc.exited.then(
      (code) => {
        const rest = decoder.decode();
        if (rest) o.onData(rest);
        o.onExit({ exitCode: code, signal: proc.signalCode });
      },
      () => o.onExit({ exitCode: -1, signal: null }),
    );
    return {
      pid: proc.pid,
      write: (data) => void term.write(data),
      resize: (cols, rows) => term.resize(cols, rows),
      kill: (signal = "SIGHUP") => {
        try {
          proc.kill(signal);
        } finally {
          if (signal === "SIGKILL") term.close();
        }
      },
    };
  },
});

// ---- node-pty -------------------------------------------------------------------------

interface NodePtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}
interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): NodePtyProcess;
}

export const nodePtyBackend = (pty: NodePtyModule, platform: NodeJS.Platform): PtyBackend => ({
  name: "node-pty",
  spawn: (file, args, o) => {
    const p = pty.spawn(file, args, { name: "xterm-256color", cols: o.cols, rows: o.rows, cwd: o.cwd, env: o.env });
    p.onData(o.onData);
    p.onExit((e) => o.onExit({ exitCode: e.exitCode, signal: e.signal ?? null }));
    return {
      pid: p.pid,
      write: (data) => p.write(data),
      resize: (cols, rows) => p.resize(cols, rows),
      kill: (signal = "SIGHUP") => (platform === "win32" ? p.kill() : p.kill(signal)),
      pause: () => p.pause(),
      resume: () => p.resume(),
    };
  },
});

/**
 * The backend for this process: Bun's own PTY under Bun on macOS/Linux, node-pty otherwise.
 * Throws PtyUnavailableError when neither can run here.
 */
export const loadPtyBackend = (
  opts: { platform?: NodeJS.Platform; bun?: unknown; requireFn?: (id: string) => unknown } = {},
): PtyBackend => {
  const platform = opts.platform ?? process.platform;
  if (!["darwin", "linux", "win32"].includes(platform))
    throw new PtyUnavailableError(`Remote terminal isn't available on ${platform}.`);
  const bun = "bun" in opts ? opts.bun : (globalThis as { Bun?: unknown }).Bun;
  if (bun && platform !== "win32") return bunBackend(bun as BunLike);
  const req = opts.requireFn ?? createRequire(import.meta.url);
  try {
    return nodePtyBackend(req("@lydell/node-pty") as NodePtyModule, platform);
  } catch (err) {
    const why = err instanceof Error ? err.message.slice(0, 120) : "module missing";
    throw new PtyUnavailableError(`This Chalito build can't open terminals (${why}).`);
  }
};
