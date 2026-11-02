import { spawn, type ChildProcess } from "node:child_process";

/** A failure the proxy reports by code only: upstream text never reaches a log. */
export class ConnectorError extends Error {
  override name = "ConnectorError";
  constructor(readonly code: string) {
    super(code);
  }
}

export interface Transport {
  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  /** `onNotify` gets server notifications; `onClose(crashed)` fires once when the link drops. */
  start(onNotify: (method: string) => void, onClose: (crashed: boolean) => void): Promise<void>;
  close(): Promise<void>;
  readonly pid?: number;
}

type Waiter = { resolve: (v: unknown) => void; reject: (e: Error) => void };
const MAX_LINE = 16 * 1024 * 1024;
export const MAX_HTTP_BODY = 8 * 1024 * 1024;
const KILL_GRACE_MS = 2000;

const settle = (waiters: Map<number, Waiter>, msg: Record<string, unknown>) => {
  const id = msg.id;
  if (typeof id !== "number") return;
  const w = waiters.get(id);
  if (!w) return;
  waiters.delete(id);
  const err = msg.error as { message?: unknown; code?: unknown } | undefined;
  if (err && typeof err === "object") w.reject(new RpcError(err.code, err.message));
  else w.resolve(msg.result);
};

/** A JSON-RPC error from the server; its message is tool output, kept out of logs and audit. */
export class RpcError extends Error {
  override name = "RpcError";
  constructor(
    readonly rpcCode: unknown,
    readonly rpcMessage: unknown,
  ) {
    super("rpc_error");
  }
}

const withTimeout = <T>(
  run: (done: Waiter) => void,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  cleanup: () => void,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let finished = false;
    const finish = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      cleanup();
      finish(() => reject(new ConnectorError("connector_timeout")));
    }, timeoutMs);
    const onAbort = () => {
      cleanup();
      finish(() => reject(new ConnectorError("cancelled")));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    run({
      resolve: (v) => finish(() => resolve(v as T)),
      reject: (e) => finish(() => reject(e)),
    });
  });

/** A local stdio MCP server: newline-delimited JSON-RPC, its own process group so a kill reaches npx's children. */
export class StdioTransport implements Transport {
  #child: ChildProcess | null = null;
  #waiters = new Map<number, Waiter>();
  #n = 0;
  #closing = false;
  constructor(
    private readonly cmd: { command: string; args: string[]; env: Record<string, string> },
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  get pid() {
    return this.#child?.pid;
  }

  start(onNotify: (method: string) => void, onClose: (crashed: boolean) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cmd.command, this.cmd.args, {
        env: this.cmd.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: this.platform !== "win32",
      });
      this.#child = child;
      let closed = false;
      const end = () => {
        if (closed) return;
        closed = true;
        for (const w of this.#waiters.values()) w.reject(new ConnectorError("connector_crashed"));
        this.#waiters.clear();
        onClose(!this.#closing);
      };
      child.once("error", () => {
        end();
        reject(new ConnectorError("connector_unavailable"));
      });
      child.once("spawn", () => resolve());
      child.once("exit", end);
      // stderr may carry the token a server echoes back: it is drained, never kept.
      child.stderr?.resume();
      child.stdin?.on("error", () => undefined);
      let buf = "";
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          this.#line(line, onNotify);
        }
        // A server that never ends its line can't grow the agent's memory without bound.
        if (buf.length > MAX_LINE) {
          buf = "";
          this.#kill();
        }
      });
    });
  }

  #line(line: string, onNotify: (method: string) => void) {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (typeof msg.method === "string") {
      // Server-to-client requests: answer ping, refuse the rest (no sampling or roots for outside servers).
      if (msg.id !== undefined && msg.id !== null)
        this.#reply(
          msg.method === "ping"
            ? { jsonrpc: "2.0", id: msg.id, result: {} }
            : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } },
        );
      else onNotify(msg.method);
      return;
    }
    settle(this.#waiters, msg);
  }

  #reply(msg: unknown) {
    try {
      this.#write(msg);
    } catch {
      /* the exit handler reports it */
    }
  }

  #write(msg: unknown) {
    const stdin = this.#child?.stdin;
    if (!stdin || stdin.destroyed) throw new ConnectorError("connector_crashed");
    stdin.write(`${JSON.stringify(msg)}\n`);
  }

  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = ++this.#n;
    return withTimeout(
      (w) => {
        this.#waiters.set(id, w);
        try {
          this.#write({ jsonrpc: "2.0", id, method, params });
        } catch (e) {
          this.#waiters.delete(id);
          w.reject(e as Error);
        }
      },
      timeoutMs,
      signal,
      () => {
        this.#waiters.delete(id);
        try {
          this.#write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
        } catch {
          /* already gone */
        }
      },
    );
  }

  notify(method: string, params?: unknown) {
    try {
      this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    } catch {
      /* the exit handler reports it */
    }
  }

  #kill(signal: NodeJS.Signals = "SIGKILL") {
    const child = this.#child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (this.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      child.kill(signal);
    }
  }

  close(): Promise<void> {
    this.#closing = true;
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#kill("SIGKILL");
        resolve();
      }, KILL_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        // The group may still hold grandchildren (npx → node): make sure they go too.
        this.#kill("SIGKILL");
        resolve();
      });
      child.stdin?.end();
      this.#kill("SIGTERM");
    });
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** ADR 0023 §1a: HTTPS only, plain HTTP just for this machine. */
export const allowedRemoteUrl = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
};

