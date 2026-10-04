import { randomUUID } from "node:crypto";
import type { AgentEvent, ApprovalRequest, CallLine, DeviceEvent, SessionCard } from "@chalito/protocol";
import type { Logger } from "./redact.js";
import { redactDeep, sanitizeDeviceEvent } from "./redact.js";
import type { AgentStore, AuditEntry } from "./store.js";

/**
 * The slice of supabase-js the agent uses (schema `chalito`). Narrow on purpose: unit tests
 * run against an in-memory fake, and the real client is adapted in cloud.ts.
 */
export interface SupaResult<T = unknown> {
  data: T | null;
  error: { message: string; code?: string } | null;
}
export interface SupaQuery extends PromiseLike<SupaResult> {
  select(columns?: string): SupaQuery;
  insert(row: Record<string, unknown>): SupaQuery;
  update(patch: Record<string, unknown>): SupaQuery;
  delete(): SupaQuery;
  eq(column: string, value: unknown): SupaQuery;
  gt(column: string, value: unknown): SupaQuery;
  order(column: string, opts?: { ascending?: boolean }): SupaQuery;
  maybeSingle(): SupaQuery;
}
export interface SupaChannel {
  on(
    type: "broadcast",
    filter: { event: string },
    cb: (msg: { event?: string; payload?: unknown }) => void,
  ): SupaChannel;
  subscribe(cb?: (status: string, err?: Error) => void): SupaChannel;
}
export interface SupaClient {
  /**
   * realtime-js 2.117: `setAuth()` returns a Promise; with no argument it takes the token from
   * the client's accessToken callback. A channel must not subscribe before it resolves, or the
   * join goes out with the previous (or no) token and Realtime refuses the private topic.
   */
  realtime?: { setAuth(token?: string | null): unknown };
  from(table: string): SupaQuery;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<SupaResult>;
  channel(topic: string, opts: { config: { private: boolean } }): SupaChannel;
  removeChannel(ch: SupaChannel): Promise<unknown>;
}

/** Realtime topics are namespaced (S4): `chalito:device:<id>`, `chalito:pairing:<code>`. */
export const deviceTopic = (deviceId: string) => `chalito:device:${deviceId}`;
export const pairingTopic = (codeId: string) => `chalito:pairing:${codeId}`;

/** Broadcast payloads are pointers only (ADR 0017): the row is read back under RLS. */
interface Pointer {
  table: string;
  op: string;
  key: Record<string, unknown>;
  rev?: number;
}

const EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

export class SupabaseError extends Error {
  override name = "SupabaseError";
  constructor(
    readonly op: string,
    readonly code: string | undefined,
    message: string,
  ) {
    super(`${op}: ${message}`);
  }
}

const must = async <T>(op: string, q: PromiseLike<SupaResult>): Promise<T> => {
  const { data, error } = await q;
  if (error) throw new SupabaseError(op, error.code, error.message);
  return data as T;
};

/** Client inserts are rate-limited per device per table (S7): PostgREST answers 429 / SQLSTATE PT429. */
const isRateLimited = (e: SupaResult["error"]) =>
  !!e && (e.code === "PT429" || e.code === "429" || /rate limit/i.test(e.message));

export interface SupabaseStoreOptions {
  log?: Logger;
  /** Backoff for rate-limited writes: base delay and number of retries (exponential, jittered). */
  retry?: { baseMs: number; attempts: number };
  sleep?: (ms: number) => Promise<void>;
}

/**
 * AgentStore over the Chalyb hub's Supabase (ADR 0017), signed in as this device.
 *
 * - Writes go through the Data API under RLS (column-scoped grants, the port of the old firestore.rules); a
 *   rate-limited write is retried with exponential backoff.
 * - One private Realtime channel, `chalito:device:<id>`, carries pointers for this device,
 *   shared by watchCommands and every watchApproval(aid).
 * - Decisions are insert-only rows in `approval_decisions`, one per signer (S6). Every
 *   distinct one is passed to the watcher in rev order; the agent verifies each and acts on
 *   the first valid one.
 * - Resync on every SUBSCRIBED (first join and each rejoin): rows with `rev` above the last
 *   one seen (commands, decisions), plus a re-read of each watched approval as a fallback.
 *   `rev` moves on every insert and update, so nothing missed while offline is lost.
 */
