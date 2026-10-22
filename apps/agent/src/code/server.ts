import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { AppId, RemotePermissionMode, SessionId } from "@chalito/protocol";
import type { LocalEvent } from "./events.js";
import type { CodeService } from "./service.js";

// ADR 0031 §6a: `chalito code`'s way in. Any process of the user may connect (a session too), so it
// starts only unsigned `local:cli` sessions, answers no approvals, and steers only its own sessions.

export const CODE_MAX_LINE = 64 * 1024;
/** A reader that falls this far behind is dropped rather than buffered without end. */
export const CODE_MAX_BACKLOG = 1024 * 1024;
const EARLY_MAX = 500;
/** Starts per connection, and per minute across all connections. */
export const CODE_STARTS_PER_CONN = 3;
export const CODE_STARTS_PER_MINUTE = 6;

// ADR 0031 §6a: no Windows pipe until it can carry a current-user DACL (squatting); null = not served.
export const codePath = (dir: string, platform: NodeJS.Platform = process.platform): string | null =>
  platform === "win32" ? null : join(dir, "code.sock");

const Start = z
  .object({
    appId: AppId,
    workspaceLabel: z.string().min(1).max(80),
    prompt: z.string().min(1).max(20_000),
    permissionMode: RemotePermissionMode.default("default"),
  })
  .strict();
const Prompt = z.object({ sid: SessionId, text: z.string().min(1).max(20_000) }).strict();
const ForSid = z.object({ sid: SessionId }).strict();
const Cwd = z.object({ cwd: z.string().min(1).max(4096) }).strict();

/** What the server pushes for the connection's own sessions. */
export type CodePush = { event: LocalEvent & { sid: string } };

export interface CodeServer {
  readonly path: string;
  close(): Promise<void>;
}

class Conn {
  readonly owned = new Set<string>();
  #starting = 0;
  /** Events of sessions not known yet, kept only while one of this connection's starts runs. */
  #early = new Map<string, LocalEvent[]>();
  constructor(readonly sock: Socket) {}

  #earlyCount = 0;
  starts = 0;

  send(msg: unknown): void {
    if (this.sock.destroyed) return;
    if (this.sock.writableLength > CODE_MAX_BACKLOG) return void this.sock.destroy();
    this.sock.write(`${JSON.stringify(msg)}\n`);
  }

  onEvent(sid: string, e: LocalEvent): void {
    if (this.owned.has(sid)) return this.send({ event: { ...e, sid } });
    if (this.#starting === 0 || this.#earlyCount >= EARLY_MAX) return;
    this.#earlyCount++;
    this.#early.set(sid, [...(this.#early.get(sid) ?? []), e]);
  }

  async start(run: () => Promise<{ ok: boolean; sid?: string }>) {
    this.#starting++;
    try {
      const r = await run();
      if (r.ok && r.sid) {
        this.owned.add(r.sid);
        for (const e of this.#early.get(r.sid) ?? []) this.send({ event: { ...e, sid: r.sid } });
      }
      return r;
    } finally {
      if (--this.#starting === 0) {
        this.#early.clear();
        this.#earlyCount = 0;
      }
    }
  }
}

export const startCodeServer = async (opts: {
  path: string;
  code: CodeService;
  onError?: (method: string, err: unknown) => void;
  platform?: NodeJS.Platform;
}): Promise<CodeServer> => {
  const { code } = opts;
  const unix = (opts.platform ?? process.platform) !== "win32";
  // The instance lock (instance-lock.ts) guarantees no other agent owns a leftover socket.
  if (unix) rmSync(opts.path, { force: true });
  const conns = new Set<Conn>();
  let recentStarts: number[] = [];
  const untap = code.tap((sid, e) => {
    for (const c of conns) c.onEvent(sid, e);
  });

  const parse = <T>(schema: z.ZodType<T>, params: unknown): T | null => {
    const r = schema.safeParse(params ?? {});
    return r.success ? r.data : null;
  };
  const result = (r: { ok: boolean; sid?: string; reason?: string }) =>
    r.ok ? { ok: true, result: r.sid ? { sid: r.sid } : null } : { ok: false, error: r.reason ?? "internal" };

  const methods: Record<string, (c: Conn, params: unknown) => Promise<Record<string, unknown>>> = {
    apps: async () => ({ ok: true, result: code.apps() }),
    workspaceFor: async (_c, params) => {
      const p = parse(Cwd, params);
      return p ? { ok: true, result: { label: code.workspaceFor(p.cwd) } } : { ok: false, error: "bad_params" };
    },
    start: async (c, params) => {
      const p = parse(Start, params);
      if (!p) return { ok: false, error: "bad_params" };
      const now = Date.now();
      recentStarts = recentStarts.filter((t) => t > now - 60_000);
      if (c.starts >= CODE_STARTS_PER_CONN || recentStarts.length >= CODE_STARTS_PER_MINUTE)
        return { ok: false, error: "rate_limited" };
      c.starts++;
      recentStarts.push(now);
      return result(await c.start(() => code.start(p)));
    },
    prompt: async (c, params) => {
      const p = parse(Prompt, params);
      if (!p) return { ok: false, error: "bad_params" };
      if (!c.owned.has(p.sid)) return { ok: false, error: "not_yours" };
      return result(await code.prompt(p.sid, p.text));
    },
    stop: async (c, params) => {
      const p = parse(ForSid, params);
      if (!p) return { ok: false, error: "bad_params" };
      if (!c.owned.has(p.sid)) return { ok: false, error: "not_yours" };
      return result(await code.stop(p.sid));
    },
    sessions: async (c) => ({ ok: true, result: { sids: [...c.owned] } }),
  };

  const handle = async (c: Conn, line: string) => {
    let req: { id?: unknown; method?: unknown; params?: unknown };
    try {
      req = JSON.parse(line) as typeof req;
    } catch {
      return void c.sock.destroy();
    }
    if (!req || typeof req !== "object" || Array.isArray(req)) return void c.sock.destroy();
    const id = typeof req.id === "number" ? req.id : null;
    const name = typeof req.method === "string" ? req.method : "";
    const fn = Object.hasOwn(methods, name) ? methods[name] : undefined;
    if (!fn) return c.send({ id, ok: false, error: "unknown_method" });
    try {
      c.send({ id, ...(await fn(c, req.params)) });
    } catch (err) {
      opts.onError?.(name, err);
      c.send({ id, ok: false, error: "internal" });
    }
  };

  const server: Server = createServer((sock) => {
    const c = new Conn(sock);
    conns.add(c);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("error", () => undefined);
    sock.on("close", () => conns.delete(c));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length > CODE_MAX_LINE) return void sock.destroy();
        if (line.trim()) void handle(c, line);
      }
      // Limit is per request line, not per burst of small ones.
      if (buf.length > CODE_MAX_LINE) return void sock.destroy();
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
      new Promise<void>((resolve) => {
        untap();
        for (const c of conns) c.sock.destroy();
        server.close(() => {
          if (unix) rmSync(opts.path, { force: true });
          resolve();
        });
      }),
  };
};