const readCapped = async (res: Response, cap: number): Promise<string> => {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new ConnectorError("connector_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

/** The JSON-RPC messages in an SSE body (`data:` lines joined per event). */
export const sseMessages = (body: string): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const msg = JSON.parse(data) as unknown;
      if (msg && typeof msg === "object") out.push(msg as Record<string, unknown>);
    } catch {
      /* not a message */
    }
  }
  return out;
};

/** A vendor's streamable-HTTP MCP server. Redirects are refused so the token never follows one. */
export class HttpTransport implements Transport {
  #session: string | null = null;
  #protocol: string | null = null;
  #n = 0;
  #closed = false;
  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly fetchFn: FetchLike = fetch as unknown as FetchLike,
  ) {}

  setProtocol(v: string) {
    this.#protocol = v;
  }

  async start(): Promise<void> {
    if (!allowedRemoteUrl(this.url)) throw new ConnectorError("connector_bad_url");
  }

  #headers(): Record<string, string> {
    return {
      ...this.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.#session ? { "mcp-session-id": this.#session } : {}),
      ...(this.#protocol ? { "mcp-protocol-version": this.#protocol } : {}),
    };
  }

  async #post(body: unknown, signal: AbortSignal): Promise<Response> {
    if (this.#closed) throw new ConnectorError("connector_stopped");
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(body),
        redirect: "error",
        signal,
      });
    } catch {
      throw new ConnectorError(signal.aborted ? "connector_timeout" : "connector_unavailable");
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid && /^[\x21-\x7e]{1,256}$/.test(sid)) this.#session = sid;
    if (res.status === 401 || res.status === 403) throw new ConnectorError("connector_unauthorized");
    if (res.status === 404 && this.#session) throw new ConnectorError("connector_session_expired");
    if (!res.ok && res.status !== 202) throw new ConnectorError("connector_http_error");
    return res;
  }

  async request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const id = ++this.#n;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const onAbort = () => abort.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.#post({ jsonrpc: "2.0", id, method, params }, abort.signal);
      const type = res.headers.get("content-type") ?? "";
      const text = await readCapped(res, MAX_HTTP_BODY).catch((e: unknown) => {
        throw e instanceof ConnectorError
          ? e
          : new ConnectorError(abort.signal.aborted ? "connector_timeout" : "connector_protocol");
      });
      const msgs = type.includes("text/event-stream")
        ? sseMessages(text)
        : [JSON.parse(text) as Record<string, unknown>];
      const mine = msgs.find((m) => m.id === id);
      if (!mine) throw new ConnectorError("connector_protocol");
      const waiters = new Map<number, Waiter>();
      return await new Promise((resolve, reject) => {
        waiters.set(id, { resolve, reject });
        settle(waiters, mine);
      });
    } catch (e) {
      if (signal?.aborted) throw new ConnectorError("cancelled");
      if (e instanceof ConnectorError || e instanceof RpcError) throw e;
      throw new ConnectorError("connector_protocol");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  notify(method: string, params?: unknown) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    void this.#post({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }, abort.signal)
      .then((r) => r.body?.cancel())
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#session) return;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 3000);
    await this.fetchFn(this.url, {
      method: "DELETE",
      headers: this.#headers(),
      redirect: "error",
      signal: abort.signal,
    })
      .then((r) => r.body?.cancel())
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
  }
}
