import { HubUsageEvent } from "@chalito/protocol";
import type { HubClient, UsageResult } from "./hub.js";

/**
 * The usage outbox (ADR 0013): events are written in the same transaction as the work, then
 * drained to the hub with backoff. Nothing is ever dropped: permanent refusals are kept as
 * `dead` and alerted.
 */
export interface OutboxRow {
  id: number;
  /** The source_id column (the idempotency key), independent of the stored event. */
  sourceId: string;
  /** As stored. It is validated against HubUsageEvent before it is ever sent. */
  event: unknown;
  attempts: number;
}

export interface OutboxStore {
  /** Claims up to `limit` due rows (so concurrent drainers don't double-send). */
  claimDue(limit: number, now: number): Promise<OutboxRow[]>;
  markSent(ids: number[], now: number): Promise<void>;
  markRetry(ids: number[], nextAttemptAt: number, error: string): Promise<void>;
  markDead(ids: number[], error: string): Promise<void>;
}

/** 30 s, 1 min, 2 min, … capped at 1 h. */
export const backoffMs = (attempts: number) => Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts));

export interface DrainResult {
  sent: number;
  retried: number;
  dead: number;
}

type Valid = { id: number; sourceId: string; event: HubUsageEvent; attempts: number };
type DrainDeps = {
  store: OutboxStore;
  hub: Pick<HubClient, "usage">;
  now: () => number;
  alert: (msg: string, meta: Record<string, unknown>) => void;
};

/**
 * Sends rows as one batch. The hub answers once per batch, so a permanent refusal of a batch of
 * several rows is bisected (R-M6): each half is sent again (idempotent on source_id) until only the
 * rows the hub really refuses are left, and only those go dead.
 */
const sendRows = async (p: DrainDeps, rows: Valid[], total: DrainResult): Promise<"ok" | "stop"> => {
  const result: UsageResult = await p.hub.usage(rows.map((r) => r.event));
  const ids = rows.map((r) => r.id);
  if (result.status === "ok") {
    await p.store.markSent(ids, p.now());
    total.sent += ids.length;
    return "ok";
  }
  if (result.status === "retry") {
    const attempts = Math.max(...rows.map((r) => r.attempts));
    await p.store.markRetry(ids, p.now() + backoffMs(attempts), result.error || String(result.httpStatus));
    total.retried += ids.length;
    return "stop";
  }
  if (rows.length > 1) {
    const mid = Math.ceil(rows.length / 2);
    if ((await sendRows(p, rows.slice(0, mid), total)) === "stop") {
      const rest = rows.slice(mid);
      await p.store.markRetry(
        rest.map((r) => r.id),
        p.now() + backoffMs(Math.max(...rest.map((r) => r.attempts))),
        "deferred: the hub asked to retry",
      );
      total.retried += rest.length;
      return "stop";
    }
    return sendRows(p, rows.slice(mid), total);
  }
  await p.store.markDead(ids, `${result.httpStatus}: ${result.error}`);
  p.alert("billing.usage_dead", { count: 1, httpStatus: result.httpStatus, sourceIds: [rows[0]!.sourceId] });
  total.dead += 1;
  return "ok";
};

export const drainOutbox = async (p: {
  store: OutboxStore;
  hub: Pick<HubClient, "usage">;
  now: () => number;
  alert: (msg: string, meta: Record<string, unknown>) => void;
  /** Batches until nothing is due, up to this many. */
  maxBatches?: number;
}): Promise<DrainResult> => {
  const total: DrainResult = { sent: 0, retried: 0, dead: 0 };
  for (let b = 0; b < (p.maxBatches ?? 10); b++) {
    const claimed = await p.store.claimDue(100, p.now());
    if (claimed.length === 0) break;
    // Never send a malformed event (the hub would only refuse it): dead-letter it and alert.
    const rows: Valid[] = [];
    const invalid: OutboxRow[] = [];
    for (const r of claimed) {
      const parsed = HubUsageEvent.safeParse(r.event);
      if (parsed.success && parsed.data.source_id === r.sourceId) rows.push({ ...r, event: parsed.data });
      else invalid.push(r);
    }
    if (invalid.length) {
      await p.store.markDead(
        invalid.map((r) => r.id),
        "invalid event: not a HubUsageEvent, or its source_id differs from the row's",
      );
      p.alert("billing.usage_invalid", { count: invalid.length, sourceIds: invalid.map((r) => r.sourceId) });
      total.dead += invalid.length;
    }
    if (rows.length === 0) continue;
    if ((await sendRows(p, rows, total)) === "stop") break; // the hub is struggling; stop for now
  }
  return total;
};

/** In-memory outbox for tests and local runs. */
export class MemoryOutbox implements OutboxStore {
  rows: (Omit<OutboxRow, "event"> & {
    event: HubUsageEvent;
    status: "pending" | "sent" | "dead";
    nextAttemptAt: number;
    lastError: string | null;
    owner: string;
  })[] = [];
  #id = 0;
  async enqueue(owner: string, events: (HubUsageEvent | null)[]) {
    for (const event of events) {
      if (!event || this.rows.some((r) => r.sourceId === event.source_id)) continue;
      this.rows.push({
        id: ++this.#id,
        owner,
        sourceId: event.source_id,
        event,
        attempts: 0,
        status: "pending",
        nextAttemptAt: 0,
        lastError: null,
      });
    }
  }
  async claimDue(limit: number, now: number) {
    return this.rows.filter((r) => r.status === "pending" && r.nextAttemptAt <= now).slice(0, limit);
  }
  async markSent(ids: number[]) {
    for (const r of this.rows) if (ids.includes(r.id)) r.status = "sent";
  }
  async markRetry(ids: number[], next: number, error: string) {
    for (const r of this.rows)
      if (ids.includes(r.id)) Object.assign(r, { attempts: r.attempts + 1, nextAttemptAt: next, lastError: error });
  }
  async markDead(ids: number[], error: string) {
    for (const r of this.rows) if (ids.includes(r.id)) Object.assign(r, { status: "dead", lastError: error });
  }
}
