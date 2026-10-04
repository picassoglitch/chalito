import type { Sql } from "postgres";
import type { AuditEvent, AuditSink } from "../deps.js";

/**
 * chalito.server_audit (migration 20261004002400), the owner-readable copy of server security
 * events behind the chalito.audit_* views. Events without an owner (hub tenant calls) have nowhere
 * owner-scoped to go and stay in the BigQuery stream only.
 */
export class PostgresAuditSink implements AuditSink {
  constructor(private readonly sql: Sql) {}

  async record(e: AuditEvent): Promise<void> {
    if (!e.owner) return;
    await this.sql`
      insert into chalito.server_audit (owner, action, actor, target, meta)
      values (${e.owner}, ${e.action}, ${e.actor.slice(0, 128)}, ${e.target?.slice(0, 200) ?? null},
              ${this.sql.json((e.meta ?? {}) as never)})`;
  }
}

/** Writes to every sink; one failing sink never loses the others (and never fails the request). */
export const teeAudit = (...sinks: AuditSink[]): AuditSink => ({
  async record(e) {
    const results = await Promise.allSettled(sinks.map((s) => s.record(e)));
    for (const r of results)
      if (r.status === "rejected")
        console.error("[audit] sink failed", r.reason instanceof Error ? r.reason.message : "error");
  },
});
