import type { Sql } from "postgres";
import { enqueueUsage } from "@chalito/billing";
import type { HubUsageEvent } from "@chalito/protocol";
import { MesaDoc } from "./core/mesa.js";
import type { BrainProviderId } from "./brains/brain.js";
import type { PendingDecision } from "./decisions.js";
import type { BrainKeyRow, DecisionApproval, MesaStore, TurnSpend, UsageRow } from "./store.js";

/** MesaStore on Postgres as chalito_server (migrations 001800/001900, usage outbox 001500). */
export class PostgresMesaStore implements MesaStore {
  constructor(private readonly sql: Sql) {}

  async createMesa(owner: string, mid: string, doc: MesaDoc) {
    const r = await this
      .sql`insert into chalito.mesas (owner, mid, doc) values (${owner}, ${mid}, ${this.sql.json(doc as never)})
                             on conflict (owner, mid) do nothing returning 1`;
    return r.length === 1;
  }
  async getMesa(owner: string, mid: string) {
    const [r] = await this.sql<
      { doc: unknown }[]
    >`select doc from chalito.mesas where owner = ${owner} and mid = ${mid}`;
    if (!r) return null;
    const parsed = MesaDoc.safeParse(r.doc);
    return parsed.success ? parsed.data : null; // e.g. the gateway's MCP inbox isn't a Mesa
  }
  async setStatus(owner: string, mid: string, status: MesaDoc["status"]) {
    await this.sql`update chalito.mesas set doc = jsonb_set(doc, '{status}', ${this.sql.json(status)})
                   where owner = ${owner} and mid = ${mid}`;
  }
  async clientBoxKeys(owner: string) {
    const rows = await this.sql<{ device_id: string; pub_box: string }[]>`
      select device_id, pub_box from chalito.devices where owner = ${owner} and role = 'client' and not revoked`;
    return Object.fromEntries(rows.map((r) => [r.device_id, r.pub_box]));
  }
  async activeClient(owner: string, deviceId: string) {
    const r = await this.sql`select 1 from chalito.devices
      where owner = ${owner} and device_id = ${deviceId} and role = 'client' and not revoked`;
    return r.length === 1;
  }
  async appendTurn(owner: string, mid: string, tid: string, doc: Record<string, unknown>, spend?: TurnSpend) {
    return this.sql.begin(async (tx) => {
      const ins = await tx`insert into chalito.mesa_turns (owner, mid, tid, doc)
                           values (${owner}, ${mid}, ${tid}, ${tx.json(doc as never)})
                           on conflict (owner, mid, tid) do nothing returning 1`;
      if (ins.length === 0) return "duplicate" as const;
      if (spend) {
        await enqueueUsage(tx, owner, spend.events);
        await tx`update chalito.mesas set doc = jsonb_set(jsonb_set(doc,
                   '{used,total}', to_jsonb(coalesce((doc #>> '{used,total}')::bigint, 0) + ${spend.tokens})),
                   array['used', 'byParticipant', ${spend.pid}::text],
                   to_jsonb(coalesce((doc #>> array['used', 'byParticipant', ${spend.pid}::text])::bigint, 0) + ${spend.tokens}))
                 where owner = ${owner} and mid = ${mid}`;
      }
      return "ok" as const;
    }) as Promise<"ok" | "duplicate">;
  }

  async enqueueUsage(owner: string, events: (HubUsageEvent | null)[]) {
    await enqueueUsage(this.sql, owner, events);
  }
  async createDecisionApproval(owner: string, a: DecisionApproval) {
    // created_at and the 10-minute expiry are the database's clock.
    await this.sql`
      insert into chalito.approvals (owner, aid, device_id, sid, request_id, kind, risk, origin, step_up_required,
                                     details_ct, expires_at)
      values (${owner}, ${a.aid}, 'orchestrator', ${a.mid}, ${a.tid}, 'decision', 'MED', ${a.origin}, false,
              ${this.sql.json(a.detailsCt as never)}, now() + interval '10 minutes')`;
  }

