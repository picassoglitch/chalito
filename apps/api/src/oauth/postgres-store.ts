import type { Sql } from "postgres";
import type {
  AuthorizationRequest,
  CodeRecord,
  Grant,
  McpScope,
  McpStore,
  OAuthClient,
  Provider,
  TokenRecord,
  TokenWithGrant,
} from "./model.js";

const ms = (d: Date | null) => (d ? d.getTime() : null);
const ts = (n: number) => new Date(n);

/** McpStore on Postgres, as chalito_server (migrations 001700/001800). */
export class PostgresMcpStore implements McpStore {
  constructor(private readonly sql: Sql) {}

  async getClient(id: string): Promise<OAuthClient | null> {
    const [r] = await this.sql<
      {
        client_id: string;
        kind: "cimd" | "dcr";
        client_name: string;
        redirect_uris: string[];
        metadata: Record<string, unknown>;
        fetched_at: Date | null;
      }[]
    >`
      select client_id, kind, client_name, redirect_uris, metadata, fetched_at from chalito_private.oauth_clients where client_id = ${id}`;
    return r
      ? {
          clientId: r.client_id,
          kind: r.kind,
          clientName: r.client_name,
          redirectUris: r.redirect_uris,
          metadata: r.metadata,
          fetchedAt: ms(r.fetched_at),
        }
      : null;
  }
  async putClient(c: OAuthClient) {
    await this.sql`
      insert into chalito_private.oauth_clients (client_id, kind, client_name, redirect_uris, metadata, fetched_at)
      values (${c.clientId}, ${c.kind}, ${c.clientName}, ${c.redirectUris}, ${this.sql.json(c.metadata as never)},
              ${c.fetchedAt === null ? null : ts(c.fetchedAt)})
      on conflict (client_id) do update set client_name = excluded.client_name, redirect_uris = excluded.redirect_uris,
        metadata = excluded.metadata, fetched_at = excluded.fetched_at`;
  }
  async putRequest(r: AuthorizationRequest) {
    await this.sql`
      insert into chalito_private.oauth_requests (request_id, client_id, redirect_uri, code_challenge, scopes, state, resource, expires_at)
      values (${r.requestId}, ${r.clientId}, ${r.redirectUri}, ${r.codeChallenge}, ${r.scopes}, ${r.state}, ${r.resource}, ${ts(r.expiresAt)})`;
  }
  async getRequest(id: string, now: number): Promise<AuthorizationRequest | null> {
    const [r] = await this.sql<
      {
        request_id: string;
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        scopes: McpScope[];
        state: string | null;
        resource: string;
        expires_at: Date;
      }[]
    >`
      select * from chalito_private.oauth_requests where request_id = ${id} and expires_at > ${ts(now)}`;
    return r
      ? {
          requestId: r.request_id,
          clientId: r.client_id,
          redirectUri: r.redirect_uri,
          codeChallenge: r.code_challenge,
          scopes: r.scopes,
          state: r.state,
          resource: r.resource,
          expiresAt: r.expires_at.getTime(),
        }
      : null;
  }
  async deleteRequest(id: string) {
    await this.sql`delete from chalito_private.oauth_requests where request_id = ${id}`;
  }

  async createGrant(g: Grant) {
    await this.sql`
      insert into chalito.connectors (owner, cid, client_id, client_name, provider, scopes, resource, created_at)
      values (${g.owner}, ${g.cid}, ${g.clientId}, ${g.clientName}, ${g.provider}, ${g.scopes}, ${g.resource}, ${ts(g.createdAt)})`;
  }
  async listGrants(owner: string): Promise<Grant[]> {
    const rows = await this.sql<
      {
        owner: string;
        cid: string;
        client_id: string;
        client_name: string;
        provider: Provider;
        scopes: McpScope[];
        resource: string;
        created_at: Date;
        last_used_at: Date | null;
        revoked_at: Date | null;
      }[]
    >`
      select * from chalito.connectors where owner = ${owner} order by created_at desc`;
    return rows.map((r) => ({
      owner: r.owner,
      cid: r.cid,
      clientId: r.client_id,
      clientName: r.client_name,
      provider: r.provider,
      scopes: r.scopes,
      resource: r.resource,
      createdAt: r.created_at.getTime(),
      lastUsedAt: ms(r.last_used_at),
      revokedAt: ms(r.revoked_at),
    }));
  }
  async revokeGrant(owner: string, cid: string, at: number) {
    return this.sql.begin(async (tx) => {
      const rows = await tx`update chalito.connectors set revoked_at = coalesce(revoked_at, ${ts(at)})
                            where owner = ${owner} and cid = ${cid} returning cid`;
      await tx`delete from chalito_private.oauth_tokens where owner = ${owner} and cid = ${cid}`;
      await tx`delete from chalito_private.oauth_codes where owner = ${owner} and cid = ${cid}`;
      return rows.length > 0;
    });
  }
  async touchGrant(owner: string, cid: string, at: number) {
    await this.sql`update chalito.connectors set last_used_at = ${ts(at)} where owner = ${owner} and cid = ${cid}`;
  }

