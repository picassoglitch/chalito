import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/**
 * The LAN path's WebSocket (RFC 6455), kept to what the link needs so the agent ships no extra
 * dependency: one text message per frame (no fragmentation, no extensions), a hard size cap,
 * close and ping/pong. The dialer uses the runtime's own WebSocket client (Node ≥ 22, bun).
 *
 * Everything that crosses it after the first message is sealed (lan/handshake.ts); this layer
 * only moves strings.
 */

export interface LanConn {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: (code: number) => void): void;
  /** `address:port` of the other end, for logs only. */
  readonly remote: string;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** Calls back and forgets: a listener that throws must never take the socket loop down. */
const safe = <A extends unknown[]>(fns: ((...a: A) => void)[], ...args: A) => {
  for (const f of fns) {
    try {
      f(...args);
    } catch {
      /* the owner of the callback logs its own errors */
    }
  }
};

const frame = (op: number, payload: Buffer): Buffer => {
  const len = payload.length;
  const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = 0x80 | op;
  if (len < 126) head[1] = len;
  else if (len < 65536) {
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
};

/** Server side of one upgraded socket. Client frames must be masked (RFC 6455 §5.1). */
class ServerConn implements LanConn {
  #buf: Buffer = Buffer.alloc(0);
  #msg: ((t: string) => void)[] = [];
  #closed: ((c: number) => void)[] = [];
  #done = false;
  #queued: string[] = [];
  constructor(
    private readonly socket: Socket,
    private readonly maxBytes: number,
    readonly remote: string,
  ) {
    socket.setNoDelay(true);
    socket.on("data", (d: Buffer) => this.#onData(d));
    socket.on("close", () => this.#finish(1006));
    socket.on("error", () => this.#finish(1006));
  }

  onMessage(cb: (t: string) => void) {
    this.#msg.push(cb);
    // Messages that arrived before anyone listened (the first hello can race the listener).
    for (const t of this.#queued.splice(0)) safe([cb], t);
  }
  onClose(cb: (c: number) => void) {
    this.#closed.push(cb);
  }

  send(text: string) {
    if (this.#done) return;
    this.socket.write(frame(OP_TEXT, Buffer.from(text, "utf8")));
  }

  close(code = 1000, reason = "") {
    if (this.#done) return;
    const r = Buffer.from(reason.slice(0, 64), "utf8");
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.socket.write(frame(OP_CLOSE, p));
    this.socket.end();
    this.#finish(code);
  }

  #finish(code: number) {
    if (this.#done) return;
    this.#done = true;
    this.socket.destroySoon?.();
    safe(this.#closed, code);
  }

  #onData(d: Buffer) {
    if (this.#done) return;
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, d]) : d;
    if (this.#buf.length > this.maxBytes + 14) return this.close(1009, "too_big");
    for (;;) {
      const b = this.#buf;
      if (b.length < 2) return;
      const fin = (b[0]! & 0x80) !== 0;
      const rsv = b[0]! & 0x70;
      const op = b[0]! & 0x0f;
      const masked = (b[1]! & 0x80) !== 0;
      let len = b[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxBytes)) return this.close(1009, "too_big");
        len = Number(big);
        off = 10;
      }
      if (!fin || rsv || !masked || op === 0) return this.close(1002, "protocol");
      if (len > this.maxBytes) return this.close(1009, "too_big");
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
      this.#buf = b.subarray(off + 4 + len);
      switch (op) {
        case OP_TEXT: {
          const text = payload.toString("utf8");
          if (this.#msg.length) safe(this.#msg, text);
          else if (this.#queued.length < 4) this.#queued.push(text);
          else return this.close(1008, "policy");
          break;
        }
        case OP_PING:
          if (len <= 125) this.socket.write(frame(OP_PONG, payload));
          break;
        case OP_PONG:
          break;
        case OP_CLOSE:
          return this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000);
        default:
          return this.close(1003, "unsupported"); // binary and anything else
      }
      if (this.#done) return;
    }
  }
}

export interface LanListener {
  readonly port: number;
  close(): Promise<void>;
}

export interface ListenOptions {
  host: string;
  port: number;
  path: string;
  maxBytes: number;
  /** Upgrades refused while this many connections are open (handshakes included). */
  maxConnections: number;
  onConn(conn: LanConn): void;
}

/** An HTTP server that only upgrades `GET <path>` to the LAN WebSocket; everything else is 404. */
export const listenLan = async (o: ListenOptions): Promise<LanListener> => {
  const server: Server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const sockets = new Set<Socket>();
  server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
    const key = req.headers["sec-websocket-key"];
    const ok =
      req.method === "GET" &&
      req.url === o.path &&
      String(req.headers.upgrade ?? "").toLowerCase() === "websocket" &&
      req.headers["sec-websocket-version"] === "13" &&
      typeof key === "string" &&
      Buffer.from(key, "base64").length === 16;
    if (!ok || sockets.size >= o.maxConnections) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const remote = `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`;
    o.onConn(new ServerConn(socket, o.maxBytes, remote));
  });
  // Slow-loris guard for the plain HTTP side.
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
};

/** Minimal shape of the runtime's WebSocket that the dialer needs. */
interface RuntimeWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    cb: (ev: { data?: unknown; code?: number }) => void,
  ): void;
}
type RuntimeWebSocketCtor = new (url: string) => RuntimeWebSocket;

/** Dials `ws://host:port<path>`; rejects if the socket isn't open within `timeoutMs`. */
export const dialLan = (url: string, maxBytes: number, timeoutMs: number): Promise<LanConn> => {
  const Ctor = (globalThis as { WebSocket?: RuntimeWebSocketCtor }).WebSocket;
  if (!Ctor) return Promise.reject(new Error("lan: this runtime has no WebSocket client"));
  return new Promise<LanConn>((resolve, reject) => {
    let ws: RuntimeWebSocket;
    try {
      ws = new Ctor(url);
    } catch (err) {
      reject(err instanceof Error ? err : new Error("lan: dial failed"));
      return;
    }
    const msg: ((t: string) => void)[] = [];
    const queued: string[] = [];
    const closed: ((c: number) => void)[] = [];
    let open = false;
    let done = false;
    const timer = setTimeout(() => {
      if (!open) {
        reject(new Error("lan: dial timeout"));
        try {
          ws.close();
        } catch {
          /* already closing */
        }
      }
    }, timeoutMs);
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!open) reject(new Error("lan: dial failed"));
      safe(closed, code);
    };
    const conn: LanConn = {
      remote: url,
      send: (t) => {
        if (!done) ws.send(t);
      },
      close: (code = 1000, reason = "") => {
        try {
          ws.close(code, reason.slice(0, 64));
        } catch {
          /* already closed */
        }
        finish(code);
      },
      onMessage: (cb) => {
        msg.push(cb);
        for (const t of queued.splice(0)) safe([cb], t);
      },
      onClose: (cb) => void closed.push(cb),
    };
    ws.addEventListener("open", () => {
      open = true;
      clearTimeout(timer);
      resolve(conn);
    });
    ws.addEventListener("message", (ev) => {
      if (done) return;
      if (typeof ev.data !== "string" || ev.data.length > maxBytes) return conn.close(1009, "too_big");
      if (msg.length) safe(msg, ev.data);
      else if (queued.length < 4) queued.push(ev.data);
      else conn.close(1008, "policy");
    });
    ws.addEventListener("close", (ev) => finish(ev.code ?? 1006));
    ws.addEventListener("error", () => finish(1006));
  });
};
