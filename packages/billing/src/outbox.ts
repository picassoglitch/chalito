import type { HubUsageEvent } from "@chalito/protocol";
import type { HubClient, UsageResult } from "./hub.js";

/**
 * The usage outbox (ADR 0013): events are written in the same transaction as the work, then
 * drained to the hub with backoff. Nothing is ever dropped: permanent refusals are kept as
 * `dead` and alerted.
 */
export interface OutboxRow {
  id: number;
  event: HubUsageEvent;
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
    const rows = await p.store.claimDue(100, p.now());
    if (rows.length === 0) break;
    const result: UsageResult = await p.hub.usage(rows.map((r) => r.event));
    const ids = rows.map((r) => r.id);
    if (result.status === "ok") {
      await p.store.markSent(ids, p.now());
      total.sent += ids.length;
    } else if (result.status === "retry") {
      const attempts = Math.max(...rows.map((r) => r.attempts));
      await p.store.markRetry(ids, p.now() + backoffMs(attempts), result.error || String(result.httpStatus));
      total.retried += ids.length;
      break; // the hub is struggling; stop for now
    } else {
      await p.store.markDead(ids, `${result.httpStatus}: ${result.error}`);
      p.alert("billing.usage_dead", {
        count: ids.length,
        httpStatus: result.httpStatus,
        sourceIds: rows.map((r) => r.event.source_id),
      });
      total.dead += ids.length;
    }
  }
  return total;
};

/** In-memory outbox for tests and local runs. */
export class MemoryOutbox implements OutboxStore {
  rows: (OutboxRow & {
    status: "pending" | "sent" | "dead";
    nextAttemptAt: number;
    lastError: string | null;
    owner: string;
  })[] = [];
  #id = 0;
  async enqueue(owner: string, events: (HubUsageEvent | null)[]) {
    for (const event of events) {
      if (!event || this.rows.some((r) => r.event.source_id === event.source_id)) continue;
      this.rows.push({
        id: ++this.#id,
        owner,
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
