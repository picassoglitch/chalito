import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@chalito/protocol";
import { grantFromRow, supabaseLanCloud } from "../src/lan/cloud.js";
import { lanTee } from "../src/lan/tee.js";
import { dialHandshake } from "../src/lan/handshake.js";
import { peerEventLog } from "../src/lan/wire.js";
import { LAN_PRE_AUTH_BYTES, dialLan, listenLan, type LanConn } from "../src/lan/ws.js";
import { createLogger } from "../src/redact.js";
import { MemoryStore } from "../src/store.js";

const B64 = (n: number) => "A".repeat(Math.ceil((n * 4) / 3));

describe("LAN grant from the cloud", () => {
  it("maps chalito.lan_token()'s row and refuses a malformed one", async () => {
    const row = {
      tokens: [{ tid: B64(16), secret: B64(32), expires_at: 1_790_000_000_000 }],
      peers: [{ device_id: "dev_b", pub_sign: B64(32) }],
    };
    expect(grantFromRow(row)).toEqual({
      tokens: [{ tid: B64(16), secret: B64(32), expiresAt: 1_790_000_000_000 }],
      peers: [{ deviceId: "dev_b", pubSign: B64(32) }],
    });
    expect(() => grantFromRow({ tokens: [], peers: [] })).toThrow();
    expect(() => grantFromRow({ tokens: [{ tid: "x", secret: B64(32), expires_at: 1 }], peers: [] })).toThrow();
    const calls: string[] = [];
    const cloud = supabaseLanCloud({
      rpc: async (fn) => {
        calls.push(fn);
        return { data: row, error: null };
      },
    });
    expect((await cloud.grant()).peers).toHaveLength(1);
    expect(calls).toEqual(["lan_token"]);
    await expect(
      supabaseLanCloud({ rpc: async () => ({ data: null, error: { message: "denied" } }) }).grant(),
    ).rejects.toThrow(/denied/);
  });
});

describe("lanTee", () => {
  it("copies events to the LAN and still writes them to the cloud; everything else passes through", async () => {
    const store = new MemoryStore();
    const sent: AgentEvent[] = [];
    const tee = lanTee(store, () => ({ broadcastEvent: (e) => void sent.push(e) }));
    const e = {
      v: 1,
      eid: "e1",
      sid: "s1",
      deviceId: "dev_a",
      seq: 0,
      t: 1,
      urgency: "low",
      type: "session.state",
      state: "idle",
    } as unknown as AgentEvent;
    await tee.writeEvent(e);
    expect(sent).toEqual([e]);
    expect(store.events).toEqual([e]);
    await tee.upsertSession("s1", { a: 1 });
    expect(store.sessions.get("s1")).toEqual({ a: 1 });
    const broken = lanTee(store, () => ({
      broadcastEvent: () => {
        throw new Error("boom");
      },
    }));
    await broken.writeEvent(e);
    expect(store.events).toHaveLength(2);
    await lanTee(store, () => null).writeEvent(e);
    expect(store.events).toHaveLength(3);
  });
});

