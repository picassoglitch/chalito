import type { SealedEnvelope, SessionCard } from "@chalito/protocol";
import type { ClientKeys } from "./keys.js";
import { deviceTopic, must, type SupaChannel, type SupaClient } from "./supa.js";

// ---------------------------------------------------------------- views

export interface ApprovalView {
  aid: string;
  sid: string;
  /** The agent that asked; decisions are signed for it. */
  agentDeviceId: string;
  requestId: string;
  kind: "tool" | "decision";
  risk: "LOW" | "MED" | "HIGH" | "CRITICAL";
  origin: string;
  stepUpRequired: boolean;
  status: "pending" | "approved" | "denied" | "expired" | "rejected_invalid";
  reason: string | null;
  createdAt: number;
  expiresAt: number;
  /** Opened details (tool, summary, input, reasons), or null when this device isn't a recipient. */
  details: Record<string, unknown> | null;
  rev: number;
}

export interface SessionView {
  sid: string;
  agentDeviceId: string;
  adapter?: string;
  label?: string;
  state?: string;
  permissionMode?: string;
  updatedAt: number;
  /** The latest Session Card, opened (AAD card:<sid>), or null. */
  card: SessionCard | null;
  rev: number;
}

export interface EventView {
  sid: string;
  eid: string;
  seq: number;
  t: number;
  type: string;
  urgency: string;
  /** Plain metadata of the event (no ciphertext). */
  meta: Record<string, unknown>;
  /** Opened `ct` (AAD event:<sid>) when the event carries one and this device can read it. */
  content: unknown;
  rev: number;
}

export interface NotificationView {
  nid: string;
  level: string;
  source: string;
  urgency: string;
  counts: Record<string, number>;
  deepLink: string;
  state: "pending" | "acked" | "snoozed" | "expired";
  createdAt: number;
  rev: number;
}

export interface DeviceView {
  deviceId: string;
  role: "agent" | "client";
  kind: string;
  platform: string;
  name: string;
  revoked: boolean;
  online: boolean;
  lastSeenAt: number | null;
  devMode: { on: boolean; toggles: string[]; since: number | null };
  policyHash: string | null;
  rev: number;
}

export interface Snapshot {
  status: "idle" | "connecting" | "live" | "offline" | "revoked";
  /** Pending first, then newest. */
  approvals: readonly ApprovalView[];
  sessions: readonly SessionView[];
  /** By sid, in seq order, capped per session. */
  events: Readonly<Record<string, readonly EventView[]>>;
  notifications: readonly NotificationView[];
  devices: readonly DeviceView[];
  /** "Modo desarrollador ACTIVO": any of the owner's devices has Developer mode on. */
  devModeActive: boolean;
}

const EMPTY: Snapshot = {
  status: "idle",
  approvals: [],
  sessions: [],
  events: {},
  notifications: [],
  devices: [],
  devModeActive: false,
};

type Table = "approvals" | "sessions" | "session_events" | "notifications" | "devices";
const TABLES: readonly Table[] = ["devices", "sessions", "approvals", "notifications", "session_events"];

type Row = Record<string, unknown>;
const ms = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : 0);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

export interface LiveStoreOptions {
  /** A device counts as online if seen within this window. */
  onlineWindowMs?: number;
  maxEventsPerSession?: number;
  pageSize?: number;
  now?: () => number;
  onError?: (err: unknown, where: string) => void;
}

/**
 * The client's live view of one owner's data (ADR 0017), framework-free: the PWA and the
 * desktop panel both read it through `subscribe` / `getSnapshot` (useSyncExternalStore).
 *
 * One private channel, `chalito:device:<this device>`, carries pointers. A pointer (or a
 * rejoin) schedules a pull of that table: rows with `rev` above the last one seen, read
 * back under RLS, in order. Pulls per table are coalesced, so a burst of pointers costs one
 * read. Sealed content (approval details, cards, event payloads) is opened with this
 * device's keys; content not sealed to it stays null.
 */
export class LiveStore {
  #snapshot: Snapshot = EMPTY;
  readonly #listeners = new Set<() => void>();
  #channel: SupaChannel | null = null;
  readonly #rev: Record<Table, number> = { approvals: 0, sessions: 0, session_events: 0, notifications: 0, devices: 0 };
  readonly #pulling = new Map<Table, Promise<void>>();
  readonly #again = new Set<Table>();

  readonly #approvals = new Map<string, ApprovalView>();
  readonly #sessions = new Map<string, SessionView>();
  readonly #events = new Map<string, Map<string, EventView>>();
  readonly #notifications = new Map<string, NotificationView>();
  readonly #devices = new Map<string, DeviceView>();
  #status: Snapshot["status"] = "idle";
  readonly #opts: Required<Omit<LiveStoreOptions, "onError">> & Pick<LiveStoreOptions, "onError">;

