import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@chalito/protocol";
import { grantFromRow, supabaseLanCloud } from "../src/lan/cloud.js";
import { lanTee } from "../src/lan/tee.js";
import { dialLan, listenLan, type LanConn } from "../src/lan/ws.js";
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
  const listen = async (maxBytes = 64) => {
    const conns: LanConn[] = [];
    const l = await listenLan({
      host: "127.0.0.1",
      port: 0,
      path: "/p",
      maxBytes,
      maxConnections: 2,
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
});
