import type { Sql, TransactionSql } from "postgres";
import type {
  CodingAgent,
  CodingBlock,
  CodingCredential,
  CodingOwnerState,
  CodingPatch,
  CodingProvider,
  CodingRecord,
  CodingStore,
  CodingTx,
} from "./coding.js";

/** Migration 20261021002000, as chalito_ai_gateway (apps/ai-gateway's role). */
type Row = {
  id: string;
  owner: string;
  device_id: string;
  sid: string;
  agent: CodingAgent;
  provider: CodingProvider;
  models: string[];
  hold_gen: number;
  reservation_id: string | null;
  inflight_micros: string;
  inflight_requests: number;
  requests: number;
  blocked_reason: CodingBlock | null;
  expires_at: Date;
  revoked_at: Date | null;
  settled_at: Date | null;
};

const COLS = `id, owner, device_id, sid, agent, provider, models, hold_gen, reservation_id, inflight_micros,
  inflight_requests, requests, blocked_reason, expires_at, revoked_at, settled_at`;

const fromRow = (r: Row): CodingCredential => ({
  id: r.id,
  owner: r.owner,
  deviceId: r.device_id,
  sid: r.sid,
  agent: r.agent,
  provider: r.provider,
  models: r.models,
  holdGen: r.hold_gen,
  reservationId: r.reservation_id,
  inflightMicros: Number(r.inflight_micros),
  inflightRequests: r.inflight_requests,
  requests: r.requests,
  blockedReason: r.blocked_reason,
  expiresAt: r.expires_at.getTime(),
  revokedAt: r.revoked_at ? r.revoked_at.getTime() : null,
  settledAt: r.settled_at ? r.settled_at.getTime() : null,
});

class PgCodingTx implements CodingTx {
  constructor(
    private readonly tx: TransactionSql,
    private c: CodingCredential,
  ) {}

  credential() {
    return this.c;
  }

  async owner(): Promise<CodingOwnerState> {
    // Serializes the owner's begins (whichever session), so the cap check sees every request in flight.
    await this.tx`select pg_advisory_xact_lock(hashtextextended(${`coding:${this.c.owner}`}, 0))`;
    const [r] = await this.tx<
      {
        tier: string | null;
        cap: string | null;
        cap_tz: string | null;
        cap_tz_next: string | null;
        cap_tz_from: Date | null;
        revoked: boolean | null;
        inflight: string;
      }[]
    >`
      select u.tier, s.daily_cap_tokens as cap, s.cap_tz, s.cap_tz_next, s.cap_tz_from,
             (select d.revoked from chalito.devices d where d.owner = u.id and d.device_id = ${this.c.deviceId}) as revoked,
             (select coalesce(sum(k.inflight_micros), 0) from chalito_private.coding_credentials k
              where k.owner = u.id and k.inflight_micros > 0) as inflight
      from chalito.users u left join chalito.coding_settings s on s.owner = u.id
      where u.id = ${this.c.owner}`;
    return {
      tier: r?.tier ?? null,
      capZone: {
        tz: r?.cap_tz ?? null,
        next: r?.cap_tz_next ?? null,
        from: r?.cap_tz_from ? r.cap_tz_from.getTime() : null,
      },
      capTokens: r?.cap == null ? null : Number(r.cap),
      // A device row that's gone counts as revoked.
      deviceRevoked: r?.revoked !== false,
      inflightMicros: Number(r?.inflight ?? 0),
    };
  }

  async spentOn(day: string) {
    const [r] = await this.tx<{ s: string }[]>`
      select coalesce(sum(billable_tokens), 0) as s from chalito.coding_spend_daily
      where owner = ${this.c.owner} and day = ${day}`;
    return Number(r?.s ?? 0);
  }

  async unsentMicros() {
    const [r] = await this.tx<{ s: string }[]>`
      select coalesce(sum((event ->> 'cost_usd_micros')::bigint), 0) as s from chalito_private.usage_outbox
      where owner = ${this.c.owner} and status = 'pending' and source_id like ${`coding:${this.c.id}:r%`}`;
    return Number(r?.s ?? 0);
  }

  async update(p: CodingPatch) {
    const next = { ...this.c, ...p };
    const [r] = await this.tx<Row[]>`
      update chalito_private.coding_credentials set
        hold_gen = ${next.holdGen}, reservation_id = ${next.reservationId},
        inflight_micros = ${next.inflightMicros}, inflight_requests = ${next.inflightRequests},
        requests = ${next.requests}, blocked_reason = ${next.blockedReason},
        settled_at = ${next.settledAt === null ? null : new Date(next.settledAt)}
        ${p.revoked ? this.tx`, revoked_at = ${new Date(p.revoked.at)}, revoked_reason = ${p.revoked.reason}` : this.tx``}
      where id = ${this.c.id}
      returning ${this.tx.unsafe(COLS)}`;
    this.c = fromRow(r!);
  }

  async record(r: CodingRecord) {
    const inserted = await this.tx`
      insert into chalito_private.usage_outbox (owner, source_id, event)
      values (${this.c.owner}, ${r.event.source_id}, ${this.tx.json(r.event as never)})
      on conflict (source_id) do nothing
      returning id`;
    if (inserted.length === 0) return false;
    await this.tx`
      insert into chalito.coding_spend_daily (owner, day, agent, cost_usd_micros, billable_tokens, requests)
      values (${this.c.owner}, ${r.day}, ${r.agent}, ${r.costMicros}, ${r.billableTokens}, 1)
      on conflict (owner, day, agent) do update set
        cost_usd_micros = coding_spend_daily.cost_usd_micros + excluded.cost_usd_micros,
        billable_tokens = coding_spend_daily.billable_tokens + excluded.billable_tokens,
        requests = coding_spend_daily.requests + 1,
        updated_at = now()`;
    await this.tx`
      update chalito_private.coding_credentials set spent_micros = spent_micros + ${r.costMicros} where id = ${this.c.id}`;
    return true;
  }
}

export class PostgresCodingStore implements CodingStore {
  constructor(private readonly sql: Sql) {}

  async byTokenHash(hash: string) {
    const [r] = await this.sql<Row[]>`
      select ${this.sql.unsafe(COLS)} from chalito_private.coding_credentials where token_hash = ${hash}`;
    return r ? fromRow(r) : null;
  }

  async withCredential<T>(id: string, fn: (tx: CodingTx) => Promise<T>): Promise<T | null> {
    return (await this.sql.begin(async (tx: TransactionSql) => {
      const [r] = await tx<Row[]>`
        select ${tx.unsafe(COLS)} from chalito_private.coding_credentials where id = ${id} for update`;
      if (!r) return null;
      return fn(new PgCodingTx(tx, fromRow(r)));
    })) as T | null;
  }

  async unsettled(now: number, limit: number) {
    const rows = await this.sql<{ id: string }[]>`
      select id from chalito_private.coding_credentials
      where settled_at is null and (revoked_at is not null or expires_at <= ${new Date(now)})
      order by expires_at limit ${limit}`;
    return rows.map((r) => r.id);
  }
}