export class SupabaseStore implements AgentStore {
  #channel: SupaChannel | null = null;
  #commandHandler: ((id: string, doc: Record<string, unknown>) => void) | null = null;
  /** Commands delivered and not yet deleted: a rejoin resync doesn't redeliver them. */
  readonly #delivered = new Set<string>();
  readonly #approvalWatchers = new Map<string, (decision: unknown) => void>();
  /** Decision rows already passed on, by aid: `${signer}:${json}`. */
  readonly #seenDecisions = new Map<string, Set<string>>();
  #commandRev = 0;
  #decisionRev = 0;
  readonly #log: Logger | undefined;
  readonly #retry: { baseMs: number; attempts: number };
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly db: SupaClient,
    private readonly owner: string,
    private readonly deviceId: string,
    opts: SupabaseStoreOptions | Logger = {},
  ) {
    const o: SupabaseStoreOptions = "info" in opts ? { log: opts as Logger } : (opts as SupabaseStoreOptions);
    this.#log = o.log;
    this.#retry = o.retry ?? { baseMs: 250, attempts: 5 };
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** A write, retried while the database says the device is over its rate (S7). */
  async #write<T>(op: string, run: () => PromiseLike<SupaResult>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const { data, error } = await run();
      if (!error) return data as T;
      if (!isRateLimited(error) || attempt >= this.#retry.attempts)
        throw new SupabaseError(op, error.code, error.message);
      const delay = this.#retry.baseMs * 2 ** attempt * (0.75 + Math.random() * 0.5);
      this.#log?.warn("supabase.rate_limited", { op, attempt: attempt + 1, delayMs: Math.round(delay) });
      await this.#sleep(delay);
    }
  }

  // ---- realtime ------------------------------------------------------------------

  #joining: Promise<void> | null = null;

  /** Authorizes Realtime with the current token, then joins (once). */
  #ensureChannel(): void {
    if (this.#channel || this.#joining) return;
    this.#joining = (async () => {
      try {
        await this.db.realtime?.setAuth();
      } catch (err) {
        this.#log?.warn("realtime.set_auth_failed", { error: err instanceof Error ? err.message : "error" });
      }
      if (!this.#closed) this.#join();
    })();
  }

  /** Resolves once the channel join was issued (after setAuth). */
  joined(): Promise<void> {
    return this.#joining ?? Promise.resolve();
  }

  #join(): void {
    this.#channel = this.db
      .channel(deviceTopic(this.deviceId), { config: { private: true } })
      .on("broadcast", { event: "*" }, (msg) => void this.#onPointer(msg.payload as Pointer))
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED") {
          this.#log?.info("realtime.subscribed", { topic: "device" });
          void this.resync();
        } else if (status !== "CLOSED")
          this.#log?.warn("realtime.status", { status, error: err?.message ?? null, topic: "device" });
      });
  }

  async #onPointer(p: Pointer | undefined): Promise<void> {
    try {
      if (!p || typeof p !== "object") return;
      const aid = p.key?.aid;
      if (p.table === "commands" && p.op === "insert" && typeof p.key?.id === "string") {
        await this.#fetchCommand(p.key.id);
      } else if (p.table === "approval_decisions" && typeof aid === "string" && this.#approvalWatchers.has(aid)) {
        await this.#fetchDecisions(aid);
      }
    } catch (err) {
      this.#log?.error("realtime.fetch_failed", {
        table: p?.table,
        error: err instanceof Error ? err.message : "error",
      });
    }
  }

  /** Called on every (re)SUBSCRIBED: whatever changed while the channel was down. */
  async resync(): Promise<void> {
    try {
      if (this.#commandHandler) {
        const rows = await must<CommandRow[]>(
          "resync commands",
          this.db
            .from("commands")
            .select("id, env, from_device_id, rev")
            .eq("owner", this.owner)
            .eq("target_device_id", this.deviceId)
            .gt("rev", this.#commandRev)
            .order("rev", { ascending: true }),
        );
        for (const r of rows ?? []) this.#deliverCommand(r);
      }
      if (this.#approvalWatchers.size) {
        const rows = await must<DecisionRow[]>(
          "resync decisions",
          this.db
            .from("approval_decisions")
            .select("aid, signer_device_id, decision, rev")
            .eq("owner", this.owner)
            .gt("rev", this.#decisionRev)
            .order("rev", { ascending: true }),
        );
        for (const r of rows ?? []) this.#passDecision(r);
        // Fallback: a watcher registered after those revs were seen.
        for (const aid of [...this.#approvalWatchers.keys()]) await this.#fetchDecisions(aid);
      }
    } catch (err) {
      this.#log?.error("realtime.resync_failed", { error: err instanceof Error ? err.message : "error" });
    }
  }

  async #fetchCommand(id: string): Promise<void> {
    if (!this.#commandHandler || this.#delivered.has(id)) return;
    const row = await must<CommandRow | null>(
      "read command",
      this.db
        .from("commands")
        .select("id, env, from_device_id, rev")
        .eq("owner", this.owner)
        .eq("target_device_id", this.deviceId)
        .eq("id", id)
        .maybeSingle(),
    );
    if (row) this.#deliverCommand(row);
  }

  #deliverCommand(r: CommandRow): void {
    if (typeof r.rev === "number") this.#commandRev = Math.max(this.#commandRev, r.rev);
    if (!this.#commandHandler || this.#delivered.has(r.id)) return;
    this.#delivered.add(r.id);
    this.#commandHandler(r.id, { env: r.env, fromDeviceId: r.from_device_id });
  }

  async #fetchDecisions(aid: string): Promise<void> {
    if (!this.#approvalWatchers.has(aid)) return;
    const rows = await must<DecisionRow[]>(
      "read decisions",
      this.db
        .from("approval_decisions")
        .select("aid, signer_device_id, decision, rev")
        .eq("owner", this.owner)
        .eq("aid", aid)
        .order("rev", { ascending: true }),
    );
    for (const r of rows ?? []) this.#passDecision(r);
  }

  /** Each distinct decision row once, in rev order; the agent verifies them (first valid wins). */
  #passDecision(r: DecisionRow): void {
    if (typeof r.rev === "number") this.#decisionRev = Math.max(this.#decisionRev, r.rev);
    const cb = this.#approvalWatchers.get(r.aid);
    if (!cb || !r.decision) return;
    const fp = `${r.signer_device_id}:${JSON.stringify(r.decision)}`;
    const seen = this.#seenDecisions.get(r.aid) ?? new Set<string>();
    if (seen.has(fp)) return;
    seen.add(fp);
    this.#seenDecisions.set(r.aid, seen);
    cb(r.decision);
  }

  /** Leaves the channel (daemon shutdown). */
  #closed = false;

  async close(): Promise<void> {
    this.#closed = true;
    await this.#joining;
    if (this.#channel) await this.db.removeChannel(this.#channel);
    this.#channel = null;
  }

  // ---- approvals -----------------------------------------------------------------

  async createApproval(req: ApprovalRequest) {
    await this.#write("create approval", () =>
      this.db.from("approvals").insert({
        owner: this.owner,
        aid: req.aid,
        device_id: this.deviceId,
        sid: req.sid,
        request_id: req.requestId,
        kind: req.kind,
        risk: req.risk,
        origin: req.origin,
        step_up_required: req.stepUpRequired,
        details_ct: req.detailsCt,
        status: req.status,
        // created_at is server time (S9); expires_at is clamped to 10 minutes by the database.
        expires_at: iso(req.expiresAt),
        recommendations: req.recommendations ?? [],
      }),
    );
  }

  watchApproval(aid: string, onDecision: (decision: unknown) => void) {
    this.#approvalWatchers.set(aid, onDecision);
    this.#ensureChannel();
    // A decision attached before the watch started (or before the channel joined).
    void this.#fetchDecisions(aid).catch((err: unknown) =>
      this.#log?.error("approval.read_failed", { aid, error: err instanceof Error ? err.message : "error" }),
    );
    return () => {
      this.#approvalWatchers.delete(aid);
      this.#seenDecisions.delete(aid);
    };
  }

  async resolveApproval(aid: string, status: ApprovalRequest["status"], reason: string, at: number) {
    await this.#write("resolve approval", () =>
      this.db
        .from("approvals")
        .update({ status, reason, resolved_at: iso(at) })
        .eq("owner", this.owner)
        .eq("aid", aid),
    );
  }

  // ---- sessions ------------------------------------------------------------------

  async writeEvent(e: AgentEvent) {
    await this.#write("write event", () =>
      this.db.from("session_events").insert({
        owner: this.owner,
        sid: e.sid,
        eid: e.eid,
        device_id: this.deviceId,
        seq: e.seq,
        t: iso(e.t),
        type: e.type,
        urgency: e.urgency,
        doc: e,
        expires_at: iso(e.t + EVENT_TTL_MS),
      }),
    );
  }

  /** Merge semantics (Firestore `set(..., {merge: true})`) through the `chalito.session_merge` RPC. */
  async upsertSession(sid: string, data: Record<string, unknown>) {
    const patch = JSON.parse(JSON.stringify({ ...data, deviceId: this.deviceId })) as Record<string, unknown>;
    await this.#write("merge session", () => this.db.rpc("session_merge", { p_sid: sid, p_patch: patch }));
  }

  // ---- commands ------------------------------------------------------------------

  watchCommands(onCommand: (id: string, doc: Record<string, unknown>) => void) {
    this.#commandHandler = onCommand;
    this.#ensureChannel();
    return () => {
      this.#commandHandler = null;
    };
  }

  async deleteCommand(id: string) {
    await this.#write("delete command", () =>
      this.db.from("commands").delete().eq("owner", this.owner).eq("target_device_id", this.deviceId).eq("id", id),
    );
    this.#delivered.delete(id);
  }

  // ---- device --------------------------------------------------------------------

  async updateDevice(fields: { policyHash?: string; devMode?: unknown; lastSeenAt?: number }) {
    const patch: Record<string, unknown> = {};
    if (fields.policyHash !== undefined) patch.policy_hash = fields.policyHash;
    if (fields.devMode !== undefined) patch.dev_mode = fields.devMode;
    if (fields.lastSeenAt !== undefined) patch.last_seen_at = iso(fields.lastSeenAt);
    if (!Object.keys(patch).length) return;
    await this.#write("update device", () =>
      this.#device().update(patch).eq("owner", this.owner).eq("device_id", this.deviceId),
    );
  }

  async publishDeviceEvent(raw: DeviceEvent) {
    const e = sanitizeDeviceEvent(raw);
    await this.#write("device event", () =>
      this.#device().update({ last_event: e }).eq("owner", this.owner).eq("device_id", this.deviceId),
    );
    await this.audit({ eid: randomUUID(), t: e.t, type: e.type, meta: { ...e }, source: "deviceEvent" });
  }

  async audit(entry: AuditEntry) {
    const meta = JSON.parse(JSON.stringify(redactDeep(entry.meta) ?? {})) as Record<string, unknown>;
    await this.#write("audit", () =>
      this.db.from("audit").insert({
        owner: this.owner,
        device_id: this.deviceId,
        eid: entry.eid,
        // Overwritten with server time by a trigger; sent for parity with the Firestore shape.
        t: iso(entry.t),
        type: entry.type,
        meta,
        source: entry.source,
      }),
    );
  }

  #device() {
    return this.db.from("devices");
  }

  // ---- call briefing -------------------------------------------------------------

  async callBriefingEnabled() {
    const row = await must<{ call_briefing: { enabled?: unknown } | null } | null>(
      "read user",
      this.db.from("users").select("call_briefing").eq("id", this.owner).maybeSingle(),
    );
    return row?.call_briefing?.enabled === true;
  }

  async mcpSharingOn(sid: string) {
    const rows = await must<{ scope: string; target: string }[]>(
      "read mcp sharing",
      this.db.from("mcp_sharing").select("scope,target").eq("owner", this.owner).eq("enabled", true),
    );
    return (rows ?? []).some(
      (r) => (r.scope === "session" && r.target === sid) || (r.scope === "device" && r.target === this.deviceId),
    );
  }

  /** Update-or-insert (the client may update only `card`/`updated_at`, so no PostgREST upsert). */
  async writeSharedCard(sid: string, card: SessionCard) {
    const doc = JSON.parse(JSON.stringify(card)) as Record<string, unknown>;
    const update = () =>
      this.#write("update shared card", () =>
        this.db
          .from("session_card_plain")
          .update({ card: doc, updated_at: iso(Date.now()) })
          .eq("owner", this.owner)
          .eq("sid", sid),
      );
    const existing = await must<{ sid: string } | null>(
      "read shared card",
      this.db.from("session_card_plain").select("sid").eq("owner", this.owner).eq("sid", sid).maybeSingle(),
    );
    if (existing) return void (await update());
    try {
      await this.#write("insert shared card", () =>
        this.db.from("session_card_plain").insert({ owner: this.owner, sid, device_id: this.deviceId, card: doc }),
      );
    } catch (err) {
      if (err instanceof SupabaseError && err.code === "23505")
        await update(); // raced another write
      else throw err;
    }
  }

  async writeCallLine(id: string, line: CallLine) {
    await this.#write("write call line", () =>
      this.db.from("call_lines").insert({
        owner: this.owner,
        lid: id,
        notification_id: line.notificationId,
        device_id: this.deviceId,
        sid: line.sid,
        line: line.line,
        expires_at: iso(line.expireAt),
      }),
    );
  }

  async deleteCallLine(id: string) {
    await this.#write("delete call line", () =>
      this.db.from("call_lines").delete().eq("owner", this.owner).eq("lid", id),
    ).catch(() => undefined);
  }
}

interface CommandRow {
  id: string;
  env: unknown;
  from_device_id: string;
  rev?: number;
}

interface DecisionRow {
  aid: string;
  signer_device_id: string;
  decision: unknown;
  rev?: number;
}
