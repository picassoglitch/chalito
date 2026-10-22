import type { Sql } from "postgres";

export interface DeletionStatus {
  /** "deleting": the job claimed it; a cancel is too late. */
  status: "scheduled" | "cancelled" | "deleting";
  requestedAt: number;
  dueAt: number;
  exportPath: string;
}

/** chalito_private.account_deletions + the export/delete functions (migration 20261004003030). */
export interface AccountStore {
  status(owner: string): Promise<DeletionStatus | null>;
  /** "exists" when a deletion is already scheduled (a cancelled one can be scheduled again). */
  schedule(owner: string, by: string, at: number, dueAt: number, exportPath: string): Promise<"scheduled" | "exists">;
  cancel(owner: string, at: number): Promise<boolean>;
  /** Scheduled (or a crashed run's) owners that are due. */
  due(now: number): Promise<string[]>;
  /** Atomically moves a due owner to "deleting"; false when it was cancelled meanwhile. */
  claim(owner: string, now: number): Promise<boolean>;
  export(owner: string): Promise<Record<string, unknown>>;
  deviceIds(owner: string): Promise<string[]>;
  deleteAccount(owner: string): Promise<void>;
}

export class PostgresAccountStore implements AccountStore {
  constructor(private readonly sql: Sql) {}

  async status(owner: string) {
    const [r] = await this.sql<
      { status: DeletionStatus["status"]; requested_at: Date; due_at: Date; export_path: string }[]
    >`
      select status, requested_at, due_at, export_path from chalito_private.account_deletions where owner = ${owner}`;
    return r
      ? {
          status: r.status,
          requestedAt: r.requested_at.getTime(),
          dueAt: r.due_at.getTime(),
          exportPath: r.export_path,
        }
      : null;
  }

  async schedule(owner: string, by: string, at: number, dueAt: number, exportPath: string) {
    const rows = await this.sql`
      insert into chalito_private.account_deletions (owner, status, requested_at, requested_by, due_at, export_path)
      values (${owner}, 'scheduled', ${new Date(at)}, ${by}, ${new Date(dueAt)}, ${exportPath})
      on conflict (owner) do update
        set status = 'scheduled', requested_at = excluded.requested_at, requested_by = excluded.requested_by,
            due_at = excluded.due_at, export_path = excluded.export_path, cancelled_at = null
        where chalito_private.account_deletions.status = 'cancelled'
      returning owner`;
    return rows.length ? ("scheduled" as const) : ("exists" as const);
  }

  async cancel(owner: string, at: number) {
    const rows = await this.sql`
      update chalito_private.account_deletions set status = 'cancelled', cancelled_at = ${new Date(at)}
      where owner = ${owner} and status = 'scheduled' returning owner`;
    return rows.length > 0;
  }

  async due(now: number) {
    const rows = await this.sql<{ owner: string }[]>`
      select owner from chalito_private.account_deletions
      where status in ('scheduled', 'deleting') and due_at <= ${new Date(now)} order by due_at limit 50`;
    return rows.map((r) => r.owner);
  }

  async claim(owner: string, now: number) {
    // 'deleting' again too: a run that crashed mid-delete is retried, and every step is idempotent.
    const rows = await this.sql`
      update chalito_private.account_deletions set status = 'deleting'
      where owner = ${owner} and status in ('scheduled', 'deleting') and due_at <= ${new Date(now)}
      returning owner`;
    return rows.length > 0;
  }

  async export(owner: string) {
    const [r] = await this.sql<{ x: Record<string, unknown> }[]>`select chalito_private.export_account(${owner}) as x`;
    return r!.x;
  }

  async deviceIds(owner: string) {
    const rows = await this.sql<{ device_id: string }[]>`select device_id from chalito.devices where owner = ${owner}`;
    return rows.map((r) => r.device_id);
  }

  async deleteAccount(owner: string) {
    await this.sql`select chalito_private.delete_account(${owner})`;
  }
}
