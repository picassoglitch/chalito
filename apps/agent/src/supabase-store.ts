import { randomUUID } from "node:crypto";
import type { AgentEvent, ApprovalRequest, CallLine, DeviceEvent } from "@chalito/protocol";
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
  from(table: string): SupaQuery;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<SupaResult>;
  channel(topic: string, opts: { config: { private: boolean } }): SupaChannel;
  removeChannel(ch: SupaChannel): Promise<unknown>;
}

/** Broadcast payloads are pointers only (ADR 0017): the row is read back under RLS. */
interface Pointer {
  table: string;
  op: string;
  key: Record<string, unknown>;
  cursor?: number;
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

/**
 * AgentStore over the Chalyb hub's Supabase (ADR 0017), signed in as this device.
 *
 * - Writes go through the Data API under RLS (column grants mirror firestore.rules).
 * - One private Realtime channel, `device:<id>`, carries pointers for this device. It is
 *   shared by watchCommands and every watchApproval(aid).
 * - On every SUBSCRIBED (first join and each rejoin) the store resyncs by re-reading what it
 *   cares about: all live commands for this device, and the decision of every approval being
 *   watched. Commands are deleted once handled and approvals are watched only while pending,
 *   so this stays small and needs no cursor. It also catches an UPDATE missed while
 *   disconnected, which an insert-only cursor can't.
 */
export class SupabaseStore implements AgentStore {
  #channel: SupaChannel | null = null;
  #commandHandler: ((id: string, doc: Record<string, unknown>) => void) | null = null;
  /** Commands delivered and not yet deleted: a rejoin resync doesn't redeliver them. */
  readonly #delivered = new Set<string>();
  readonly #approvalWatchers = new Map<string, (decision: unknown) => void>();
  /** Decisions already passed on, by aid (a broadcast and a resync may both see one). */
  readonly #seenDecision = new Map<string, string>();

  constructor(
    private readonly db: SupaClient,
    private readonly owner: string,
    private readonly deviceId: string,
    private readonly log?: Logger,
  ) {}

  // ---- realtime ------------------------------------------------------------------

  #ensureChannel(): void {
    if (this.#channel) return;
    this.#channel = this.db
      .channel(`device:${this.deviceId}`, { config: { private: true } })
      .on("broadcast", { event: "*" }, (msg) => void this.#onPointer(msg.payload as Pointer))
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED") void this.resync();
        else if (status !== "CLOSED")
          this.log?.warn("realtime.status", { status, error: err?.message ?? null, topic: "device" });
      });
  }

