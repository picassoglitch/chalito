import { chmodSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { userInfo } from "node:os";
import { ComputerError, type ToolOutput } from "./control.js";

/**
 * The local socket between the computer MCP server (a child of Claude Code or Codex) and the
 * agent, which owns the policy, the grants, the native layer and the audit. A per-user socket
 * (`~/.chalito/computer.sock`, 0600, in the 0700 dir) or a per-user named pipe on Windows, never
 * a TCP port. Separate from the desktop IPC socket: the MCP server only gets its session's
 * token, never the desktop app's secret, so it can't reach Developer mode or the enable path.
 *
 * Wire format: one JSON object per line.
 *   → {"token": "<session token>", "tool": "click", "args": {...}}
 *   ← {"ok": true, "result": {"text": "...", "image"?: {...}}}  |  {"ok": false, "error": "<code>", "message": "..."}
 */

export const BROKER_REQUEST_TIMEOUT_MS = 10_000;
export const BROKER_MAX_REQUEST = 64 * 1024;
/** Replies carry screenshots (a downscaled PNG, base64). */
export const BROKER_MAX_REPLY = 32 * 1024 * 1024;

const safeUser = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "user";

export const brokerPath = (dir: string, platform: NodeJS.Platform = process.platform, user?: string): string =>
  platform === "win32"
    ? `\\\\.\\pipe\\chalito-computer-${safeUser(user ?? userInfo().username)}`
    : join(dir, "computer.sock");

export interface Broker {
  readonly path: string;
  close(): Promise<void>;
}

export const startBroker = async (opts: {
  path: string;
  call: (token: string, tool: string, args: unknown) => Promise<ToolOutput>;
  platform?: NodeJS.Platform;
  requestTimeoutMs?: number;
}): Promise<Broker> => {
  const unix = (opts.platform ?? process.platform) !== "win32";
  if (unix) rmSync(opts.path, { force: true });
  const answer = (sock: Socket, msg: Record<string, unknown>) => {
    if (!sock.destroyed) sock.end(`${JSON.stringify(msg)}\n`);
  };
  const server: Server = createServer((sock) => {
    let buf = "";
    let handled = false;
    sock.setEncoding("utf8");
    sock.on("error", () => undefined);
    // A client that connects and never sends its line doesn't keep a socket open forever. Only the
    // wait for the request counts: a slow action (a screenshot) runs after it with the timer off.
    sock.setTimeout(opts.requestTimeoutMs ?? BROKER_REQUEST_TIMEOUT_MS, () => sock.destroy());
    sock.on("data", (chunk: string) => {
      if (handled) return;
      buf += chunk;
      if (buf.length > BROKER_MAX_REQUEST) return void sock.destroy();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      handled = true;
      sock.setTimeout(0);
      let req: { token?: unknown; tool?: unknown; args?: unknown };
      try {
        req = JSON.parse(buf.slice(0, nl)) as typeof req;
      } catch {
        return void sock.destroy();
      }
      // `null`, a number or an array parse fine: reading a field off them must not throw here.
      if (!req || typeof req !== "object" || Array.isArray(req))
        return answer(sock, { ok: false, error: "bad_request", message: "bad request" });
      if (typeof req.token !== "string" || typeof req.tool !== "string")
        return answer(sock, { ok: false, error: "bad_request", message: "bad request" });
      opts.call(req.token, req.tool, req.args).then(
        (result) => answer(sock, { ok: true, result }),
        (err: unknown) =>
          answer(
            sock,
            err instanceof ComputerError
              ? { ok: false, error: err.code, message: err.message }
              : { ok: false, error: "internal", message: "The action failed on this computer." },
          ),
      );
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

export type BrokerReply = { ok: true; result: ToolOutput } | { ok: false; error: string; message: string };

/** One request on a fresh connection (the MCP server's side). */
export const brokerCall = (path: string, token: string, tool: string, args: unknown): Promise<BrokerReply> =>
  new Promise((resolve) => {
    const unavailable: BrokerReply = {
      ok: false,
      error: "agent_unavailable",
      message: "The Chalito agent isn't answering on this computer.",
    };
    let buf = "";
    let done = false;
    const finish = (r: BrokerReply) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(r);
    };
    const sock = createConnection(path);
    sock.setEncoding("utf8");
    sock.on("error", () => finish(unavailable));
    sock.on("connect", () => sock.write(`${JSON.stringify({ token, tool, args })}\n`));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > BROKER_MAX_REPLY) return finish(unavailable);
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        finish(JSON.parse(buf.slice(0, nl)) as BrokerReply);
      } catch {
        finish(unavailable);
      }
    });
    sock.on("close", () => finish(unavailable));
  });