describe("LAN WebSocket", () => {
  const listen = async (maxBytes = 64, extra: { maxConnections?: number; maxPerAddress?: number } = {}) => {
    const conns: LanConn[] = [];
    const l = await listenLan({
      host: "127.0.0.1",
      port: 0,
      path: "/p",
      maxBytes,
      maxConnections: extra.maxConnections ?? 2,
      ...(extra.maxPerAddress !== undefined ? { maxPerAddress: extra.maxPerAddress } : {}),
      onConn: (c) => conns.push(c),
    });
    return { l, conns };
  };

  it("moves text both ways and enforces the size cap", async () => {
    const { l, conns } = await listen();
    const c = await dialLan(`ws://127.0.0.1:${l.port}/p`, 64, 1000);
    const got: string[] = [];
    c.onMessage((t) => got.push(t));
    let closed = 0;
    c.onClose((code) => (closed = code));
    c.send("hola");
    await new Promise((r) => setTimeout(r, 30));
    const s = conns[0]!;
    const atServer: string[] = [];
    s.onMessage((t) => atServer.push(t)); // queued before a listener: delivered now
    expect(atServer).toEqual(["hola"]);
    s.send("qué tal");
    await new Promise((r) => setTimeout(r, 30));
    expect(got).toEqual(["qué tal"]);
    c.send("x".repeat(200));
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(1009);
    await l.close();
  });

  it("refuses other paths, missing upgrade headers and too many connections", async () => {
    const { l } = await listen();
    await expect(dialLan(`ws://127.0.0.1:${l.port}/other`, 64, 500)).rejects.toThrow();
    const a = await dialLan(`ws://127.0.0.1:${l.port}/p`, 64, 500);
    const b = await dialLan(`ws://127.0.0.1:${l.port}/p`, 64, 500);
    await expect(dialLan(`ws://127.0.0.1:${l.port}/p`, 64, 500)).rejects.toThrow();
    const raw = await new Promise<string>((resolve) => {
      const s = connect(l.port, "127.0.0.1", () => s.write("GET /p HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
      let buf = "";
      s.on("data", (d) => (buf += d.toString()));
      s.on("close", () => resolve(buf));
      s.on("error", () => resolve(buf));
    });
    expect(raw).not.toContain("101");
    a.close();
    b.close();
    await l.close();
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("until the handshake is ready, a message is at most 4 KB; after ready(), the full size", async () => {
    const big = "x".repeat(LAN_PRE_AUTH_BYTES + 1);
    const { l, conns } = await listen(64 * 1024);
    const c = await dialLan(`ws://127.0.0.1:${l.port}/p`, 64 * 1024, 1000);
    let closed = 0;
    c.onClose((code) => (closed = code));
    c.send(big);
    await sleep(50);
    expect(closed).toBe(1009);
    const d = await dialLan(`ws://127.0.0.1:${l.port}/p`, 64 * 1024, 1000);
    await sleep(20);
    const s2 = conns[1]!;
    const got: string[] = [];
    s2.onMessage((t) => got.push(t));
    s2.ready!();
    d.send(big);
    await sleep(50);
    expect(got).toEqual([big]);
    d.close();
    await l.close();
  });

  it("hold() keeps later frames in the socket until ready()", async () => {
    const { l, conns } = await listen(64 * 1024);
    const c = await dialLan(`ws://127.0.0.1:${l.port}/p`, 64 * 1024, 1000);
    await sleep(20);
    const s1 = conns[0]!;
    const got: string[] = [];
    s1.onMessage((t) => {
      got.push(t);
      if (got.length === 1) s1.hold!();
    });
    c.send("uno");
    c.send("dos");
    c.send("x".repeat(10_000));
    await sleep(50);
    expect(got).toEqual(["uno"]);
    s1.ready!();
    await sleep(50);
    expect(got).toEqual(["uno", "dos", "x".repeat(10_000)]);
    c.close();
    await l.close();
  });

  it("caps connections per address (pre-auth DoS)", async () => {
    const { l } = await listen(64, { maxConnections: 16, maxPerAddress: 2 });
    const a = await dialLan(`ws://127.0.0.1:${l.port}/p`, 64, 500);
    const b = await dialLan(`ws://127.0.0.1:${l.port}/p`, 64, 500);
    await expect(dialLan(`ws://127.0.0.1:${l.port}/p`, 64, 500)).rejects.toThrow();
    a.close();
    await sleep(50);
    const again = await dialLan(`ws://127.0.0.1:${l.port}/p`, 64, 500); // a slot freed
    again.close();
    b.close();
    await l.close();
  });

  it("reassembles a frame sent one byte at a time", async () => {
    const { l, conns } = await listen(64 * 1024);
    const sock = connect(l.port, "127.0.0.1");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write(
      "GET /p HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${Buffer.alloc(16, 1).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    await sleep(30);
    const text = Buffer.from("y".repeat(300));
    const mask = Buffer.from([1, 2, 3, 4]);
    const head = Buffer.from([0x81, 0x80 | 126, 300 >> 8, 300 & 0xff]);
    const body = Buffer.from(text.map((b, i) => b ^ mask[i & 3]!));
    const frame = Buffer.concat([head, mask, body]);
    const got: string[] = [];
    conns[0]!.onMessage((t) => got.push(t));
    for (const byte of frame) {
      sock.write(Buffer.from([byte]));
      await new Promise((r) => setImmediate(r));
    }
    for (let i = 0; i < 100 && !got.length; i++) await sleep(10);
    expect(got).toEqual(["y".repeat(300)]);
    sock.destroy();
    await l.close();
  });
});

describe("LAN handshake queue", () => {
  it("closes the socket on overflow instead of dropping frames", async () => {
    const msgs: ((t: string) => void)[] = [];
    let closedWith: string | null = null;
    const conn: LanConn = {
      remote: "fake",
      send: () => {
        // The other side floods before the dialer reads its first message.
        for (let i = 0; i < 40; i++) for (const m of msgs) m(`junk${i}`);
      },
      close: (_code, reason) => void (closedWith ??= reason ?? ""),
      onMessage: (cb) => void msgs.push(cb),
      onClose: () => undefined,
    };
    const token = { tid: "A".repeat(22), secret: "A".repeat(43), expiresAt: Date.now() + 60_000 };
    const ctx = {
      deviceId: "dev_a",
      sign: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(64) },
      tokens: () => [token],
      peerKey: () => null,
      now: Date.now,
    };
    await expect(dialHandshake(conn, ctx, token, null, 500)).rejects.toThrow();
    expect(closedWith).toBe("overflow");
  });
});

describe("peerEventLog", () => {
  it("counts a peer's live events and logs at most once per window, metadata only", () => {
    const lines: string[] = [];
    let now = 0;
    const onEvent = peerEventLog(
      createLogger((l) => lines.push(l)),
      () => now,
      1000,
    );
    const e = { type: "message.assistant", sid: "s", ct: { ct: "secret" } } as unknown as AgentEvent;
    onEvent("dev_b", e);
    onEvent("dev_b", e);
    now = 1500;
    onEvent("dev_b", e);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"count":2');
    expect(lines.join("")).not.toContain("secret");
  });
});
