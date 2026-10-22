import type { Sql, TransactionSql } from "postgres";
import {
  planCapZone,
  type CapZone,
  type CodingAgent,
  type CodingBlock,
  type CodingProvider,
  type CodingRevokeReason,
} from "@chalito/billing";

/** The api's side of migration 20261021002000, as chalito_server: issue, read, revoke; caps and spend. */
export interface IssuedCredential {
  id: string;
  tokenHash: string;
  owner: string;
  deviceId: string;
  sid: string;
  agent: CodingAgent;
  provider: CodingProvider;
  models: string[];
  reservationId: string;
  createdAt: number;
  expiresAt: number;
}

export interface CredentialView {
  id: string;
  sid: string;
  agent: CodingAgent;
  expiresAt: number;
  revokedAt: number | null;
  revokedReason: CodingRevokeReason | null;
  blockedReason: CodingBlock | null;
}

export interface CodingIssueStore {
  owner(
    owner: string,
  ): Promise<{ tier: string | null; tz: string | null; capTokens: number | null; capZone: CapZone } | null>;
  /** Billable tokens per agent on the owner's local days from `fromDay` on (inclusive). */
  spend(
    owner: string,
    fromDay: string,
  ): Promise<{ day: string; agent: CodingAgent; billableTokens: number; requests: number }[]>;
  /** Live credentials on the device, not counting the one this session and agent would replace. */
  liveOnDevice(
    owner: string,
    deviceId: string,
    now: number,
    except: { sid: string; agent: CodingAgent },
  ): Promise<number>;
  /** One transaction serialized per device: re-counts live credentials (refusing past `maxLive`), revokes the
   *  session's previous one for this agent, stores the new one and freezes the cap's zone. */
  issue(c: IssuedCredential, maxLive: number): Promise<"issued" | "limit">;
  get(owner: string, deviceId: string, id: string): Promise<CredentialView | null>;
  revoke(owner: string, deviceId: string, id: string, reason: CodingRevokeReason, now: number): Promise<boolean>;
  setCap(owner: string, tokens: number, now: number): Promise<void>;
}

const ms = (d: Date | null) => (d ? d.getTime() : null);

export class PostgresCodingIssueStore implements CodingIssueStore {
  constructor(private readonly sql: Sql) {}

  async owner(owner: string) {
    const [r] = await this.sql<
      {
        tier: string | null;
        tz: string | null;
        cap: string | null;
        cap_tz: string | null;
        cap_tz_next: string | null;
        cap_tz_from: Date | null;
      }[]
    >`
      select u.tier, u.tz, s.daily_cap_tokens as cap, s.cap_tz, s.cap_tz_next, s.cap_tz_from
      from chalito.users u left join chalito.coding_settings s on s.owner = u.id where u.id = ${owner}`;
    return r
      ? {
          tier: r.tier,
          tz: r.tz,
          capTokens: r.cap == null ? null : Number(r.cap),
          capZone: { tz: r.cap_tz, next: r.cap_tz_next, from: ms(r.cap_tz_from) },
        }
      : null;
  }

