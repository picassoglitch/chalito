import type { CodingManagedConfig, PricesConfig } from "@chalito/config";
import type { HubAdmitRequest, HubUsageEvent } from "@chalito/protocol";
import type { z } from "zod";
import { usageEvent } from "./billable.js";
import { hubTierOf, localDayKey } from "./caps.js";
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
  requests: number;
  blockedReason: CodingBlock | null;
  expiresAt: number;
  revokedAt: number | null;
  settledAt: number | null;
}

/** What the meter reads about the owner, under the credential's lock. */
export interface CodingOwnerState {
  tier: string | null;
  tz: string | null;
  /** coding_settings.daily_cap_tokens, or null when never set. */
  capTokens: number | null;
  deviceRevoked: boolean;
}

export type CodingPatch = Partial<
  Pick<CodingCredential, "holdGen" | "reservationId" | "inflightMicros" | "requests" | "blockedReason" | "settledAt">
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
  owner(): Promise<CodingOwnerState>;
  /** Billable tokens already spent on the owner's local `day`, all agents. */
  spentOn(day: string): Promise<number>;
  /** This credential's usage still pending in the outbox: spent, but not yet seen by the hub. */
  unsentMicros(): Promise<number>;
  update(patch: CodingPatch): Promise<void>;
  /** False when the event was already recorded (a retried finish): nothing is added twice. */
  record(r: CodingRecord): Promise<boolean>;
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
  inputBound: number;
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

/** What a request without provider usage is billed at: its worst-case input, its streamed output bytes. */
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
    },
  ) {}

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
      if (c.expiresAt <= now) return { ok: false as const, reason: "expired" as const };
      if (!c.models.includes(req.model)) return { ok: false as const, reason: "model_not_allowed" as const };
      const o = await tx.owner();
      if (o.deviceRevoked) {
        await tx.update({ revoked: { at: now, reason: "device_revoked" } });
        return { ok: false as const, reason: "device_revoked" as const };
      }
      if (!this.#eligible(o.tier)) return { ok: false as const, reason: "not_eligible" as const };
      const block = async (reason: CodingBlock) => {
        if (c.blockedReason !== reason) await tx.update({ blockedReason: reason });
        return { ok: false as const, reason };
      };
      const day = localDayKey(now, o.tz ?? DEFAULT_TZ);
      if ((await tx.spentOn(day)) >= codingDailyCap(this.d.cfg, o.tier, o.capTokens)) return block("daily_cap");

      const worst = codingWorstCaseMicros(this.d.prices, c.provider, req);
      const est = reserveTokens((await tx.unsentMicros()) + c.inflightMicros + worst, this.d.reserveBasis);
      let gen = c.holdGen;
      let admit;
      try {
        admit = await this.d.hub.admit(codingHoldRequest(c, gen, est, this.d.cfg.holdTtlSeconds));
        // The hold lapsed (ttl) or was settled: a new one, under the next job id.
        if (!admit.allowed && admit.reason === "already_settled") {
          gen += 1;
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
        reservationId: admit.reservation_id,
        inflightMicros: c.inflightMicros + worst,
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
        inputBound: Math.min(Math.max(0, req.inputBytes), req.maxInputTokens),
      };
      return { ok: true as const, ticket };
    });
    return res ?? { ok: false, reason: "revoked" };
  }

  /** After a request, whatever happened to it: one outbox event, the day's spend and the counters, in one
   *  transaction. Idempotent per ticket (the event's source_id). */
  async finish(t: CodingTicket, usage: TokenUsage | null, fallback: CodingFallback): Promise<{ costMicros: number }> {
    const now = this.d.now();
    const u: TokenUsage = usage ?? { input: t.inputBound, output: Math.max(0, Math.ceil(fallback.outputBytes)) };
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
      const c = tx.credential();
      const o = await tx.owner();
      const fresh =
        !event ||
        amount === 0 ||
        (await tx.record({
          event,
          day: localDayKey(now, o.tz ?? DEFAULT_TZ),
          agent: t.agent,
          costMicros,
          billableTokens: estimateBillable(costMicros, HUB_MARGIN_PERCENT),
        }));
      if (fresh) await tx.update({ inflightMicros: Math.max(0, c.inflightMicros - t.worstMicros) });
    });
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
      if (c.reservationId) {
        const s = await this.d.hub.settle({ reservation_id: c.reservationId, outcome: "succeeded" });
        if (!s.ok && !s.closed) return "open" as const;
      }
      await tx.update({ settledAt: now });
      return "settled" as const;
    });
    return r ?? "none";
  }

  /** Every minute: settles the holds of revoked and expired credentials. A hub hiccup waits for the next run. */
  async sweep(limit = 200): Promise<number> {
    let n = 0;
    for (const id of await this.d.store.unsettled(this.d.now(), limit)) {
      const r = await this.settle(id).catch(() => "open" as const);
      if (r === "settled") n += 1;
    }
    return n;
  }
}
