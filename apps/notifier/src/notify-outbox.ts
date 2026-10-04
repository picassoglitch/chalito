import { createHmac, timingSafeEqual } from "node:crypto";
import type { Sql } from "postgres";

/**
 * chalito_private.notify_outbox (migration 20261004003050): what the database's triggers queue for
 * the escalation engine (approvals, agent questions, room events, notifications written outside
 * the notifier). A pg_net poke delivers one row in seconds; POST /tasks/drain-notify picks up the
 * rest every minute. Rows are claimed with a lease, so a poke and the drain never both deliver one.
 */
export interface OutboxMessage {
  id: number;
  owner: string;
  message: unknown;
  attempts: number;
}

export interface NotifyOutboxStore {
  /** Claims one row by id (a poke), or up to `limit` due rows (the drain), leasing them. */
  claim(p: { id?: number; limit: number; now: number; leaseMs: number }): Promise<OutboxMessage[]>;
  finish(id: number, now: number): Promise<void>;
  /** Retry at `nextAt`, or dead-letter when `nextAt` is null. */
  fail(id: number, error: string, nextAt: number | null): Promise<void>;
}

export const MAX_ATTEMPTS = 10;
/** 30 s, 1 min, 2 min, … capped at 1 h. */
export const notifyBackoffMs = (attempts: number) => Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts));

export interface ProcessResult {
  delivered: number;
  retried: number;
  dead: number;
}

/**
 * Runs claimed rows through `handle` (the same escalation path as Pub/Sub `notifications`).
 * `handle` returns "invalid" for a message that can never be delivered (dead at once).
 */
export const processOutbox = async (p: {
  store: NotifyOutboxStore;
  rows: OutboxMessage[];
  now: () => number;
  handle: (row: OutboxMessage) => Promise<"ok" | "invalid">;
  alert: (msg: string, meta: Record<string, unknown>) => void;
}): Promise<ProcessResult> => {
  const r: ProcessResult = { delivered: 0, retried: 0, dead: 0 };
  for (const row of p.rows) {
    let outcome: "ok" | "invalid" | Error;
    try {
      outcome = await p.handle(row);
    } catch (err) {
      outcome = err instanceof Error ? err : new Error("error");
    }
    if (outcome === "ok") {
      await p.store.finish(row.id, p.now());
      r.delivered++;
      continue;
    }
    const error = outcome === "invalid" ? "invalid message" : outcome.message.slice(0, 300);
    const attempts = row.attempts + 1;
    if (outcome === "invalid" || attempts >= MAX_ATTEMPTS) {
      await p.store.fail(row.id, error, null);
      p.alert("notifier.outbox_dead", { id: row.id, owner: row.owner, attempts, error });
      r.dead++;
    } else {
      await p.store.fail(row.id, error, p.now() + notifyBackoffMs(attempts));
      r.retried++;
    }
  }
  return r;
};

/** The pg_net poke's signature: hex HMAC-SHA256 of "<ts>.<id>", within ±5 minutes. */
export const signPoke = (secret: string, id: number, ts: number) =>
  createHmac("sha256", secret).update(`${ts}.${id}`).digest("hex");

export const verifyPoke = (
  secret: string,
  signature: string | undefined,
  body: { id: number; ts: number },
  nowMs: number,
  skewMs = 5 * 60_000,
) => {
  if (!secret || !signature || Math.abs(nowMs - body.ts) > skewMs) return false;
  const want = Buffer.from(signPoke(secret, body.id, body.ts));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
};

export class PostgresNotifyOutbox implements NotifyOutboxStore {
  constructor(private readonly sql: Sql) {}

  async claim(p: { id?: number; limit: number; now: number; leaseMs: number }) {
    // The later of this instance's clock and the database's: rows are stamped with the database's
    // now(), so an instance whose clock lags must not see a fresh row as "not due yet".
    const now = this.sql`greatest(now(), ${new Date(p.now)}::timestamptz)`;
    const rows = await this.sql<{ id: string; owner: string; message: unknown; attempts: number }[]>`
      update chalito_private.notify_outbox o
      set status = 'processing', lease_until = ${now} + make_interval(secs => ${p.leaseMs / 1000})
      where o.id in (
        select id from chalito_private.notify_outbox
        where ${p.id === undefined ? this.sql`true` : this.sql`id = ${p.id}`}
          and next_attempt_at <= ${now}
          and (status = 'pending' or (status = 'processing' and lease_until < ${now}))
        order by id
        limit ${p.limit}
        for update skip locked
      )
      returning o.id, o.owner, o.message, o.attempts`;
    return rows.map((r) => ({ id: Number(r.id), owner: r.owner, message: r.message, attempts: r.attempts }));
  }

  async finish(id: number, now: number) {
    await this.sql`
      update chalito_private.notify_outbox set status = 'sent', sent_at = ${new Date(now)}, lease_until = null
      where id = ${id}`;
  }

  async fail(id: number, error: string, nextAt: number | null) {
    await this.sql`
      update chalito_private.notify_outbox
      set status = ${nextAt === null ? "dead" : "pending"}, attempts = attempts + 1, last_error = ${error.slice(0, 500)},
          next_attempt_at = ${nextAt === null ? this.sql`next_attempt_at` : new Date(nextAt)}, lease_until = null
      where id = ${id}`;
  }
}

export class MemoryNotifyOutbox implements NotifyOutboxStore {
  rows: (OutboxMessage & {
    status: "pending" | "processing" | "sent" | "dead";
    nextAttemptAt: number;
    leaseUntil: number | null;
    lastError: string | null;
  })[] = [];
  #id = 0;
  add(owner: string, message: unknown) {
    const id = ++this.#id;
    this.rows.push({
      id,
      owner,
      message,
      attempts: 0,
      status: "pending",
      nextAttemptAt: 0,
      leaseUntil: null,
      lastError: null,
    });
    return id;
  }
  async claim(p: { id?: number; limit: number; now: number; leaseMs: number }) {
    const due = this.rows
      .filter(
        (r) =>
          (p.id === undefined || r.id === p.id) &&
          r.nextAttemptAt <= p.now &&
          (r.status === "pending" || (r.status === "processing" && (r.leaseUntil ?? 0) < p.now)),
      )
      .slice(0, p.limit);
    for (const r of due) Object.assign(r, { status: "processing", leaseUntil: p.now + p.leaseMs });
    return due.map(({ id, owner, message, attempts }) => ({ id, owner, message, attempts }));
  }
  async finish(id: number) {
    Object.assign(
      this.rows.find((r) => r.id === id)!,
      { status: "sent", leaseUntil: null },
    );
  }
  async fail(id: number, error: string, nextAt: number | null) {
    const r = this.rows.find((x) => x.id === id)!;
    Object.assign(r, {
      status: nextAt === null ? "dead" : "pending",
      attempts: r.attempts + 1,
      lastError: error,
      nextAttemptAt: nextAt ?? r.nextAttemptAt,
      leaseUntil: null,
    });
  }
}
