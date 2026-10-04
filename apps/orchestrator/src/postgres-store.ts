import type { Sql } from "postgres";
import { enqueueUsage } from "@chalito/billing";
import { MesaDoc } from "./core/mesa.js";
import type { MesaStore, TurnSpend } from "./store.js";

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
}
