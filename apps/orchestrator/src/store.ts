import type { HubUsageEvent } from "@chalito/protocol";
import type { MesaDoc } from "./core/mesa.js";

/** What the orchestrator stores. Postgres (as chalito_server) in production, memory in tests. */
export interface TurnSpend {
  pid: string;
  tokens: number;
  /** Usage events (null = not billable), written to the outbox in the same transaction. */
  events: (HubUsageEvent | null)[];
}

export interface MesaStore {
  createMesa(owner: string, mid: string, doc: MesaDoc): Promise<boolean>;
  getMesa(owner: string, mid: string): Promise<MesaDoc | null>;
  setStatus(owner: string, mid: string, status: MesaDoc["status"]): Promise<void>;
  /** Box keys (b64url) of the owner's active client devices. */
  clientBoxKeys(owner: string): Promise<Record<string, string>>;
  activeClient(owner: string, deviceId: string): Promise<boolean>;
  /**
   * One transaction: the sealed turn, its usage events (outbox) and the Mesa's token counters.
   * "duplicate" when that tid already exists (nothing else is written).
   */
  appendTurn(
    owner: string,
    mid: string,
    tid: string,
    doc: Record<string, unknown>,
    spend?: TurnSpend,
  ): Promise<"ok" | "duplicate">;
}

export class MemoryMesaStore implements MesaStore {
  mesas = new Map<string, MesaDoc>();
  turns = new Map<string, { owner: string; mid: string; tid: string; doc: Record<string, unknown> }>();
  outbox: HubUsageEvent[] = [];
  clients = new Map<string, Record<string, string>>();
  /** Makes the next appendTurn that carries spend throw (the turn and its usage commit together). */
  failNextSpend = false;

  async createMesa(owner: string, mid: string, doc: MesaDoc) {
    if (this.mesas.has(`${owner}/${mid}`)) return false;
    this.mesas.set(`${owner}/${mid}`, structuredClone(doc));
    return true;
  }
  async getMesa(owner: string, mid: string) {
    const d = this.mesas.get(`${owner}/${mid}`);
    return d ? structuredClone(d) : null;
  }
  async setStatus(owner: string, mid: string, status: MesaDoc["status"]) {
    const d = this.mesas.get(`${owner}/${mid}`);
    if (d) d.status = status;
  }
  async clientBoxKeys(owner: string) {
    return this.clients.get(owner) ?? {};
  }
  async activeClient(owner: string, deviceId: string) {
    return deviceId in (this.clients.get(owner) ?? {});
  }
  async appendTurn(owner: string, mid: string, tid: string, doc: Record<string, unknown>, spend?: TurnSpend) {
    if (spend && this.failNextSpend) {
      this.failNextSpend = false;
      throw new Error("append failed");
    }
    const key = `${owner}/${mid}/${tid}`;
    if (this.turns.has(key)) return "duplicate" as const;
    this.turns.set(key, { owner, mid, tid, doc: structuredClone(doc) });
    if (spend) {
      for (const e of spend.events) if (e && !this.outbox.some((x) => x.source_id === e.source_id)) this.outbox.push(e);
      const m = this.mesas.get(`${owner}/${mid}`)!;
      m.used.total += spend.tokens;
      m.used.byParticipant[spend.pid] = (m.used.byParticipant[spend.pid] ?? 0) + spend.tokens;
    }
    return "ok" as const;
  }
}
