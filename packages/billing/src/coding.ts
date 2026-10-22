import type { CodingManagedConfig, PricesConfig } from "@chalito/config";
import type { HubAdmitRequest, HubUsageEvent } from "@chalito/protocol";
import type { z } from "zod";
import { usageEvent } from "./billable.js";
import { hubTierOf, localDayKey, localDayStart } from "./caps.js";
import { llmCostMicros, type TokenUsage } from "./cost.js";
import { HubUnavailable, type HubClient } from "./hub.js";
import { HUB_MARGIN_PERCENT, reserveTokens, type ReserveBasis } from "./reserve-basis.js";
import { estimateBillable } from "./stream-usage.js";

/** Managed coding agents (ADR 0030): one hub stream hold per session credential, topped up per request. */
export type CodingAgent = "codex" | "gemini-cli" | "grok-build";
export type CodingProvider = "openai" | "google" | "xai";
export type CodingBlock = "out_of_energy" | "daily_cap";
export type CodingRevokeReason = "session_end" | "reissued" | "kill_switch" | "device_revoked" | "expired" | "owner";

export const CODING_PROVIDER: Record<CodingAgent, CodingProvider> = {
  codex: "openai",
  "gemini-cli": "google",
  "grok-build": "xai",
};
/** The owner's day when users.tz is unset (the product's home market). */
export const DEFAULT_TZ = "America/Mexico_City";

/** How long a hold stays open after its session ended, for requests still streaming and unsent usage. */
export const SETTLE_CUTOFF_MS = 20 * 60_000;

export const codingHoldJobId = (credentialId: string, gen: number) => `coding:${credentialId}:${gen}`;
/** Each request's usage event; `r` keeps it apart from the hold's job ids. */
export const codingSourceId = (credentialId: string, seq: number) => `coding:${credentialId}:r${seq}`;

export interface CodingCredential {
  id: string;
  owner: string;
  deviceId: string;
  sid: string;
  agent: CodingAgent;
  provider: CodingProvider;
  models: string[];
  holdGen: number;
  reservationId: string | null;
  inflightMicros: number;
  inflightRequests: number;
  /** Usage on the current hold generation (the hub subtracts it from the hold). */
  genSpentMicros: number;
  lastUsedAt: number;
  requests: number;
  blockedReason: CodingBlock | null;
  expiresAt: number;
  revokedAt: number | null;
  settledAt: number | null;
}

/** The cap's zone (coding_settings): frozen at first use; a new zone takes over at `from`. */
export interface CapZone {
  tz: string | null;
  next: string | null;
  from: number | null;
}

/** What the meter reads about the owner, under the owner's lock (begins are serialized per owner). */
export interface CodingOwnerState {
  tier: string | null;
  capZone: CapZone;
  /** coding_settings.daily_cap_tokens, or null when never set. */
  capTokens: number | null;
  deviceRevoked: boolean;
  /** Worst cases of every request in flight on the owner's sessions, this one's included. */
  inflightMicros: number;
}

/** The zone the cap's day follows at `now`. Never users.tz directly: changing it mid-day mustn't reset the cap. */
export const capTz = (z: CapZone, now: number): string =>
  (z.next && z.from !== null && now >= z.from ? z.next : z.tz) ?? DEFAULT_TZ;

/** The next local midnight in `tz` (23- and 25-hour days included). */
const nextMidnight = (now: number, tz: string) => localDayStart(localDayStart(now, tz) + 36 * 3_600_000, tz);

/** At issue: freezes the zone on first use, or schedules the owner's new zone for when the current day ends. */
export const planCapZone = (z: CapZone, userTz: string | null, now: number): CapZone => {
  const current = capTz(z, now);
  const frozen = z.tz === null ? (userTz ?? DEFAULT_TZ) : current;
  const want = userTz ?? frozen;
  if (want === frozen) return { tz: frozen, next: null, from: null };
  const pending = z.next === want && z.from !== null && now < z.from;
  return { tz: frozen, next: want, from: pending ? z.from : nextMidnight(now, frozen) };
};

export type CodingPatch = Partial<
  Pick<
    CodingCredential,
    | "holdGen"
    | "reservationId"
    | "inflightMicros"
    | "inflightRequests"
    | "genSpentMicros"
    | "lastUsedAt"
    | "requests"
    | "blockedReason"
    | "settledAt"
  >
> & { revoked?: { at: number; reason: CodingRevokeReason } };

/** One request's usage, written with the credential's counters in the same transaction. */
export interface CodingRecord {
  event: HubUsageEvent;
  day: string;
  agent: CodingAgent;
  costMicros: number;
  billableTokens: number;
}