  async putBrainKey(owner: string, row: BrainKeyRow, wrapped: string | null) {
    await this.sql.begin(async (tx) => {
      await tx`
        insert into chalito.brain_keys (owner, provider, sealed_ct, hint, cloud, updated_at)
        values (${owner}, ${row.provider}, ${tx.json(row.sealedCt as never)}, ${row.hint}, ${wrapped !== null}, now())
        on conflict (owner, provider) do update set sealed_ct = excluded.sealed_ct, hint = excluded.hint,
          cloud = excluded.cloud, updated_at = now()`;
      if (wrapped !== null)
        await tx`
          insert into chalito_private.brain_key_wrapped (owner, provider, wrapped) values (${owner}, ${row.provider}, ${wrapped})
          on conflict (owner, provider) do update set wrapped = excluded.wrapped, created_at = now()`;
    });
  }
  async deleteBrainKey(owner: string, provider: BrainProviderId) {
    const r = await this
      .sql`delete from chalito.brain_keys where owner = ${owner} and provider = ${provider} returning 1`;
    return r.length === 1;
  }
  async wrappedBrainKey(owner: string, provider: BrainProviderId) {
    const [r] = await this.sql<{ wrapped: string }[]>`
      select w.wrapped from chalito_private.brain_key_wrapped w
      join chalito.brain_keys k using (owner, provider)
      where w.owner = ${owner} and w.provider = ${provider} and k.cloud`;
    return r?.wrapped ?? null;
  }

  async usageDaily(owner: string, sinceMs: number): Promise<UsageRow[]> {
    const since = new Date(sinceMs);
    const rows = await this.sql<
      { day: string; billing: "managed" | "byo"; purpose: "work" | "comms"; tokens: string; cost: string }[]
    >`
      select to_char((event ->> 'occurred_at')::timestamptz at time zone 'UTC', 'YYYY-MM-DD') as day,
             'managed' as billing,
             case when event #>> '{metadata,purpose}' = 'work' then 'work' else 'comms' end as purpose,
             sum(case when event ->> 'kind' = 'llm.tokens' then (event ->> 'amount')::bigint else 0 end) as tokens,
             sum((event ->> 'cost_usd_micros')::bigint) as cost
      from chalito_private.usage_outbox
      where owner = ${owner} and (event ->> 'occurred_at')::timestamptz >= ${since}
      group by 1, 3
      union all
      select to_char(to_timestamp((doc ->> 't')::bigint / 1000.0) at time zone 'UTC', 'YYYY-MM-DD'), 'byo', 'work',
             sum((doc #>> '{usage,in}')::bigint + (doc #>> '{usage,out}')::bigint + (doc #>> '{usage,cached}')::bigint),
             sum(coalesce((doc ->> 'estCostUsdMicros')::bigint, 0))
      from chalito.mesa_turns
      where owner = ${owner} and doc ->> 'billingMode' = 'byo' and (doc ->> 't')::bigint >= ${sinceMs}
      group by 1`;
    return rows.map((r) => ({
      day: r.day,
      billing: r.billing,
      purpose: r.purpose,
      tokens: Number(r.tokens),
      costUsdMicros: Number(r.cost),
    }));
  }

  // ---- signed answers to Mesa decisions (verified by the caller before resolveDecision)
  async pendingDecisions(filter: { owner?: string; aid?: string }): Promise<PendingDecision[]> {
    const rows = await this.sql<
      { owner: string; aid: string; request_id: string; id: string; signer: string; decision: unknown }[]
    >`
      select a.owner, a.aid, a.request_id, d.id, d.signer_device_id as signer, d.decision
      from chalito.approvals a
      join chalito.approval_decisions d on d.owner = a.owner and d.aid = a.aid
      where a.kind = 'decision' and a.device_id = 'orchestrator' and a.status = 'pending' and a.expires_at > now()
        and (${filter.owner ?? null}::text is null or a.owner = ${filter.owner ?? null})
        and (${filter.aid ?? null}::text is null or a.aid = ${filter.aid ?? null})
      order by a.owner, a.aid, d.rev
      limit 500`;
    const out = new Map<string, PendingDecision>();
    for (const r of rows) {
      const k = `${r.owner}/${r.aid}`;
      if (!out.has(k)) out.set(k, { owner: r.owner, aid: r.aid, requestId: r.request_id, answers: [] });
      out.get(k)!.answers.push({ id: String(r.id), signer: r.signer, decision: r.decision });
    }
    return [...out.values()];
  }
  async signerKey(owner: string, deviceId: string) {
    const [r] = await this.sql<{ pub_sign: string }[]>`
      select pub_sign from chalito.devices
      where owner = ${owner} and device_id = ${deviceId} and role = 'client' and not revoked`;
    return r?.pub_sign ?? null;
  }
  async nonceUsedElsewhere(owner: string, aid: string, nonce: string) {
    const r = await this.sql`select 1 from chalito.approval_decisions
      where owner = ${owner} and aid <> ${aid} and decision #>> '{body,nonce}' = ${nonce} limit 1`;
    return r.length > 0;
  }
  async resolveDecision(owner: string, aid: string, signer: string, id: string) {
    const [r] = await this.sql<{ s: "approved" | "denied" | null }[]>`
      select chalito_private.resolve_orchestrator_decision(${owner}, ${aid}, ${signer}, ${id}::uuid) as s`;
    return r?.s ?? null;
  }
}
