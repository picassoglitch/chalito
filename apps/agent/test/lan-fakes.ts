import { randomBytes, toB64url } from "@chalito/crypto";
import type { LanGrant, LanToken } from "@chalito/protocol";
import type { LanCloud } from "../src/lan/cloud.js";
import type { LanConn } from "../src/lan/ws.js";

/** Two connected in-memory LanConns; `tap` sees every message a→b (to capture or drop it). */
export const memoryPair = (tap?: (dir: "a2b" | "b2a", text: string) => string | null) => {
  const mk = (name: string) => {
    const msg: ((t: string) => void)[] = [];
    const closed: ((c: number) => void)[] = [];
    const queued: string[] = [];
    return {
      name,
      msg,
      closed,
      queued,
      done: false,
      lastClose: 0,
    };
  };
  const a = mk("a");
  const b = mk("b");
  const deliver = (to: typeof a, t: string) => {
    if (to.done) return;
    if (to.msg.length) for (const cb of to.msg) cb(t);
    else to.queued.push(t);
  };
  const shut = (x: typeof a, code: number) => {
    if (x.done) return;
    x.done = true;
    x.lastClose = code;
    for (const cb of x.closed) cb(code);
  };
  const conn = (me: typeof a, other: typeof a, dir: "a2b" | "b2a"): LanConn => ({
    remote: `mem:${other.name}`,
    send: (t) => {
      if (me.done) return;
      const out = tap ? tap(dir, t) : t;
      if (out !== null) queueMicrotask(() => deliver(other, out));
    },
    close: (code = 1000) => {
      shut(me, code);
      queueMicrotask(() => shut(other, code));
    },
    onMessage: (cb) => {
      me.msg.push(cb);
      for (const t of me.queued.splice(0)) cb(t);
    },
    onClose: (cb) => void me.closed.push(cb),
  });
  const ca = conn(a, b, "a2b");
  const cb = conn(b, a, "b2a");
  /** Injects a raw message as if `from` had sent it. */
  const inject = (from: "a" | "b", t: string) => deliver(from === "a" ? b : a, t);
  return { a: ca, b: cb, inject, state: { a, b } };
};

export const mintToken = async (ttlMs = 15 * 60 * 1000, now = Date.now()): Promise<LanToken> => ({
  tid: await toB64url(await randomBytes(16)),
  secret: await toB64url(await randomBytes(32)),
  expiresAt: now + ttlMs,
});

/** The cloud's lan_token(): one token per owner, the owner's non-revoked agents as peers. */
export class FakeLanCloud {
  readonly tokens = new Map<string, LanToken[]>();
  readonly devices: { owner: string; deviceId: string; pubSign: string; revoked?: boolean }[] = [];
  grants = 0;
  fail = false;

  async token(owner: string): Promise<LanToken> {
    let list = this.tokens.get(owner);
    if (!list?.length) {
      list = [await mintToken()];
      this.tokens.set(owner, list);
    }
    return list[0]!;
  }

  for(owner: string, deviceId: string): LanCloud {
    return {
      grant: async (): Promise<LanGrant> => {
        this.grants += 1;
        if (this.fail) throw new Error("cloud down");
        const me = this.devices.find((d) => d.deviceId === deviceId && d.owner === owner && !d.revoked);
        if (!me) throw new Error("not allowed");
        await this.token(owner);
        return {
          tokens: [...(this.tokens.get(owner) ?? [])],
          peers: this.devices
            .filter((d) => d.owner === owner && !d.revoked && d.deviceId !== deviceId)
            .map((d) => ({ deviceId: d.deviceId, pubSign: d.pubSign })),
        };
      },
    };
  }
}