/** Everything the meter does to one credential happens inside `withCredential`, under its row lock. */
export interface CodingTx {
  credential(): CodingCredential;
  /** `lock`: serialize with the owner's other begins (only begin needs it; it holds it across the hub call). */
  owner(lock?: boolean): Promise<CodingOwnerState>;
  /** Billable tokens already spent on the owner's local `day`, all agents. */
  spentOn(day: string): Promise<number>;
  /** This credential's usage still pending in the outbox: spent, but not yet seen by the hub. */
  unsentMicros(): Promise<number>;
  update(patch: CodingPatch): Promise<void>;
  /** False when the event was already recorded (a retried finish): nothing is added twice. */
  record(r: CodingRecord): Promise<boolean>;
  /** Marks request `seq` finished; false when it already was (a retry after a lost commit ack). */
  markFinished(seq: number): Promise<boolean>;
}

export interface CodingStore {
  byTokenHash(hash: string): Promise<CodingCredential | null>;
  /** Null when there's no such credential. */
  withCredential<T>(id: string, fn: (tx: CodingTx) => Promise<T>): Promise<T | null>;
  /** Credentials whose hold is still open although revoked or expired at `now`. */
  unsettled(now: number, limit: number): Promise<string[]>;
}

export type CodingRefusal =
  | "revoked"
  | "expired"
  | "device_revoked"
  | "not_eligible"
  | "model_not_allowed"
  | CodingBlock
  | "busy"
  | "hub_unavailable";

export interface CodingTicket {
  credentialId: string;
  owner: string;
  agent: CodingAgent;
  provider: CodingProvider;
  model: string;
  seq: number;
  worstMicros: number;
  reservationId: string;
  holdGen: number;
  inputBound: number;
  /** The clamped output limit: the fallback's output when the provider never reports usage. */
  maxOutput: number;
}

export interface CodingRequest {
  model: string;
  /** The request body's size: a token is at least one byte, so input tokens can't exceed it. */
  inputBytes: number;
  /** The model's input window (providers.yaml maxInputTokens). */
  maxInputTokens: number;
  /** The output limit after the gateway clamped it. */
  maxOutputTokens: number;
}

/** Kept for the log: what streamed. A request without provider usage is billed at its worst case. */
export interface CodingFallback {
  outputBytes: number;
}

type Hub = Pick<HubClient, "admit" | "settle">;

/** The hold's admit request. The api's initial hold and the gateway's top-ups use the same shape. */
export const codingHoldRequest = (
  c: Pick<CodingCredential, "id" | "owner">,
  gen: number,
  estTokens: number,
  ttlSeconds: number,
): z.input<typeof HubAdmitRequest> => ({
  external_user_id: c.owner,
  external_job_id: codingHoldJobId(c.id, gen),
  class: "stream",
  operation: "coding.session",
  est_tokens: estTokens,
  ttl_seconds: ttlSeconds,
});

/** Provider cost of the worst case of one request; throws for an unpriced model (fail closed). */
export const codingWorstCaseMicros = (prices: PricesConfig, provider: CodingProvider, r: CodingRequest) =>
  llmCostMicros(prices, provider, r.model, {
    input: Math.min(Math.max(0, r.inputBytes), r.maxInputTokens),
    output: Math.max(0, r.maxOutputTokens),
  });

/** The day's cap for an owner: their own, never above their tier's ceiling; the default when unset. */
export const codingDailyCap = (cfg: CodingManagedConfig, tier: string | null, own: number | null): number => {
  const t = hubTierOf(tier);
  const ceiling = t === "pro" || t === "vip" ? (cfg.dailyCap.ceiling[t] ?? 0) : 0;
  return Math.min(own ?? cfg.dailyCap.default, ceiling);
};

export class CodingMeter {
  constructor(
    private readonly d: {
      store: CodingStore;
      hub: Hub;
      prices: PricesConfig;
      cfg: CodingManagedConfig;
      reserveBasis: ReserveBasis;
      now: () => number;
      log?: (msg: string, meta: Record<string, unknown>) => void;
    },
  ) {}
  /** Settles that threw, by credential: retried after this instant. */
  readonly #backoff = new Map<string, number>();
  /** Tickets already finished here (a refused call bills nothing, so the outbox can't dedupe it). */
  readonly #finished = new WeakSet<CodingTicket>();

