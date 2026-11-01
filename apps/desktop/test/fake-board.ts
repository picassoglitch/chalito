import { createHash, createHmac, randomBytes } from "node:crypto";
import type { BoardPort, BoardStatus } from "../src/lib/board/protocol.js";
import { hmacKey, keyIdOf, type PairStore } from "../src/lib/board/pairing.js";

interface Upload {
  key: string;
  frames: string[];
  w: number;
  h: number;
  data: Map<string, number[]>;
  frame: number;
  offset: number;
}

/** The board's side of docs/BOARD_LINK.md in process: hello, a card store with flow-controlled
 * chunks and a hash check, and button presses. */
export class FakeBoard implements BoardPort {
  status_: BoardStatus = { state: "absent" };
  card: string | null = null;
  /** Lines the desktop wrote, parsed. */
  readonly got: Record<string, unknown>[] = [];
  /** Corrupts the next N uploads' first byte (a hash mismatch). */
  corrupt = 0;
  /** Unplugs itself after accepting this many chunks. */
  unplugAfterChunks = Infinity;
  /** Holds card-progress until release(): proves the desktop waits before the next chunk. */
  holdProgress = false;
  /** The host secret this board was paired with (BOARD_LINK pairing). */
  secret: Buffer | null = null;
  /** The pair-begin waiting for the person to hold BOOT. */
  pending: { secret: Buffer; code: string } | null = null;
  /** Holds BOOT by itself as soon as a pairing starts. */
  autoConfirm = false;
  /** Fails the next N writes of a message type (a USB write error). */
  readonly failNext = new Map<string, number>();
  #held: (() => void)[] = [];
  #chunks = 0;
  #upload: Upload | null = null;
  #lines = new Set<(l: string) => void>();
  #statuses = new Set<(s: BoardStatus) => void>();