  async putCode(c: CodeRecord) {
    await this.sql`
      insert into chalito_private.oauth_codes (code_hash, owner, cid, client_id, redirect_uri, code_challenge, resource, scopes, expires_at)
      values (${c.codeHash}, ${c.owner}, ${c.cid}, ${c.clientId}, ${c.redirectUri}, ${c.codeChallenge}, ${c.resource}, ${c.scopes}, ${ts(c.expiresAt)})`;
  }
  async takeCode(h: string, now: number): Promise<CodeRecord | null> {
    const [r] = await this.sql<
      {
        code_hash: string;
        owner: string;
        cid: string;
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        resource: string;
        scopes: McpScope[];
        expires_at: Date;
      }[]
    >`
      delete from chalito_private.oauth_codes where code_hash = ${h} returning *`;
    if (!r || r.expires_at.getTime() <= now) return null;
    return {
      codeHash: r.code_hash,
      owner: r.owner,
      cid: r.cid,
      clientId: r.client_id,
      redirectUri: r.redirect_uri,
      codeChallenge: r.code_challenge,
      resource: r.resource,
      scopes: r.scopes,
      expiresAt: r.expires_at.getTime(),
    };
  }

  async putToken(t: TokenRecord) {
    await this.sql`
      insert into chalito_private.oauth_tokens (token_hash, kind, owner, cid, client_id, scopes, resource, expires_at)
      values (${t.tokenHash}, ${t.kind}, ${t.owner}, ${t.cid}, ${t.clientId}, ${t.scopes}, ${t.resource}, ${ts(t.expiresAt)})`;
  }
  async getToken(h: string): Promise<TokenWithGrant | null> {
    const [r] = await this.sql<
      {
        token_hash: string;
        kind: "access" | "refresh";
        owner: string;
        cid: string;
        client_id: string;
        scopes: McpScope[];
        resource: string;
        expires_at: Date;
        used_at: Date | null;
        provider: Provider;
        revoked_at: Date | null;
      }[]
    >`
      select t.*, g.provider, g.revoked_at from chalito_private.oauth_tokens t
      join chalito.connectors g on g.owner = t.owner and g.cid = t.cid where t.token_hash = ${h}`;
    return r
      ? {
          tokenHash: r.token_hash,
          kind: r.kind,
          owner: r.owner,
          cid: r.cid,
          clientId: r.client_id,
          scopes: r.scopes,
          resource: r.resource,
          expiresAt: r.expires_at.getTime(),
          usedAt: ms(r.used_at),
          provider: r.provider,
          grantRevokedAt: ms(r.revoked_at),
        }
      : null;
  }
  async useRefresh(h: string, at: number) {
    const [r] = await this.sql<{ used_at: Date | null; first: boolean }[]>`
      with prev as (select used_at from chalito_private.oauth_tokens where token_hash = ${h} and kind = 'refresh' for update)
      update chalito_private.oauth_tokens t set used_at = coalesce(t.used_at, ${ts(at)})
      from prev where t.token_hash = ${h}
      returning prev.used_at, prev.used_at is null as first`;
    if (!r) return "missing" as const;
    return r.first ? ("ok" as const) : ("reused" as const);
  }
  async deleteToken(h: string) {
    await this.sql`delete from chalito_private.oauth_tokens where token_hash = ${h}`;
  }

  async recommend(owner: string, aid: string, rec: { from: string; allow: boolean; note: string; at: number }) {
    // One statement: the cap holds under concurrent calls.
    const done = await this.sql`
      update chalito.approvals set recommendations = recommendations || ${this.sql.json([rec] as never)}
      where owner = ${owner} and aid = ${aid} and status = 'pending' and expires_at > now()
        and jsonb_array_length(recommendations) < 20
      returning 1`;
    if (done.length) return "ok" as const;
    const [r] = await this.sql`select 1 from chalito.approvals
      where owner = ${owner} and aid = ${aid} and status = 'pending' and expires_at > now()`;
    return r ? ("full" as const) : ("not_found" as const);
  }
  async insertMesaTurn(owner: string, mid: string, tid: string, doc: Record<string, unknown>) {
    await this.sql.begin(async (tx) => {
      await tx`insert into chalito.mesas (owner, mid, doc) values (${owner}, ${mid}, ${tx.json({ kind: "mcp_inbox" })})
               on conflict (owner, mid) do nothing`;
      await tx`insert into chalito.mesa_turns (owner, mid, tid, doc) values (${owner}, ${mid}, ${tid}, ${tx.json(doc as never)})`;
    });
  }
  async sessionDevice(owner: string, sid: string) {
    const [r] = await this.sql<
      { device_id: string }[]
    >`select device_id from chalito.sessions where owner = ${owner} and sid = ${sid}`;
    return r?.device_id ?? null;
  }
  async insertCommand(owner: string, target: string, id: string, env: unknown, expiresAt: number) {
    const [d] = await this.sql`select 1 from chalito.devices where owner = ${owner} and device_id = ${target}
                               and role = 'agent' and not revoked`;
    if (!d) return "no_device" as const;
    await this.sql`insert into chalito.commands (owner, target_device_id, id, env, from_device_id, expires_at)
                   values (${owner}, ${target}, ${id}, ${this.sql.json(env as never)}, 'mcp-gateway', ${ts(expiresAt)})`;
    return "ok" as const;
  }
  async setSharing(owner: string, scope: "session" | "device", target: string, enabled: boolean, ackAt: number | null) {
    await this.sql`
      insert into chalito.mcp_sharing (owner, scope, target, enabled, plaintext_ack_at, updated_at)
      values (${owner}, ${scope}, ${target}, ${enabled}, ${ackAt === null ? null : ts(ackAt)}, now())
      on conflict (owner, scope, target) do update set enabled = excluded.enabled,
        plaintext_ack_at = coalesce(excluded.plaintext_ack_at, chalito.mcp_sharing.plaintext_ack_at), updated_at = now()`;
  }
}
