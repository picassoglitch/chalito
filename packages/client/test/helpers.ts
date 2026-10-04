import {
  deriveDeviceId,
  fromB64url,
  generateBoxKeyPair,
  generateSigningKeyPair,
  openJson,
  sealJson,
  signEnvelope,
  toB64url,
  type BoxKeyPair,
  type SigningKeyPair,
} from "@chalito/crypto";
import type { SealedEnvelope } from "@chalito/protocol";
import type { ClientKeys } from "../src/keys.js";
import type { SupaChannel, SupaQuery, SupaResult } from "../src/supa.js";

type Row = Record<string, unknown>;

export interface Device {
  deviceId: string;
  sign: SigningKeyPair;
  box: BoxKeyPair;
  pubSign: string;
  pubBox: string;
}

export const newDevice = async (): Promise<Device> => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  return {
    deviceId: await deriveDeviceId(sign.publicKey),
    sign,
    box,
    pubSign: await toB64url(sign.publicKey),
    pubBox: await toB64url(box.publicKey),
  };
};

/** A real-crypto ClientKeys (what packages/client-keys will provide), for tests. */
export const testKeys = (me: Device, trustedAgents: Record<string, string> = {}): ClientKeys => ({
  deviceId: me.deviceId,
  pubBox: me.pubBox,
  sign: (ctx, body) => signEnvelope(ctx, body, me.deviceId, me.sign.secretKey),
  open: (env, aad) => openJson(env, me.deviceId, me.box, aad),
  seal: async (value, recipients, aad) => {
    const keys: Record<string, Uint8Array> = {};
    for (const [id, k] of Object.entries(recipients)) keys[id] = await fromB64url(k);
    return sealJson(value, keys, aad) as Promise<SealedEnvelope>;
  },
  trustedAgentBoxKey: (id) => trustedAgents[id] ?? null,
});

interface Channel extends SupaChannel {
  topic: string;
  opts: { config: { private: boolean } };
  handlers: ((msg: { event?: string; payload?: unknown }) => void)[];
  status?: (status: string, err?: Error) => void;
  removed: boolean;
}

/** In-memory stand-in for the supabase-js slice (tables with rev, eq/gt/order/limit, channels). */
export class FakeSupabase {
  readonly tables = new Map<string, Row[]>();
  readonly ops: {
    table: string;
    op: string;
    filters: [string, unknown][];
    gts: [string, unknown][];
    body?: unknown;
  }[] = [];
  readonly channels: Channel[] = [];
  readonly authTokens: (string | null | undefined)[] = [];
  #rev = 0;
  #fail: { error: { message: string; code?: string }; times: number } | null = null;

  realtime = { setAuth: (t?: string | null) => void this.authTokens.push(t) };

  rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }
  /** Writes as the database (the agent, the server): bumps rev, no broadcast. */
  seed(table: string, row: Row): Row {
    const r = { ...row, rev: ++this.#rev };
    this.rows(table).push(r);
    return r;
  }
  touch(table: string, match: (r: Row) => boolean, patch: Row) {
    for (const r of this.rows(table).filter(match)) Object.assign(r, patch, { rev: ++this.#rev });
  }
  failNext(message: string, code?: string, times = 1) {
    this.#fail = { error: { message, code }, times };
  }
  broadcast(topic: string, payload: unknown) {
    for (const ch of this.channels)
      if (ch.topic === topic && !ch.removed) for (const h of ch.handlers) h({ event: "x", payload });
  }
  rejoin(topic: string) {
    for (const ch of this.channels) if (ch.topic === topic && !ch.removed) ch.status?.("SUBSCRIBED");
  }
  status(topic: string, s: string) {
    for (const ch of this.channels) if (ch.topic === topic && !ch.removed) ch.status?.(s);
  }

  from(table: string): SupaQuery {
    const st: {
      op: "select" | "insert" | "update" | "delete";
      body?: Row;
      filters: [string, unknown][];
      gts: [string, unknown][];
      order?: string;
      limit?: number;
      single: boolean;
    } = { op: "select", filters: [], gts: [], single: false };
    const exec = (): SupaResult => {
      this.ops.push({ table, op: st.op, filters: [...st.filters], gts: [...st.gts], body: st.body });
      if (this.#fail) {
        const { error } = this.#fail;
        if (--this.#fail.times <= 0) this.#fail = null;
        return { data: null, error };
      }
      const match = (r: Row) =>
        st.filters.every(([k, v]) => r[k] === v) && st.gts.every(([k, v]) => Number(r[k]) > Number(v));
      const rows = this.rows(table);
      switch (st.op) {
        case "insert":
          this.seed(table, st.body!);
          return { data: null, error: null };
        case "update":
          this.touch(table, match, st.body!);
          return { data: null, error: null };
        case "delete":
          this.tables.set(
            table,
            rows.filter((r) => !match(r)),
          );
          return { data: null, error: null };
        case "select": {
          let out = rows.filter(match).map((r) => ({ ...r }));
          if (st.order) out.sort((a, b) => Number(a[st.order!]) - Number(b[st.order!]));
          if (st.limit !== undefined) out = out.slice(0, st.limit);
          return { data: st.single ? (out[0] ?? null) : out, error: null };
        }
      }
    };
    const q: SupaQuery = {
      select: () => q,
      insert: (row) => ((st.op = "insert"), (st.body = row), q),
      update: (patch) => ((st.op = "update"), (st.body = patch), q),
      delete: () => ((st.op = "delete"), q),
      eq: (c, v) => (st.filters.push([c, v]), q),
      gt: (c, v) => (st.gts.push([c, v]), q),
      order: (c) => ((st.order = c), q),
      limit: (n) => ((st.limit = n), q),
      maybeSingle: () => ((st.single = true), q),
      then: (ok, bad) => Promise.resolve().then(exec).then(ok, bad),
    };
    return q;
  }

  channel(topic: string, opts: { config: { private: boolean } }): SupaChannel {
    const ch: Channel = {
      topic,
      opts,
      handlers: [],
      removed: false,
      on: (_t, _f, cb) => (ch.handlers.push(cb), ch),
      subscribe: (cb) => {
        ch.status = cb;
        queueMicrotask(() => cb?.("SUBSCRIBED"));
        return ch;
      },
    };
    this.channels.push(ch);
    return ch;
  }
  async removeChannel(ch: SupaChannel) {
    (ch as Channel).removed = true;
    return "ok";
  }
  async removeAllChannels() {
    for (const c of this.channels) c.removed = true;
    return [];
  }
}

export const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