  #eligible(tier: string | null) {
    const t = hubTierOf(tier);
    return t !== null && (this.d.cfg.tiers as string[]).includes(t);
  }

  /** Refuses the request, or tops the hold up to unsent usage + requests in flight + this worst case.
   *  The credential stays locked until the hub has answered, so two requests never race the hold. */
  async begin(
    credentialId: string,
    req: CodingRequest,
  ): Promise<{ ok: true; ticket: CodingTicket } | { ok: false; reason: CodingRefusal }> {
    const now = this.d.now();
    const res = await this.d.store.withCredential(credentialId, async (tx) => {
      const c = tx.credential();
      if (c.revokedAt !== null) return { ok: false as const, reason: "revoked" as const };
      if (c.expiresAt <= now || now - c.lastUsedAt > this.d.cfg.credentialIdleSeconds * 1000)
        return { ok: false as const, reason: "expired" as const };
      if (!c.models.includes(req.model)) return { ok: false as const, reason: "model_not_allowed" as const };
      const o = await tx.owner(true);
      if (o.deviceRevoked) {
        await tx.update({ revoked: { at: now, reason: "device_revoked" } });
        return { ok: false as const, reason: "device_revoked" as const };
      }
      if (!this.#eligible(o.tier)) return { ok: false as const, reason: "not_eligible" as const };
      if (c.inflightRequests >= this.d.cfg.maxInflightPerSession)
        return { ok: false as const, reason: "busy" as const };
      const block = async (reason: CodingBlock) => {
        if (c.blockedReason !== reason) await tx.update({ blockedReason: reason });
        return { ok: false as const, reason };
      };
      const worst = codingWorstCaseMicros(this.d.prices, c.provider, req);
      // Everything in flight on the owner's sessions counts, so parallel requests can't overshoot the cap.
      const day = localDayKey(now, capTz(o.capZone, now));
      const committed = (await tx.spentOn(day)) + estimateBillable(o.inflightMicros + worst, HUB_MARGIN_PERCENT);
      if (committed > codingDailyCap(this.d.cfg, o.tier, o.capTokens)) return block("daily_cap");

      // The hub holds est − usage reported on the hold, so all of this generation's usage counts here.
      let genSpent = c.genSpentMicros;
      let est = reserveTokens(genSpent + c.inflightMicros + worst, this.d.reserveBasis);
      let gen = c.holdGen;
      let admit;
      try {
        admit = await this.d.hub.admit(codingHoldRequest(c, gen, est, this.d.cfg.holdTtlSeconds));
        // The hold lapsed (ttl) or was settled: a new one, under the next job id.
        if (!admit.allowed && admit.reason === "already_settled") {
          gen += 1;
          genSpent = 0;
          est = reserveTokens(c.inflightMicros + worst, this.d.reserveBasis);
          admit = await this.d.hub.admit(codingHoldRequest(c, gen, est, this.d.cfg.holdTtlSeconds));
        }
      } catch (err) {
        if (err instanceof HubUnavailable) return { ok: false as const, reason: "hub_unavailable" as const };
        throw err;
      }
      if (!admit.allowed)
        return admit.reason === "no_tokens" ? block("out_of_energy") : { ok: false as const, reason: "busy" as const };
      const seq = c.requests + 1;
      await tx.update({
        holdGen: gen,
        genSpentMicros: genSpent,
        lastUsedAt: now,
        reservationId: admit.reservation_id,
        inflightMicros: c.inflightMicros + worst,
        inflightRequests: c.inflightRequests + 1,
        requests: seq,
        blockedReason: null,
      });
      const ticket: CodingTicket = {
        credentialId: c.id,
        owner: c.owner,
        agent: c.agent,
        provider: c.provider,
        model: req.model,
        seq,
        worstMicros: worst,
        reservationId: admit.reservation_id,
        holdGen: gen,
        inputBound: Math.min(Math.max(0, req.inputBytes), req.maxInputTokens),
        maxOutput: Math.max(0, req.maxOutputTokens),
      };
      return { ok: true as const, ticket };
    });
    return res ?? { ok: false, reason: "revoked" };
  }

  /** After a request, whatever happened to it: one outbox event, the day's spend and the counters, in one
   *  transaction. Idempotent per ticket (the event's source_id). */
  async finish(t: CodingTicket, usage: TokenUsage | null, fallback: CodingFallback): Promise<{ costMicros: number }> {
    const now = this.d.now();
    if (this.#finished.has(t)) return { costMicros: 0 };
    void fallback;
    const u: TokenUsage = usage ?? { input: t.inputBound, output: t.maxOutput };
    const costMicros = llmCostMicros(this.d.prices, t.provider, t.model, u);
    const tokens = {
      input: u.input,
      output: u.output,
      cache_read: u.cacheRead ?? 0,
      cache_write: u.cacheWrite ?? 0,
    };
    const amount = tokens.input + tokens.output + tokens.cache_read + tokens.cache_write;
    const event = usageEvent(
      { owner: t.owner, billingMode: "managed", origin: "session.managed" },
      {
        kind: "llm.tokens",
        provider: t.provider,
        amount,
        costUsdMicros: costMicros,
        occurredAt: now,
        sourceId: codingSourceId(t.credentialId, t.seq),
        reservationId: t.reservationId,
        metadata: { model: t.model, tokens, agent: t.agent, ...(usage ? {} : { estimated: true }) },
      },
    );
    await this.d.store.withCredential(t.credentialId, async (tx) => {
      // Durable: a retry after a lost commit ack (another instance, a replay) finds the marker and changes nothing.
      if (!(await tx.markFinished(t.seq))) return;
      const c = tx.credential();
      const o = await tx.owner(false);
      if (event && amount > 0)
        await tx.record({
          event,
          day: localDayKey(now, capTz(o.capZone, now)),
          agent: t.agent,
          costMicros,
          billableTokens: estimateBillable(costMicros, HUB_MARGIN_PERCENT),
        });
      await tx.update({
        inflightMicros: Math.max(0, c.inflightMicros - t.worstMicros),
        inflightRequests: Math.max(0, c.inflightRequests - 1),
        ...(c.holdGen === t.holdGen ? { genSpentMicros: c.genSpentMicros + costMicros } : {}),
      });
    });
    this.#finished.add(t);
    return { costMicros };
  }

  /** Closes the hold of a revoked or expired credential (settling twice is a no-op at the hub). */
  async settle(credentialId: string): Promise<"settled" | "open" | "none"> {
    const now = this.d.now();
    const r = await this.d.store.withCredential(credentialId, async (tx) => {
      const c = tx.credential();
      if (c.settledAt !== null) return "none" as const;
      if (c.revokedAt === null && c.expiresAt > now) return "open" as const;
      if (c.revokedAt === null) await tx.update({ revoked: { at: now, reason: "expired" } });
      // The hold covers requests still streaming and usage the hub hasn't seen, up to a cutoff after the end.
      const ended = c.revokedAt ?? c.expiresAt;
      const busy = c.inflightRequests > 0 || (await tx.unsentMicros()) > 0;
      if (busy && now - ended < SETTLE_CUTOFF_MS) return "open" as const;
      if (c.reservationId) {
        const s = await this.d.hub.settle({ reservation_id: c.reservationId, outcome: "succeeded" });
        // 404: the hub no longer has the hold (purged or expired long ago); nothing left to close.
        if (!s.ok && !s.closed && s.httpStatus !== 404) {
          this.d.log?.("coding.settle_failed", { credential: c.id, httpStatus: s.httpStatus });
          return "open" as const;
        }
      }
      // Past the cutoff, requests that never finished (a crashed gateway) are billed at their worst case, once.
      if (c.inflightMicros > 0) {
        const o = await tx.owner(false);
        const orphan = usageEvent(
          { owner: c.owner, billingMode: "managed", origin: "session.managed" },
          {
            kind: "llm.tokens",
            provider: c.provider,
            amount: 0,
            costUsdMicros: c.inflightMicros,
            occurredAt: now,
            sourceId: `coding:${c.id}:orphan:${c.holdGen}`,
            ...(c.reservationId ? { reservationId: c.reservationId } : {}),
            metadata: { agent: c.agent, estimated: true, orphan: true, requests: c.inflightRequests },
          },
        );
        if (orphan)
          await tx.record({
            event: orphan,
            day: localDayKey(now, capTz(o.capZone, now)),
            agent: c.agent,
            costMicros: c.inflightMicros,
            billableTokens: estimateBillable(c.inflightMicros, HUB_MARGIN_PERCENT),
          });
      }
      await tx.update({ settledAt: now, inflightMicros: 0, inflightRequests: 0 });
      if (busy) this.d.log?.("coding.settled_with_inflight", { credential: c.id, inflight: c.inflightRequests });
      return "settled" as const;
    });
    return r ?? "none";
  }

  /** Every minute: settles the holds of revoked and expired credentials; a failing one waits a few runs. */
  async sweep(limit = 200): Promise<number> {
    let n = 0;
    const now = this.d.now();
    for (const id of await this.d.store.unsettled(now, limit + this.#backoff.size)) {
      if ((this.#backoff.get(id) ?? 0) > now) continue;
      const r = await this.settle(id).catch((err: unknown) => {
        this.d.log?.("coding.settle_error", { credential: id, error: err instanceof Error ? err.message : "error" });
        return "error" as const;
      });
      if (r === "settled") {
        n += 1;
        this.#backoff.delete(id);
      } else if (r === "error") this.#backoff.set(id, now + 5 * 60_000);
    }
    return n;
  }
}
