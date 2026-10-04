import { randomUUID } from "node:crypto";
import type { PricesConfig } from "@chalito/config";
import type { HubUsageEvent } from "@chalito/protocol";
import { usageEvent } from "./billable.js";
import { voiceSecondsCostMicros } from "./cost.js";
import type { HubClient } from "./hub.js";

/** Metered streams (voice): admit once, report as it runs, settle at the end. */
export type MeterKind = "voice.seconds";

export interface StreamUsage {
  admit(p: {
    owner: string;
    kind: MeterKind;
    class: "stream";
    sourceId: string;
  }): Promise<{ admitted: true; admissionId: string } | { admitted: false; reason: string }>;
  /** Reports usage; `continue: false` means stop (balance gone or the hub refused). */
  record(p: {
    owner: string;
    admissionId: string;
    kind: MeterKind;
    quantity: number;
    sourceId: string;
  }): Promise<{ continue: boolean }>;
  settle(p: { owner: string; admissionId: string }): Promise<void>;
}

/** Billable tokens the hub will reserve for a cost estimate (cost × (1 + 160%) at 4 µ$ per token). */
export const estimateBillable = (costMicros: number, marginPercent = 160) =>
  Math.ceil((costMicros * (1 + marginPercent / 100)) / 4);

/**
 * StreamUsage over the hub contract. Each report is a voice.seconds event (priced from
 * prices.yaml) written to the outbox, then the reservation is extended (settle: heartbeat) and
 * re-admitted to learn whether the balance still covers the stream.
 */
export class HubStreamUsage implements StreamUsage {
  constructor(
    private readonly p: {
      hub: Pick<HubClient, "admit" | "settle">;
      enqueue: (owner: string, events: (HubUsageEvent | null)[]) => Promise<void>;
      prices: PricesConfig;
      model: string;
      now: () => number;
      /** How much a stream reserves up front (seconds of voice). */
      reserveSeconds?: number;
    },
  ) {}

  #admitRequest(owner: string, sourceId: string) {
    const est = estimateBillable(voiceSecondsCostMicros(this.p.prices, this.p.model, this.p.reserveSeconds ?? 600));
    return {
      external_user_id: owner,
      external_job_id: sourceId,
      class: "stream" as const,
      operation: "voice.session",
      est_tokens: est,
      ttl_seconds: 900,
    };
  }

  async admit(p: { owner: string; kind: MeterKind; class: "stream"; sourceId: string }) {
    const res = await this.p.hub.admit(this.#admitRequest(p.owner, p.sourceId));
    if (!res.allowed) return { admitted: false as const, reason: res.reason };
    if (!res.balance.unlimited && res.balance.remaining <= 0) {
      await this.p.hub.settle({ reservation_id: res.reservation_id, outcome: "cancelled" });
      return { admitted: false as const, reason: "no_tokens" };
    }
    return { admitted: true as const, admissionId: res.reservation_id };
  }

  async record(p: { owner: string; admissionId: string; kind: MeterKind; quantity: number; sourceId: string }) {
    const event = usageEvent(
      { owner: p.owner, billingMode: "managed", origin: "voice.desktop" },
      {
        kind: "voice.seconds",
        provider: "openai",
        amount: p.quantity,
        costUsdMicros: voiceSecondsCostMicros(this.p.prices, this.p.model, p.quantity),
        occurredAt: this.p.now(),
        sourceId: `${p.sourceId}:${randomUUID()}`,
        reservationId: p.admissionId,
        metadata: { model: this.p.model },
      },
    );
    await this.p.enqueue(p.owner, [event]);
    // A heartbeat on a closed reservation is 409: stop the stream.
    const beat = await this.p.hub.settle({ reservation_id: p.admissionId, outcome: "heartbeat" });
    if (!beat.ok && beat.closed) return { continue: false };
    const again = await this.p.hub.admit(this.#admitRequest(p.owner, p.sourceId));
    return { continue: again.allowed && (again.balance.unlimited || again.balance.remaining > 0) };
  }

  async settle(p: { owner: string; admissionId: string }) {
    await this.p.hub.settle({ reservation_id: p.admissionId, outcome: "succeeded" });
  }
}