  async spend(owner: string, fromDay: string) {
    const rows = await this.sql<{ day: Date; agent: CodingAgent; billable_tokens: string; requests: number }[]>`
      select day, agent, billable_tokens, requests from chalito.coding_spend_daily
      where owner = ${owner} and day >= ${fromDay} order by day, agent`;
    return rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      agent: r.agent,
      billableTokens: Number(r.billable_tokens),
      requests: r.requests,
    }));
  }

  async liveOnDevice(owner: string, deviceId: string, now: number, except: { sid: string; agent: CodingAgent }) {
    const [r] = await this.sql<{ n: number }[]>`
      select count(*)::int as n from chalito_private.coding_credentials
      where owner = ${owner} and device_id = ${deviceId} and revoked_at is null and expires_at > ${new Date(now)}
        and not (sid = ${except.sid} and agent = ${except.agent})`;
    return r?.n ?? 0;
  }

  async issue(c: IssuedCredential, maxLive: number) {
    return (await this.sql.begin(async (tx: TransactionSql) => {
      // One issue at a time per device, so the live count and the insert can't interleave.
      await tx`select pg_advisory_xact_lock(hashtextextended(${`coding-issue:${c.owner}:${c.deviceId}`}, 0))`;
      const [n] = await tx<{ n: number }[]>`
        select count(*)::int as n from chalito_private.coding_credentials
        where owner = ${c.owner} and device_id = ${c.deviceId} and revoked_at is null and expires_at > ${new Date(c.createdAt)}
          and not (sid = ${c.sid} and agent = ${c.agent})`;
      if ((n?.n ?? 0) >= maxLive) return "limit" as const;
      // The gateway's sweep settles the replaced credential's hold.
      await tx`
        update chalito_private.coding_credentials set revoked_at = ${new Date(c.createdAt)}, revoked_reason = 'reissued'
        where owner = ${c.owner} and device_id = ${c.deviceId} and sid = ${c.sid} and agent = ${c.agent}
          and revoked_at is null`;
      await tx`
        insert into chalito_private.coding_credentials
          (id, token_hash, owner, device_id, sid, agent, provider, models, reservation_id, created_at, expires_at)
        values (${c.id}, ${c.tokenHash}, ${c.owner}, ${c.deviceId}, ${c.sid}, ${c.agent}, ${c.provider}, ${c.models},
                ${c.reservationId}, ${new Date(c.createdAt)}, ${new Date(c.expiresAt)})`;
      const [z] = await tx<
        { tz: string | null; cap_tz: string | null; cap_tz_next: string | null; cap_tz_from: Date | null }[]
      >`
        select u.tz, s.cap_tz, s.cap_tz_next, s.cap_tz_from
        from chalito.users u left join chalito.coding_settings s on s.owner = u.id where u.id = ${c.owner}
        for update of u`;
      const plan = planCapZone(
        { tz: z?.cap_tz ?? null, next: z?.cap_tz_next ?? null, from: ms(z?.cap_tz_from ?? null) },
        z?.tz ?? null,
        c.createdAt,
      );
      await tx`
        insert into chalito.coding_settings (owner, cap_tz, cap_tz_next, cap_tz_from)
        values (${c.owner}, ${plan.tz}, ${plan.next}, ${plan.from === null ? null : new Date(plan.from)})
        on conflict (owner) do update set cap_tz = excluded.cap_tz, cap_tz_next = excluded.cap_tz_next,
          cap_tz_from = excluded.cap_tz_from`;
      return "issued" as const;
    })) as "issued" | "limit";
  }

  async get(owner: string, deviceId: string, id: string) {
    const [r] = await this.sql<
      {
        id: string;
        sid: string;
        agent: CodingAgent;
        expires_at: Date;
        revoked_at: Date | null;
        revoked_reason: CodingRevokeReason | null;
        blocked_reason: CodingBlock | null;
      }[]
    >`
      select id, sid, agent, expires_at, revoked_at, revoked_reason, blocked_reason from chalito_private.coding_credentials
      where id = ${id} and owner = ${owner} and device_id = ${deviceId}`;
    return r
      ? {
          id: r.id,
          sid: r.sid,
          agent: r.agent,
          expiresAt: r.expires_at.getTime(),
          revokedAt: ms(r.revoked_at),
          revokedReason: r.revoked_reason,
          blockedReason: r.blocked_reason,
        }
      : null;
  }

  async revoke(owner: string, deviceId: string, id: string, reason: CodingRevokeReason, now: number) {
    const rows = await this.sql`
      update chalito_private.coding_credentials set revoked_at = ${new Date(now)}, revoked_reason = ${reason}
      where id = ${id} and owner = ${owner} and device_id = ${deviceId} and revoked_at is null
      returning id`;
    return rows.length > 0;
  }

  async setCap(owner: string, tokens: number, now: number) {
    await this.sql`
      insert into chalito.coding_settings (owner, daily_cap_tokens, updated_at) values (${owner}, ${tokens}, ${new Date(now)})
      on conflict (owner) do update set daily_cap_tokens = excluded.daily_cap_tokens, updated_at = excluded.updated_at`;
  }
}
