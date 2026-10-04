import type { Sql, TransactionSql } from "postgres";
import type { HubUsageEvent } from "@chalito/protocol";
import type { OutboxRow, OutboxStore } from "./outbox.js";

/**
 * chalito_private.usage_outbox (migration 20261004001500), as chalito_server. `enqueue` takes
 * the caller's transaction so the event commits with the work it bills for.
 */
export const enqueueUsage = async (tx: Sql | TransactionSql, owner: string, events: (HubUsageEvent | null)[]) => {
  for (const e of events) {
    if (!e) continue; // not billable (BYO, coding sessions): never stored, never sent
    await tx`
      insert into chalito_private.usage_outbox (owner, source_id, event)
      values (${owner}, ${e.source_id}, ${tx.json(e as never)})
      on conflict (source_id) do nothing`;
  }
};

export class PostgresOutbox implements OutboxStore {
  constructor(private readonly sql: Sql) {}

  async claimDue(limit: number, now: number): Promise<OutboxRow[]> {
    // Push the claimed rows' next attempt out, so a concurrent drainer skips them.
    const rows = await this.sql<{ id: string; source_id: string; event: unknown; attempts: number }[]>`
      update chalito_private.usage_outbox set next_attempt_at = ${new Date(now + 5 * 60_000)}
      where id in (
        select id from chalito_private.usage_outbox
        where status = 'pending' and next_attempt_at <= ${new Date(now)}
        order by id limit ${limit}
        for update skip locked
      )
      returning id, source_id, event, attempts`;
    return rows
      .map((r) => ({ id: Number(r.id), sourceId: r.source_id, event: r.event, attempts: r.attempts }))
      .sort((a, b) => a.id - b.id);
  }

  async markSent(ids: number[], now: number) {
    await this
      .sql`update chalito_private.usage_outbox set status = 'sent', sent_at = ${new Date(now)}, last_error = null
                   where id = any(${ids})`;
  }

  async markRetry(ids: number[], nextAttemptAt: number, error: string) {
    await this.sql`update chalito_private.usage_outbox
                   set attempts = attempts + 1, next_attempt_at = ${new Date(nextAttemptAt)}, last_error = ${error.slice(0, 500)}
                   where id = any(${ids})`;
  }

  async markDead(ids: number[], error: string) {
    await this.sql`update chalito_private.usage_outbox set status = 'dead', last_error = ${error.slice(0, 500)}
                   where id = any(${ids})`;
  }
}