  async #onPointer(p: Pointer | undefined): Promise<void> {
    try {
      if (!p || typeof p !== "object") return;
      if (p.table === "commands" && p.op === "insert" && typeof p.key?.id === "string") {
        await this.#fetchCommand(p.key.id);
      } else if (p.table === "approvals" && typeof p.key?.aid === "string" && this.#approvalWatchers.has(p.key.aid)) {
        await this.#fetchDecision(p.key.aid);
      }
    } catch (err) {
      this.log?.error("realtime.fetch_failed", {
        table: p?.table,
        error: err instanceof Error ? err.message : "error",
      });
    }
  }

  /** Re-reads live commands and watched approvals. Called on every (re)SUBSCRIBED. */
  async resync(): Promise<void> {
    try {
      if (this.#commandHandler) {
        const rows = await must<CommandRow[]>(
          "resync commands",
          this.db
            .from("commands")
            .select("id, env, from_device_id")
            .eq("owner", this.owner)
            .eq("target_device_id", this.deviceId)
            .order("cursor", { ascending: true }),
        );
        for (const r of rows ?? []) this.#deliverCommand(r);
      }
      for (const aid of [...this.#approvalWatchers.keys()]) await this.#fetchDecision(aid);
    } catch (err) {
      this.log?.error("realtime.resync_failed", { error: err instanceof Error ? err.message : "error" });
    }
  }

  async #fetchCommand(id: string): Promise<void> {
    if (!this.#commandHandler || this.#delivered.has(id)) return;
    const row = await must<CommandRow | null>(
      "read command",
      this.db
        .from("commands")
        .select("id, env, from_device_id")
        .eq("owner", this.owner)
        .eq("target_device_id", this.deviceId)
        .eq("id", id)
        .maybeSingle(),
    );
    if (row) this.#deliverCommand(row);
  }

  #deliverCommand(r: CommandRow): void {
    if (!this.#commandHandler || this.#delivered.has(r.id)) return;
    this.#delivered.add(r.id);
    this.#commandHandler(r.id, { env: r.env, fromDeviceId: r.from_device_id });
  }

  async #fetchDecision(aid: string): Promise<void> {
    const cb = this.#approvalWatchers.get(aid);
    if (!cb) return;
    const row = await must<{ decision: unknown } | null>(
      "read approval",
      this.db.from("approvals").select("decision").eq("owner", this.owner).eq("aid", aid).maybeSingle(),
    );
    if (!row?.decision) return;
    const fp = JSON.stringify(row.decision);
    if (this.#seenDecision.get(aid) === fp) return;
    this.#seenDecision.set(aid, fp);
    cb(row.decision);
  }

  /** Leaves the channel (daemon shutdown). */
  async close(): Promise<void> {
    if (this.#channel) await this.db.removeChannel(this.#channel);
    this.#channel = null;
  }

  // ---- approvals -----------------------------------------------------------------

  async createApproval(req: ApprovalRequest) {
    await must(
      "create approval",
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
        created_at: iso(req.createdAt),
        expires_at: iso(req.expiresAt),
        recommendations: req.recommendations ?? [],
      }),
    );
  }

  watchApproval(aid: string, onDecision: (decision: unknown) => void) {
    this.#approvalWatchers.set(aid, onDecision);
    this.#ensureChannel();
    // A decision attached before the watch started (or before the channel joined).
    void this.#fetchDecision(aid).catch((err: unknown) =>
      this.log?.error("approval.read_failed", { aid, error: err instanceof Error ? err.message : "error" }),
    );
    return () => {
      this.#approvalWatchers.delete(aid);
      this.#seenDecision.delete(aid);
    };
  }

  async resolveApproval(aid: string, status: ApprovalRequest["status"], reason: string, at: number) {
    await must(
      "resolve approval",
      this.db
        .from("approvals")
        .update({ status, reason, resolved_at: iso(at) })
        .eq("owner", this.owner)
        .eq("aid", aid),
    );
  }

  // ---- sessions ------------------------------------------------------------------

  async writeEvent(e: AgentEvent) {
    await must(
      "write event",
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
    await must("merge session", this.db.rpc("session_merge", { p_sid: sid, p_patch: patch }));
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
    await must(
      "delete command",
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
    await must("update device", this.#device().update(patch).eq("owner", this.owner).eq("device_id", this.deviceId));
  }

  async publishDeviceEvent(raw: DeviceEvent) {
    const e = sanitizeDeviceEvent(raw);
    await must(
      "device event",
      this.#device().update({ last_event: e }).eq("owner", this.owner).eq("device_id", this.deviceId),
    );
    await this.audit({ eid: randomUUID(), t: e.t, type: e.type, meta: { ...e }, source: "deviceEvent" });
  }

  async audit(entry: AuditEntry) {
    const meta = JSON.parse(JSON.stringify(redactDeep(entry.meta) ?? {})) as Record<string, unknown>;
    await must(
      "audit",
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

  async writeCallLine(id: string, line: CallLine) {
    await must(
      "write call line",
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
    await must("delete call line", this.db.from("call_lines").delete().eq("owner", this.owner).eq("lid", id)).catch(
      () => undefined,
    );
  }
}

interface CommandRow {
  id: string;
  env: unknown;
  from_device_id: string;
}
