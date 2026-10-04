import type { HubUsageEvent, SealedEnvelope } from "@chalito/protocol";
import type { BrainProviderId } from "./brains/brain.js";
import type { MesaDoc } from "./core/mesa.js";
import type { DecisionStore, PendingDecision } from "./decisions.js";

/** What the orchestrator stores. Postgres (as chalito_server) in production, memory in tests. */
export interface TurnSpend {
  pid: string;
  tokens: number;
  /** Usage events (null = not billable: BYO), written to the outbox in the same transaction. */
  events: (HubUsageEvent | null)[];
}

/**
 * A `kind=decision` approval raised by a Mesa participant. The orchestrator CREATES it (pending,
 * details sealed to the person's clients); the person answers with a signed Decision, and it
 * resolves only through DecisionStore.resolveDecision after the signature is verified.
 */
export interface DecisionApproval {
  aid: string;
  mid: string;
  tid: string;
  /** The client device whose turn led to it: the approval's origin `client:<id>`. */
  origin: string;
  detailsCt: SealedEnvelope;
}

/** A BYO provider key: sealed to the person's devices; `cloud` = a KMS-wrapped copy exists. */
export interface BrainKeyRow {
  provider: BrainProviderId;
  sealedCt: SealedEnvelope;
  /** Last 4 characters, for display. */
  hint: string;
  cloud: boolean;
}

/** One aggregate row for the usage page. */
export interface UsageRow {
  day: string;
  billing: "managed" | "byo";
  purpose: "work" | "comms";
  tokens: number;
  costUsdMicros: number;
}

export interface MesaStore extends DecisionStore {
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
  createDecisionApproval(owner: string, a: DecisionApproval): Promise<void>;
  /** Usage events on their own (when the turn write failed after a paid call); idempotent on source_id. */
  enqueueUsage(owner: string, events: (HubUsageEvent | null)[]): Promise<void>;

  putBrainKey(owner: string, row: BrainKeyRow, wrapped: string | null): Promise<void>;
  deleteBrainKey(owner: string, provider: BrainProviderId): Promise<boolean>;
  /** The KMS-wrapped copy, only if the person opted in to cloud turns for that provider. */
  wrappedBrainKey(owner: string, provider: BrainProviderId): Promise<string | null>;

  usageDaily(owner: string, sinceMs: number): Promise<UsageRow[]>;
}

