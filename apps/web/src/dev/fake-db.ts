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

/** Client writes survive full page loads (redirects) through sessionStorage, for the e2e checks. */
export const WRITE_LOG_KEY = "chalito.dev.clientWrites";
const logWrite = (w: { table: string; op: string; row: Row }) => {
  try {
    const all = JSON.parse(sessionStorage.getItem(WRITE_LOG_KEY) ?? "[]") as unknown[];
    all.push(w);
    sessionStorage.setItem(WRITE_LOG_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: in-memory only */
  }
};

/** A Supabase Auth session as the fake hands it out. */
export interface FakeSession {
  access_token: string;
  user: { id: string; app_metadata: Record<string, unknown> };
}

export class FakeDb {
  /** The browser's current session (one per page, like supabase-js with persistent storage). */
  session: FakeSession | null = null;
  readonly #authListeners = new Set<(e: string, s: FakeSession | null) => void>();
  /** Magic-link token hashes the fake api issued, and the session each opens. */
  readonly tokenHashes = new Map<string, FakeSession>();

  setSession(s: FakeSession | null): void {
    this.session = s;
    for (const l of this.#authListeners) queueMicrotask(() => l(s ? "SIGNED_IN" : "SIGNED_OUT", s));
  }
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

  /**
   * The settings RPCs (migration 20261004001100), with the same whitelist and the same CHECK:
   * whatsapp/calls/sms need phone_verified_at AND charges_notice_ack_at.
   */
  rpc(owner: string, fn: string, args: Row = {}): { data: unknown; error: { message: string; code: string } | null } {
    const users = this.rows("users");
    const u = users.find((r) => r.id === owner)!;
    const view = () => {
      const { id: _id, tier: _tier, rev: _rev, ...rest } = u;
      return structuredClone(rest);
    };
    const fail = (message: string, code: string) => ({ data: null, error: { message, code } });
    if (fn === "get_my_settings") return { data: view(), error: null };
    if (fn === "create_my_companion") {
      if (this.rows("companions").some((c) => c.owner === owner)) return fail("chalito: companion_exists", "23505");
      this.insert(
        "companions",
        {
          owner,
          companion_id: "chl_devcompanion",
          name: args.p_name,
          is_renamed: !!args.p_is_renamed,
          avatar: args.p_avatar,
        },
        true,
      );
      return { data: { ok: true }, error: null };
    }
    if (fn !== "update_my_settings") return fail(`unknown rpc ${fn}`, "42883");
    const p = args.p as Row;
    // Migration 20261004002000: paid channels are turned ON only through the api.
    if (p.whatsapp_opt_in === true || p.calls_enabled === true || p.sms_enabled === true)
      return fail("chalito: channel opt-ins are turned on through the api (/v1/phone/channels)", "42501");
    const allowed = [
      "locale",
      "tz",
      "call_briefing",
      "quiet_hours",
      "l4_quiet_override",
      "privacy_mode",
      "render_quality",
      "whatsapp_opt_in",
      "calls_enabled",
      "sms_enabled",
      "prefs",
      "phone_pending_e164",
      "charges_notice_ack_at",
    ];
    const next = { ...u };
    for (const [k, v] of Object.entries(p)) {
      if (!allowed.includes(k)) return fail(`chalito: ${k} is not a client setting`, "22023");
      if (k === "prefs") next.prefs = { ...(u.prefs as Row), ...(v as Row) };
      else if (k === "charges_notice_ack_at") next.charges_notice_ack_at = v ? new Date().toISOString() : null;
      else next[k] = v;
    }
    const optedIn = next.whatsapp_opt_in === true || next.calls_enabled === true || next.sms_enabled === true;
    if (optedIn && !(next.phone_verified_at && next.charges_notice_ack_at))
      return fail('new row violates check constraint "users_opt_ins_need_verified_phone"', "23514");
    this.clientWrites.push({ table: "users", op: "rpc:update_my_settings", row: structuredClone(p) });
    this.update("users", (r) => r.id === owner, next, true);
    return { data: view(), error: null };
  }

  /** The BrowserSupabase shape connect() expects. */
  client(owner = ""): BrowserSupabase {
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
            logWrite({ table, op: "insert", row: st.body! });
            this.insert(table, st.body!, true);
            return { data: null, error: null };
          case "update":
            this.clientWrites.push({ table, op: "update", row: structuredClone(st.body!) });
            logWrite({ table, op: "update", row: st.body! });
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
      getSession: async () => ({ data: { session: this.session }, error: null }),
      verifyOtp: async ({ token_hash }: { token_hash: string }) => {
        const s = this.tokenHashes.get(token_hash);
        this.tokenHashes.delete(token_hash); // single use
        if (!s) return { data: { session: null }, error: { message: "Token has expired or is invalid" } };
        this.setSession(s);
        return { data: { session: s }, error: null };
      },
      setSession: async () => ({ data: { session: this.session }, error: null }),
      onAuthStateChange: (cb: (e: string, s: FakeSession | null) => void) => {
        this.#authListeners.add(cb);
        return { data: { subscription: { unsubscribe: () => this.#authListeners.delete(cb) } } };
      },
      signOut: async () => this.setSession(null),
    };
    return {
      from,
      channel,
      rpc: (fn: string, args?: Row) => Promise.resolve(this.rpc(owner, fn, args)),
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
