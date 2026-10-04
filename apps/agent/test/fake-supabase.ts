import type { RealtimeClient } from "../src/cloud.js";
import type { SupaChannel, SupaQuery, SupaResult } from "../src/supabase-store.js";

type Row = Record<string, unknown>;

interface Channel extends SupaChannel {
  topic: string;
  opts: { config: { private: boolean } };
  handlers: ((msg: { event?: string; payload?: unknown }) => void)[];
  status?: (status: string, err?: Error) => void;
  removed: boolean;
}

/**
 * In-memory stand-in for the parts of supabase-js the agent uses. It records every
 * operation, applies eq() filters, keeps an identity `cursor`, and lets tests play the
 * database side: broadcast a pointer, rejoin a channel, or fail the next call.
 */
export class FakeSupabase implements RealtimeClient {
  readonly tables = new Map<string, Row[]>();
  readonly ops: { table: string; op: string; filters: [string, unknown][]; body?: unknown }[] = [];
  readonly rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  readonly channels: Channel[] = [];
  readonly authTokens: (string | null | undefined)[] = [];
  #cursor = 0;
  #rev = 0;
  /** bump_rev: a fresh rev, as the database gives every insert and update. */
  bump(row: Row): Row {
    row.rev = ++this.#rev;
    return row;
  }
  #failNext: { message: string; code?: string } | null = null;

  constructor(readonly accessToken?: () => Promise<string | null>) {}

  realtime = { setAuth: (t?: string | null) => void this.authTokens.push(t) };

  rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  /** Inserts as the database would (e.g. a phone's command), without telling anyone. */
  seed(table: string, row: Row): Row {
    const r = { cursor: ++this.#cursor, ...row, rev: ++this.#rev };
    this.rows(table).push(r);
    return r;
  }

  failNext(message: string, code?: string, times = 1) {
    this.#failNext = { message, code };
    this.#failTimes = times;
  }
  #failTimes = 0;

  /** The database's realtime.send to a topic. */
  broadcast(topic: string, payload: unknown) {
    for (const ch of this.channels)
      if (ch.topic === topic && !ch.removed) for (const h of ch.handlers) h({ event: "x", payload });
  }

  /** A reconnect: the client rejoins and reports SUBSCRIBED again. */
  rejoin(topic: string) {
    for (const ch of this.channels) if (ch.topic === topic && !ch.removed) ch.status?.("SUBSCRIBED");
  }

  from(table: string): SupaQuery {
    const state: {
      op: "select" | "insert" | "update" | "delete";
      cols?: string;
      body?: Row;
      filters: [string, unknown][];
      gts: [string, number][];
      order?: string;
      single: boolean;
    } = { op: "select", filters: [], gts: [], single: false };
    const exec = (): SupaResult => {
      this.ops.push({ table, op: state.op, filters: [...state.filters], body: state.body });
      if (this.#failNext) {
        const error = this.#failNext;
        if (--this.#failTimes <= 0) this.#failNext = null;
        return { data: null, error };
      }
      const match = (r: Row) =>
        state.filters.every(([k, v]) => r[k] === v) && state.gts.every(([k, v]) => Number(r[k]) > v);
      const rows = this.rows(table);
      switch (state.op) {
        case "insert":
          this.seed(table, state.body!);
          return { data: null, error: null };
        case "update":
          for (const r of rows.filter(match)) this.bump(Object.assign(r, state.body));
          return { data: null, error: null };
        case "delete": {
          const keep = rows.filter((r) => !match(r));
          this.tables.set(table, keep);
          return { data: null, error: null };
        }
        case "select": {
          let out = rows.filter(match);
          if (state.order) out = [...out].sort((a, b) => Number(a[state.order!]) - Number(b[state.order!]));
          const cols = state.cols && state.cols !== "*" ? state.cols.split(",").map((c) => c.trim()) : null;
          const proj = out.map((r) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : { ...r }));
          return { data: state.single ? (proj[0] ?? null) : proj, error: null };
        }
      }
    };
    const q: SupaQuery = {
      select: (cols) => ((state.cols = cols ?? "*"), q),
      insert: (row) => ((state.op = "insert"), (state.body = row), q),
      update: (patch) => ((state.op = "update"), (state.body = patch), q),
      delete: () => ((state.op = "delete"), q),
      eq: (c, v) => (state.filters.push([c, v]), q),
      gt: (c, v) => (state.gts.push([c, Number(v)]), q),
      order: (c) => ((state.order = c), q),
      maybeSingle: () => ((state.single = true), q),
      then: (ok, bad) => Promise.resolve().then(exec).then(ok, bad),
    };
    return q;
  }

  rpc(fn: string, args: Record<string, unknown>): PromiseLike<SupaResult> {
    this.rpcs.push({ fn, args });
    if (fn === "session_merge") {
      const rows = this.rows("sessions");
      const r = rows.find((x) => x.sid === args.p_sid);
      if (r) this.bump(Object.assign(r, { doc: { ...(r.doc as Row), ...(args.p_patch as Row) } }));
      else this.seed("sessions", { sid: args.p_sid, doc: args.p_patch });
    }
    return Promise.resolve({ data: null, error: null });
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
    for (const ch of this.channels) ch.removed = true;
    return [];
  }
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