  constructor(
    private readonly db: SupaClient,
    private readonly keys: ClientKeys,
    readonly owner: string,
    opts: LiveStoreOptions = {},
  ) {
    this.#opts = {
      onlineWindowMs: opts.onlineWindowMs ?? 10 * 60 * 1000,
      maxEventsPerSession: opts.maxEventsPerSession ?? 200,
      pageSize: opts.pageSize ?? 200,
      now: opts.now ?? Date.now,
      onError: opts.onError,
    };
  }

  // ---- external store API -----------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Stable between changes (a new object only when something changed). */
  getSnapshot = (): Snapshot => this.#snapshot;

  // ---- lifecycle --------------------------------------------------------------------

  #joining: Promise<void> | null = null;

  /**
   * Joins this device's channel (after Realtime has the current token); every SUBSCRIBED
   * (first and each rejoin) pulls all tables.
   */
  start(): void {
    if (this.#channel || this.#joining) return;
    this.#setStatus("connecting");
    this.#joining = (async () => {
      try {
        await this.db.realtime?.setAuth();
      } catch (err) {
        this.#opts.onError?.(err, "realtime setAuth");
      }
      if (this.#status !== "idle") this.#join();
    })();
  }

  /** Resolves once the join was issued (after setAuth). */
  joined(): Promise<void> {
    return this.#joining ?? Promise.resolve();
  }

  #join(): void {
    this.#channel = this.db
      .channel(deviceTopic(this.keys.deviceId), { config: { private: true } })
      .on("broadcast", { event: "*" }, (msg) => this.#onPointer(msg.payload))
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED") {
          this.#setStatus("live");
          void this.resync();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          this.#setStatus("offline");
          this.#opts.onError?.(err ?? new Error(status), "realtime");
        } else if (status === "CLOSED" && this.#status !== "revoked") this.#setStatus("offline");
      });
  }

  async stop(): Promise<void> {
    this.#setStatus("idle");
    await this.#joining;
    this.#joining = null;
    if (this.#channel) await this.db.removeChannel(this.#channel);
    this.#channel = null;
    this.#setStatus("idle");
  }

  /** Pulls every table (rev > last). Also usable as a manual "refresh". */
  async resync(): Promise<void> {
    await Promise.all(TABLES.map((t) => this.#pull(t)));
  }

  // ---- lookups for actions ----------------------------------------------------------

  approval(aid: string): ApprovalView | undefined {
    return this.#approvals.get(aid);
  }
  session(sid: string): SessionView | undefined {
    return this.#sessions.get(sid);
  }
  device(deviceId: string): DeviceView | undefined {
    return this.#devices.get(deviceId);
  }

  // ---- pointers & pulls -------------------------------------------------------------

  #onPointer(p: unknown): void {
    const table = (p as { table?: unknown } | null)?.table;
    if (typeof table === "string" && (TABLES as readonly string[]).includes(table)) void this.#pull(table as Table);
  }

  /** Coalesced: while a pull runs, further requests for the table schedule exactly one more. */
  #pull(table: Table): Promise<void> {
    const running = this.#pulling.get(table);
    if (running) {
      this.#again.add(table);
      return running;
    }
    const p = (async () => {
      try {
        do {
          this.#again.delete(table);
          await this.#pullOnce(table);
        } while (this.#again.has(table));
      } catch (err) {
        this.#opts.onError?.(err, `pull ${table}`);
      } finally {
        this.#pulling.delete(table);
      }
    })();
    this.#pulling.set(table, p);
    return p;
  }

  async #pullOnce(table: Table): Promise<void> {
    for (;;) {
      const rows = await must<Row[]>(
        `pull ${table}`,
        this.db
          .from(table)
          .select("*")
          .eq("owner", this.owner)
          .gt("rev", this.#rev[table])
          .order("rev", { ascending: true })
          .limit(this.#opts.pageSize),
      );
      for (const r of rows ?? []) {
        await this.#apply(table, r);
        this.#rev[table] = Math.max(this.#rev[table], num(r.rev));
      }
      this.#publish();
      if ((rows ?? []).length < this.#opts.pageSize) return;
    }
  }

  async #apply(table: Table, r: Row): Promise<void> {
    switch (table) {
      case "approvals":
        return void this.#approvals.set(String(r.aid), await this.#approval(r));
      case "sessions":
        return void this.#sessions.set(String(r.sid), await this.#session(r));
      case "session_events": {
        const sid = String(r.sid);
        const list = this.#events.get(sid) ?? new Map<string, EventView>();
        list.set(String(r.eid), await this.#event(r));
        if (list.size > this.#opts.maxEventsPerSession) {
          const keep = [...list.values()].sort((a, b) => a.seq - b.seq).slice(-this.#opts.maxEventsPerSession);
          list.clear();
          for (const e of keep) list.set(e.eid, e);
        }
        this.#events.set(sid, list);
        return;
      }
      case "notifications":
        return void this.#notifications.set(String(r.nid), notification(r));
      case "devices": {
        const d = this.#device(r);
        this.#devices.set(d.deviceId, d);
        if (d.deviceId === this.keys.deviceId && d.revoked) this.#status = "revoked";
        return;
      }
    }
  }

  async #open<T>(ct: unknown, aad: string): Promise<T | null> {
    if (!ct || typeof ct !== "object") return null;
    try {
      return await this.keys.open<T>(ct as SealedEnvelope, aad);
    } catch {
      // Not sealed to this device (e.g. enrolled after it was written), or tampered: unreadable.
      return null;
    }
  }

  async #approval(r: Row): Promise<ApprovalView> {
    const aid = String(r.aid);
    return {
      aid,
      sid: String(r.sid),
      agentDeviceId: String(r.device_id),
      requestId: String(r.request_id),
      kind: r.kind as ApprovalView["kind"],
      risk: r.risk as ApprovalView["risk"],
      origin: String(r.origin),
      stepUpRequired: r.step_up_required === true,
      status: r.status as ApprovalView["status"],
      reason: (r.reason as string | null) ?? null,
      createdAt: ms(r.created_at),
      expiresAt: ms(r.expires_at),
      details: await this.#open<Record<string, unknown>>(r.details_ct, `approval:${aid}`),
      rev: num(r.rev),
    };
  }

  async #session(r: Row): Promise<SessionView> {
    const sid = String(r.sid);
    const doc = (r.doc ?? {}) as Row;
    const card = await this.#open<SessionCard>((doc.card as Row | undefined)?.ct, `card:${sid}`);
    return {
      sid,
      agentDeviceId: String(r.device_id),
      adapter: doc.adapter as string | undefined,
      label: doc.label as string | undefined,
      state: doc.state as string | undefined,
      permissionMode: doc.permissionMode as string | undefined,
      updatedAt: ms(r.updated_at ?? doc.updatedAt),
      card,
      rev: num(r.rev),
    };
  }

  async #event(r: Row): Promise<EventView> {
    const sid = String(r.sid);
    const { ct, ...meta } = (r.doc ?? {}) as Row;
    return {
      sid,
      eid: String(r.eid),
      seq: num(r.seq),
      t: ms(r.t),
      type: String(r.type),
      urgency: String(r.urgency ?? "low"),
      meta,
      content: ct ? await this.#open(ct, `event:${sid}`) : null,
      rev: num(r.rev),
    };
  }

  #device(r: Row): DeviceView {
    const last = r.last_seen_at ? ms(r.last_seen_at) : null;
    const dm = (r.dev_mode ?? {}) as { on?: boolean; toggles?: string[]; since?: number | null };
    return {
      deviceId: String(r.device_id),
      role: r.role as DeviceView["role"],
      kind: String(r.kind),
      platform: String(r.platform),
      name: String(r.name),
      revoked: r.revoked === true,
      online: r.revoked !== true && last !== null && this.#opts.now() - last <= this.#opts.onlineWindowMs,
      lastSeenAt: last,
      devMode: { on: dm.on === true, toggles: dm.toggles ?? [], since: dm.since ?? null },
      policyHash: (r.policy_hash as string | null) ?? null,
      rev: num(r.rev),
    };
  }

  // ---- snapshot ---------------------------------------------------------------------

  #setStatus(s: Snapshot["status"]): void {
    if (this.#status === "revoked") return;
    this.#status = s;
    this.#publish();
  }

  #publish(): void {
    const devices = [...this.#devices.values()].sort((a, b) => a.name.localeCompare(b.name));
    const next: Snapshot = {
      status: this.#status,
      approvals: [...this.#approvals.values()].sort(
        (a, b) => Number(b.status === "pending") - Number(a.status === "pending") || b.createdAt - a.createdAt,
      ),
      sessions: [...this.#sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt),
      events: Object.fromEntries(
        [...this.#events].map(([sid, m]) => [sid, [...m.values()].sort((a, b) => a.seq - b.seq)]),
      ),
      notifications: [...this.#notifications.values()].sort((a, b) => b.createdAt - a.createdAt),
      devices,
      devModeActive: devices.some((d) => !d.revoked && d.devMode.on),
    };
    if (sameSnapshot(this.#snapshot, next)) return;
    this.#snapshot = next;
    for (const l of [...this.#listeners]) l();
  }
}

const notification = (r: Row): NotificationView => ({
  nid: String(r.nid),
  level: String(r.level),
  source: String(r.source),
  urgency: String(r.urgency),
  counts: (r.counts ?? {}) as Record<string, number>,
  deepLink: String(r.deep_link ?? ""),
  state: r.state as NotificationView["state"],
  createdAt: ms(r.created_at),
  rev: num(r.rev),
});

const revs = (xs: readonly { rev: number }[]) => xs.map((x) => x.rev).join(",");
const sameSnapshot = (a: Snapshot, b: Snapshot) =>
  a.status === b.status &&
  a.devModeActive === b.devModeActive &&
  revs(a.approvals) === revs(b.approvals) &&
  revs(a.sessions) === revs(b.sessions) &&
  revs(a.notifications) === revs(b.notifications) &&
  revs(a.devices) === revs(b.devices) &&
  JSON.stringify(Object.entries(a.events).map(([s, e]) => [s, revs(e)])) ===
    JSON.stringify(Object.entries(b.events).map(([s, e]) => [s, revs(e)]));