  status = async () => this.status_;
  onLine = (cb: (l: string) => void) => (this.#lines.add(cb), () => void this.#lines.delete(cb));
  onStatus = (cb: (s: BoardStatus) => void) => (this.#statuses.add(cb), () => void this.#statuses.delete(cb));

  plug(): void {
    this.setStatus({ state: "connected", port: "/dev/fake" });
    // Boot logs share the port, then the board says hello by itself.
    this.emit("I (312) main_task: Calling app_main()");
    this.#hello();
  }

  unplug(): void {
    this.#upload = null;
    this.#held = [];
    this.setStatus({ state: "absent" });
  }

  /** A line from the board (a log, a button, anything). */
  emit(line: string | object): void {
    const l = typeof line === "string" ? line : JSON.stringify(line);
    queueMicrotask(() => {
      if (this.status_.state === "connected") for (const cb of [...this.#lines]) cb(l);
    });
  }

  release(): void {
    const h = this.#held;
    this.#held = [];
    for (const f of h) f();
  }

  get keyId(): string | null {
    return this.secret ? createHash("sha256").update(this.secret).digest("hex").slice(0, 16) : null;
  }

  /** The person saw the code and held BOOT. */
  confirmPairing(): void {
    if (!this.pending) throw new Error("no pairing");
    this.secret = this.pending.secret;
    this.pending = null;
    this.emit({ v: 1, type: "pair-ok", pair: this.keyId });
  }

  /** The person held BOOT 10 s on the board and confirmed forgetting this computer. */
  forgetOnBoard(): void {
    this.secret = null;
    this.emit({ v: 1, type: "pair-cleared" });
  }

  cancelPairing(): void {
    this.pending = null;
    this.emit({ v: 1, type: "pair-cancel" });
  }

  /** A button decision; `mac` defaults to the right one for this board's secret. */
  decide(aid: string, ticket: string, allow: boolean, mac?: string | null): void {
    const right = this.secret
      ? createHmac("sha256", this.secret).update(`v1|decide|${aid}|${ticket}|${allow}`).digest("hex")
      : undefined;
    const m = mac === undefined ? right : mac;
    this.emit({ v: 1, type: "decide", aid, ticket, allow, ...(m === null || m === undefined ? {} : { mac: m }) });
  }

  sent(type: string): Record<string, unknown>[] {
    return this.got.filter((m) => m.type === type);
  }

  write = async (line: string): Promise<void> => {
    if (this.status_.state !== "connected") throw new Error("board not connected");
    if (line.includes("\n") || line.length > 4096) throw new Error("bad line");
    const m = JSON.parse(line) as Record<string, unknown>;
    if (m.v !== 1) throw new Error("bad version");
    const fail = this.failNext.get(m.type as string) ?? 0;
    if (fail > 0) {
      this.failNext.set(m.type as string, fail - 1);
      throw new Error("write failed");
    }
    this.got.push(m);
    switch (m.type) {
      case "hello":
        return this.#hello();
      case "pair-begin":
        this.pending = { secret: Buffer.from(m.secret as string, "base64"), code: m.code as string };
        if (this.pending.secret.length !== 32 || !/^\d{6}$/.test(this.pending.code)) throw new Error("bad pair-begin");
        if (this.autoConfirm) this.confirmPairing();
        return;
      case "pair-reset":
        this.secret = null;
        return;
      case "card-begin":
        this.#upload = {
          key: m.key as string,
          frames: m.frames as string[],
          w: m.w as number,
          h: m.h as number,
          data: new Map(),
          frame: 0,
          offset: 0,
        };
        return;
      case "card-chunk":
        return this.#chunk(m);
      case "card-end":
        return this.#end(m.key as string);
    }
  };

  setStatus(s: BoardStatus): void {
    this.status_ = s;
    for (const cb of [...this.#statuses]) cb(s);
  }

  #hello(): void {
    this.emit({
      v: 1,
      type: "hello",
      fw: "0.1.0",
      board: "waveshare-esp32-c6-lcd-1.47",
      w: 172,
      h: 320,
      card: this.card,
      pair: this.keyId,
    });
  }

  #chunk(m: Record<string, unknown>): void {
    const u = this.#upload;
    const frame = m.frame as string;
    const offset = m.offset as number;
    const bytes = [...Buffer.from(m.data as string, "base64")];
    if (!u || bytes.length > 2048)
      return this.emit({ v: 1, type: "card-ack", key: u?.key ?? "", ok: false, reason: "size" });
    // In order: the expected frame at the expected offset, or the frame after it from 0.
    const size = u.frames[u.frame] === "background" ? 172 * 320 * 2 : u.w * u.h * 2;
    const next = u.offset >= size && frame === u.frames[u.frame + 1] && offset === 0;
    if (!(frame === u.frames[u.frame] && offset === u.offset) && !next) {
      this.#upload = null;
      return this.emit({ v: 1, type: "card-ack", key: u.key, ok: false, reason: "sequence" });
    }
    if (next) {
      u.frame++;
      u.offset = 0;
    }
    u.data.set(frame, [...(u.data.get(frame) ?? []), ...bytes]);
    u.offset += bytes.length;
    const progress = () => this.emit({ v: 1, type: "card-progress", key: u.key, frame, offset });
    if (++this.#chunks >= this.unplugAfterChunks) {
      this.unplugAfterChunks = Infinity;
      return this.unplug();
    }
    if (this.holdProgress) this.#held.push(progress);
    else progress();
  }

  #end(key: string): void {
    const u = this.#upload;
    this.#upload = null;
    if (!u || u.key !== key) return this.emit({ v: 1, type: "card-ack", key, ok: false, reason: "sequence" });
    const all = Buffer.from(u.frames.flatMap((f) => u.data.get(f) ?? []));
    if (this.corrupt > 0 && all.length) {
      this.corrupt--;
      all[0] = all[0]! ^ 0xff;
    }
    const ok = createHash("sha256").update(all).digest("hex") === key;
    if (ok) this.card = key;
    this.emit({ v: 1, type: "card-ack", key, ok, ...(ok ? {} : { reason: "hash" }) });
  }
}

/** A board already paired with this store (as if the person had paired it earlier). */
export const prePair = async (board: FakeBoard, store: PairStore): Promise<void> => {
  const secret = new Uint8Array(randomBytes(32));
  board.secret = Buffer.from(secret);
  await store.save({ keyId: await keyIdOf(secret), key: await hmacKey(secret) });
};
