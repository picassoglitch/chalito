import postgres, { type Sql } from "postgres";
import type { GatewayReader, GatewayToken, McpScope, PendingApproval } from "./reader.js";

/** A connection that acts as chalito_gateway (read-only; see migration 20261004001800). */
export const gatewaySql = (url: string, opts: { role?: string; max?: number } = {}): Sql =>
  postgres(url, {
    max: opts.max ?? 5,
    onnotice: () => {},
    ...(opts.role ? { connection: { role: opts.role } } : {}),
  });

const ms = (d: Date | null) => (d ? d.getTime() : null);

export class PostgresGatewayReader implements GatewayReader {
  constructor(private readonly sql: Sql) {}

  async accessToken(tokenHash: string, now: number): Promise<GatewayToken | null> {
    const [r] = await this.sql<
      {
        owner: string;
        cid: string;
        client_id: string;
        provider: GatewayToken["provider"];
        scopes: string[];
        resource: string;
        expires_at: Date;
      }[]
    >`
      select t.owner, t.cid, t.client_id, c.provider, t.scopes, t.resource, t.expires_at
      from chalito_private.oauth_tokens t
      join chalito.connectors c on c.owner = t.owner and c.cid = t.cid
      where t.token_hash = ${tokenHash} and t.kind = 'access'
        and t.expires_at > ${new Date(now)} and c.revoked_at is null`;
    if (!r) return null;
    return {
      owner: r.owner,
      cid: r.cid,
      clientId: r.client_id,
      provider: r.provider,
      scopes: r.scopes as McpScope[],
      resource: r.resource,
      expiresAt: r.expires_at.getTime(),
    };
  }

  async pending(owner: string, now: number): Promise<PendingApproval[]> {
    const rows = await this.sql<
      {
        aid: string;
        sid: string;
        device_id: string;
        kind: PendingApproval["kind"];
        risk: PendingApproval["risk"];
        origin: string;
        step_up_required: boolean;
        created_at: Date;
        expires_at: Date;
        recommendations: number;
      }[]
    >`
      select aid, sid, device_id, kind, risk, origin, step_up_required, created_at, expires_at,
             jsonb_array_length(recommendations)::int as recommendations
      from chalito.approvals
      where owner = ${owner} and status = 'pending' and expires_at > ${new Date(now)}
      order by created_at
      limit 50`;
    return rows.map((r) => ({
      aid: r.aid,
      sid: r.sid,
      deviceId: r.device_id,
      kind: r.kind,
      risk: r.risk,
      origin: r.origin,
      stepUpRequired: r.step_up_required,
      createdAt: r.created_at.getTime(),
      expiresAt: r.expires_at.getTime(),
      recommendations: r.recommendations,
    }));
  }

  async session(owner: string, sid: string) {
    // The gateway sees sessions only through chalito_private.gateway_sessions (adapter and state,
    // never the rest of doc; migration 002800).
    const [r] = await this.sql<
      {
        sid: string;
        device_id: string;
        name: string | null;
        adapter: string | null;
        state: string | null;
        updated_at: Date | null;
      }[]
    >`
      select s.sid, s.device_id, d.name, s.adapter, s.state, s.updated_at
      from chalito_private.gateway_sessions s
      left join chalito.devices d on d.owner = s.owner and d.device_id = s.device_id
      where s.owner = ${owner} and s.sid = ${sid}`;
    if (!r) return null;
    return {
      sid: r.sid,
      deviceId: r.device_id,
      deviceName: r.name,
      adapter: r.adapter,
      state: r.state,
      updatedAt: ms(r.updated_at),
    };
  }

  async sharedCard(owner: string, sid: string) {
    const [r] = await this.sql<{ card: Record<string, unknown> }[]>`
      select p.card from chalito.session_card_plain p
      where p.owner = ${owner} and p.sid = ${sid}
        and chalito_private.mcp_sharing_on(p.owner, p.sid, p.device_id)`;
    return r?.card ?? null;
  }

  async clientBoxKeys(owner: string) {
    const rows = await this.sql<{ device_id: string; pub_box: string }[]>`
      select device_id, pub_box from chalito.devices where owner = ${owner} and role = 'client' and not revoked`;
    return Object.fromEntries(rows.map((r) => [r.device_id, r.pub_box]));
  }

  async sessionAgent(owner: string, sid: string) {
    const [r] = await this.sql<{ device_id: string; pub_box: string }[]>`
      select d.device_id, d.pub_box from chalito_private.gateway_sessions s
      join chalito.devices d on d.owner = s.owner and d.device_id = s.device_id
      where s.owner = ${owner} and s.sid = ${sid} and d.role = 'agent' and not d.revoked`;
    return r ? { deviceId: r.device_id, pubBox: r.pub_box } : null;
  }
}
