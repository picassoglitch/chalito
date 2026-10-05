import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { userInfo } from "node:os";

/**
 * The desktop panel's way into this agent (ADR 0004: local surfaces only). A per-user local
 * socket, never a TCP port: `~/.chalito/agent.sock` (0600, in the 0700 dir) on macOS and
 * Linux, a per-user named pipe on Windows. Every request carries the per-launch secret the
 * desktop app handed to the agent it started (on stdin); an agent the app didn't start (the OS
 * service) has no secret and serves nothing. Other processes of the same user can reach the
 * socket but not the secret, so they can't drive Developer mode or the pairing check through it.
 *
 * Wire format: one JSON object per line.
 *   → {"id": 1, "token": "<secret>", "method": "devMode", "params": {...}}
 *   ← {"id": 1, "ok": true, "result": ...}  |  {"id": 1, "ok": false, "error": "<code>"}
 */

export const IPC_MAX_LINE = 64 * 1024;
/** At least 128 bits, hex. */
export const IPC_SECRET = /^[0-9a-f]{32,128}$/;

export type IpcHandler = (params: unknown) => Promise<unknown>;
export type IpcHandlers = Record<string, IpcHandler>;

/** A refusal the panel can show (`error` is this code, never a stack or a path). */
export class IpcError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "IpcError";
  }
}

const safeUser = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "user";

export const ipcPath = (dir: string, platform: NodeJS.Platform = process.platform, user?: string): string =>
  platform === "win32"
    ? `\\\\.\\pipe\\chalito-agent-${safeUser(user ?? userInfo().username)}`
    : join(dir, "agent.sock");

const digest = (s: string) => createHash("sha256").update(s).digest();
const tokenOk = (got: unknown, want: Buffer) => typeof got === "string" && timingSafeEqual(digest(got), want);

export interface IpcServer {
  readonly path: string;
  close(): Promise<void>;
}

export const startIpcServer = async (opts: {
  path: string;
  secret: string;
  handlers: IpcHandlers;
  onError?: (method: string, err: unknown) => void;
  platform?: NodeJS.Platform;
}): Promise<IpcServer> => {
  if (!IPC_SECRET.test(opts.secret)) throw new Error("IPC secret must be 32–128 hex characters");
  const want = digest(opts.secret);
  const unix = (opts.platform ?? process.platform) !== "win32";
  // The instance lock (instance-lock.ts) guarantees no other agent owns a leftover socket.
  if (unix) rmSync(opts.path, { force: true });

  const answer = (sock: Socket, msg: Record<string, unknown>) => {
    if (!sock.destroyed) sock.write(`${JSON.stringify(msg)}\n`);
  };
  const handle = async (sock: Socket, line: string) => {
    let req: { id?: unknown; token?: unknown; method?: unknown; params?: unknown };
    try {
      req = JSON.parse(line) as typeof req;
    } catch {
      return void sock.destroy();
    }
    const id = typeof req.id === "number" ? req.id : null;
    if (!tokenOk(req.token, want)) {
      answer(sock, { id, ok: false, error: "unauthorized" });
      return void sock.end();
    }
    const method = typeof req.method === "string" ? req.method : "";
    const fn = Object.hasOwn(opts.handlers, method) ? opts.handlers[method] : undefined;
    if (!fn) return answer(sock, { id, ok: false, error: "unknown_method" });
    try {
      answer(sock, { id, ok: true, result: (await fn(req.params)) ?? null });
    } catch (err) {
      opts.onError?.(method, err);
      answer(sock, { id, ok: false, error: err instanceof IpcError ? err.code : "internal" });
    }
  };

  const server: Server = createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("error", () => undefined);
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > IPC_MAX_LINE) return void sock.destroy();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) void handle(sock, line);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (unix) chmodSync(opts.path, 0o600);

  return {
    path: opts.path,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          if (unix) rmSync(opts.path, { force: true });
          resolve();
        }),
      ),
  };
};

/**
 * The secret the desktop app writes as the first line of the agent's stdin (it sets
 * CHALITO_IPC=stdin). Anything else (no line in time, not hex) means no IPC server.
 */
export const readIpcSecret = (input: NodeJS.ReadableStream, timeoutMs = 5_000): Promise<string | null> =>
  new Promise((resolve) => {
    let buf = "";
    const done = (v: string | null) => {
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      (input as NodeJS.ReadableStream & { pause?: () => void }).pause?.();
      resolve(v);
    };
    const onData = (c: Buffer | string) => {
      buf += c.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const s = buf.slice(0, nl).trim();
        done(IPC_SECRET.test(s) ? s : null);
      } else if (buf.length > 256) done(null);
    };
    const onEnd = () => done(IPC_SECRET.test(buf.trim()) ? buf.trim() : null);
    const timer = setTimeout(() => done(null), timeoutMs);
    input.on("data", onData);
    input.on("end", onEnd);
  });