export class MemoryMesaStore implements MesaStore {
  mesas = new Map<string, MesaDoc>();
  turns = new Map<string, { owner: string; mid: string; tid: string; doc: Record<string, unknown> }>();
  outbox: HubUsageEvent[] = [];
  clients = new Map<string, Record<string, string>>();
  approvals: (DecisionApproval & {
    owner: string;
    status: "pending" | "approved" | "denied";
    reason?: string;
    expiresAt: number;
  })[] = [];
  /** approval_decisions rows: what clients inserted (signed or not), each attempt its own row. */
  decisions: { owner: string; aid: string; signer: string; decision: unknown; id?: string }[] = [];
  /** A row's id (tests may push rows without one: their position stands in). */
  #idOf = (x: (typeof this.decisions)[number]) => x.id ?? `row_${this.decisions.indexOf(x)}`;
  /** Client devices' pub_sign (b64url), and which are revoked. */
  signKeys = new Map<string, string>();
  revoked = new Set<string>();
  now = () => Date.now();
  brainKeys = new Map<string, BrainKeyRow>();
  wrapped = new Map<string, string>();
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
  async enqueueUsage(_owner: string, events: (HubUsageEvent | null)[]) {
    for (const e of events) if (e && !this.outbox.some((x) => x.source_id === e.source_id)) this.outbox.push(e);
  }
  async createDecisionApproval(owner: string, a: DecisionApproval) {
    this.approvals.push({ ...structuredClone(a), owner, status: "pending", expiresAt: this.now() + 10 * 60_000 });
  }
  async pendingDecisions(filter: { owner?: string; aid?: string }): Promise<PendingDecision[]> {
    return this.approvals
      .filter(
        (a) =>
          a.status === "pending" &&
          a.expiresAt > this.now() &&
          (!filter.owner || a.owner === filter.owner) &&
          (!filter.aid || a.aid === filter.aid),
      )
      .map((a) => ({
        owner: a.owner,
        aid: a.aid,
        requestId: a.tid,
        answers: this.decisions
          .filter((x) => x.owner === a.owner && x.aid === a.aid)
          .map((x) => ({ id: this.#idOf(x), signer: x.signer, decision: x.decision })),
      }))
      .filter((p) => p.answers.length > 0);
  }
  async signerKey(owner: string, deviceId: string) {
    const k = `${owner}/${deviceId}`;
    return this.revoked.has(k) ? null : (this.signKeys.get(k) ?? null);
  }
  async nonceUsedElsewhere(owner: string, aid: string, nonce: string) {
    return this.decisions.some(
      (x) =>
        x.owner === owner && x.aid !== aid && (x.decision as { body?: { nonce?: unknown } })?.body?.nonce === nonce,
    );
  }
  /** Mirrors the SQL function's re-checks (minus the signature, which the caller verified). */
  async resolveDecision(owner: string, aid: string, signer: string, id: string) {
    const a = this.approvals.find((x) => x.owner === owner && x.aid === aid);
    const row = this.decisions.find(
      (x) => x.owner === owner && x.aid === aid && x.signer === signer && this.#idOf(x) === id,
    );
    const body = (row?.decision as { body?: { allow?: unknown; requestId?: unknown } })?.body;
    if (!a || a.status !== "pending" || a.expiresAt <= this.now() || !row || this.revoked.has(`${owner}/${signer}`))
      return null;
    if (typeof body?.allow !== "boolean" || body.requestId !== a.tid) return null;
    a.status = body.allow ? "approved" : "denied";
    a.reason = `signed:${signer}`;
    return a.status;
  }
  async putBrainKey(owner: string, row: BrainKeyRow, wrapped: string | null) {
    this.brainKeys.set(`${owner}/${row.provider}`, structuredClone(row));
    if (wrapped) this.wrapped.set(`${owner}/${row.provider}`, wrapped);
    else this.wrapped.delete(`${owner}/${row.provider}`);
  }
  async deleteBrainKey(owner: string, provider: BrainProviderId) {
    this.wrapped.delete(`${owner}/${provider}`);
    return this.brainKeys.delete(`${owner}/${provider}`);
  }
  async wrappedBrainKey(owner: string, provider: BrainProviderId) {
    return this.wrapped.get(`${owner}/${provider}`) ?? null;
  }
  async usageDaily(owner: string, sinceMs: number) {
    const rows = new Map<string, UsageRow>();
    const add = (r: UsageRow) => {
      const k = `${r.day}/${r.billing}/${r.purpose}`;
      const cur = rows.get(k) ?? { ...r, tokens: 0, costUsdMicros: 0 };
      cur.tokens += r.tokens;
      cur.costUsdMicros += r.costUsdMicros;
      rows.set(k, cur);
    };
    for (const e of this.outbox) {
      const t = Date.parse(e.occurred_at);
      if (e.external_user_id !== owner || t < sinceMs) continue;
      add({
        day: e.occurred_at.slice(0, 10),
        billing: "managed",
        purpose: e.metadata?.purpose === "work" ? "work" : "comms",
        tokens: e.kind === "llm.tokens" ? e.amount : 0,
        costUsdMicros: e.cost_usd_micros,
      });
    }
    for (const { owner: o, doc } of this.turns.values()) {
      if (o !== owner || doc.billingMode !== "byo" || (doc.t as number) < sinceMs) continue;
      const u = doc.usage as { in: number; out: number; cached: number };
      add({
        day: new Date(doc.t as number).toISOString().slice(0, 10),
        billing: "byo",
        purpose: "work",
        tokens: u.in + u.out + u.cached,
        costUsdMicros: (doc.estCostUsdMicros as number) ?? 0,
      });
    }
    return [...rows.values()];
  }
}
