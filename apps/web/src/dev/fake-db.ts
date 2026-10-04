/**
 * DEV/TEST ONLY. An in-memory stand-in for the supabase-js slice packages/client uses: tables with
 * `rev`, eq/gt/order/limit, private channels. Every write broadcasts a pointer on every open
 * channel, like the database triggers do. Never shipped (see src/lib/env.ts DEV_BACKEND).
 */
import type { BrowserSupabase } from "@chalito/client";

export const DEV_MARKER = "CHALITO_DEV_BACKEND_DO_NOT_SHIP";

type Row = Record<string, unknown>;
type Listener = (msg: { event?: string; payload?: unknown }) => void;
interface Channel {
  topic: string;
  handlers: Listener[];
  removed: boolean;
}
export interface WriteEvent {
  table: string;
  op: "insert" | "update" | "delete";
  row: Row;
  /** Written through the client (the browser), as opposed to seeded by the simulated agent/server. */
  byClient: boolean;
}

export class FakeDb {
  readonly tables = new Map<string, Row[]>();
  /** Every row the browser wrote, as written (for the ciphertext-only check). */
  readonly clientWrites: { table: string; op: string; row: Row }[] = [];
  readonly #channels: Channel[] = [];
  readonly #onWrite = new Set<(e: WriteEvent) => void>();
  #rev = 0;

  rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  onWrite(fn: (e: WriteEvent) => void): void {
    this.#onWrite.add(fn);
  }

  #notify(e: WriteEvent) {
    for (const ch of this.#channels)
      if (!ch.removed) for (const h of ch.handlers) h({ event: e.table, payload: { table: e.table, op: e.op } });
    for (const fn of this.#onWrite) queueMicrotask(() => fn(e));
  }

  /** Server/agent-side write. */
  insert(table: string, row: Row, byClient = false): Row {
    const r = { ...row, rev: ++this.#rev };
    this.rows(table).push(r);
    this.#notify({ table, op: "insert", row: r, byClient });
    return r;
  }
  update(table: string, match: (r: Row) => boolean, patch: Row, byClient = false): void {
    for (const r of this.rows(table).filter(match)) {
      Object.assign(r, patch, { rev: ++this.#rev });
      this.#notify({ table, op: "update", row: r, byClient });
    }
  }
  remove(table: string, match: (r: Row) => boolean): void {
    const keep = this.rows(table).filter((r) => !match(r));
    this.tables.set(table, keep);
  }

  /** The BrowserSupabase shape connect() expects. */
  client(session: { access_token: string }): BrowserSupabase {
    const from = (table: string) => {
      const st: {
        op: "select" | "insert" | "update" | "delete";
        body?: Row;
        eq: [string, unknown][];
        gt: [string, unknown][];
        order?: string;
        limit?: number;
        single: boolean;
      } = { op: "select", eq: [], gt: [], single: false };
      const exec = () => {
        const match = (r: Row) =>
          st.eq.every(([k, v]) => r[k] === v) && st.gt.every(([k, v]) => Number(r[k]) > Number(v));
        switch (st.op) {
          case "insert":
            this.clientWrites.push({ table, op: "insert", row: structuredClone(st.body!) });
            this.insert(table, st.body!, true);
            return { data: null, error: null };
          case "update":
            this.clientWrites.push({ table, op: "update", row: structuredClone(st.body!) });
            this.update(table, match, st.body!, true);
            return { data: null, error: null };
          case "delete":
            this.remove(table, match);
            return { data: null, error: null };
          case "select": {
            let out = this.rows(table)
              .filter(match)
              .map((r) => structuredClone(r));
            if (st.order) out.sort((a, b) => Number(a[st.order!]) - Number(b[st.order!]));
            if (st.limit !== undefined) out = out.slice(0, st.limit);
            return { data: st.single ? (out[0] ?? null) : out, error: null };
          }
        }
      };
      const q = {
        select: () => q,
        insert: (row: Row) => ((st.op = "insert"), (st.body = row), q),
        update: (patch: Row) => ((st.op = "update"), (st.body = patch), q),
        delete: () => ((st.op = "delete"), q),
        eq: (c: string, v: unknown) => (st.eq.push([c, v]), q),
        gt: (c: string, v: unknown) => (st.gt.push([c, v]), q),
        order: (c: string) => ((st.order = c), q),
        limit: (n: number) => ((st.limit = n), q),
        maybeSingle: () => ((st.single = true), q),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve().then(exec).then(ok, bad),
      };
      return q;
    };
    const channel = (topic: string) => {
      const ch: Channel = { topic, handlers: [], removed: false };
      const api = {
        on: (_t: string, _f: unknown, cb: Listener) => (ch.handlers.push(cb), api),
        subscribe: (cb?: (status: string) => void) => {
          this.#channels.push(ch);
          queueMicrotask(() => cb?.("SUBSCRIBED"));
          return api;
        },
        __ch: ch,
      };
      return api;
    };
    const auth = {
      getSession: async () => ({ data: { session }, error: null }),
      verifyOtp: async () => ({ data: { session }, error: null }),
      setSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
      signOut: async () => undefined,
    };
    return {
      from,
      channel,
      removeChannel: async (c: { __ch: Channel }) => ((c.__ch.removed = true), "ok"),
      removeAllChannels: async () => {
        for (const c of this.#channels) c.removed = true;
        return [];
      },
      auth,
      realtime: { setAuth: () => undefined },
    } as unknown as BrowserSupabase;
  }
}
