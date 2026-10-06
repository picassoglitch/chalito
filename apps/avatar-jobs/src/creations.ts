import type { Sql } from "postgres";
import { enqueueUsage } from "@chalito/billing";
import type { HubUsageEvent } from "@chalito/protocol";
import type { CardManifest } from "./process.js";

/**
 * chalito.avatar_creations as the job sees it (migration 20261005000100; the api starts and
 * settles creations, apps/api src/avatar). The job claims one, then finishes it: a success writes
 * the manifest and, for a paid creation, the image.generations usage event in the same transaction.
 */
export type Failure = "rejected" | "refused" | "provider" | "upload_missing";

export interface Claim {
  creationId: string;
  free: boolean;
  /** The hub reservation of a paid creation (null when free). */
  reservationId: string | null;
}

export type ClaimResult =
  | { state: "claimed"; claim: Claim }
  /** Another execution is generating it right now: leave the upload to it. */
  | { state: "busy" }
  /** No creation waits for this upload (unknown, finished, expired): the upload must go. */
  | { state: "none" };

export interface CreationStore {
  claim(owner: string, assetId: string, now: number): Promise<ClaimResult>;
  /** False when the creation was no longer this job's (timed out meanwhile): nothing is billed then. */
  succeed(p: {
    creationId: string;
    owner: string;
    manifest: CardManifest;
    images: number;
    costMicros: number;
    event: HubUsageEvent | null;
    now: number;
  }): Promise<boolean>;
  fail(p: { creationId: string; failure: Failure; images: number; costMicros: number; now: number }): Promise<void>;
}

/** A generating claim older than this belongs to a dead execution (the job's timeout is 10 min). */
export const STALE_CLAIM_MS = 15 * 60_000;

export class PostgresCreationStore implements CreationStore {
  constructor(private readonly sql: Sql) {}

  async claim(owner: string, assetId: string, now: number): Promise<ClaimResult> {
    const at = new Date(now);
    const [r] = await this.sql<{ creation_id: string; free: boolean; reservation_id: string | null }[]>`
      update chalito.avatar_creations set status = 'generating', claimed_at = ${at}
      where owner = ${owner} and asset_id = ${assetId} and (
        (status in ('awaiting_upload', 'queued') and upload_deadline > ${at})
        or (status = 'generating' and claimed_at < ${new Date(now - STALE_CLAIM_MS)})
      )
      returning creation_id, free, reservation_id`;
    if (r)
      return { state: "claimed", claim: { creationId: r.creation_id, free: r.free, reservationId: r.reservation_id } };
    const [s] = await this.sql<{ status: string }[]>`
      select status from chalito.avatar_creations where owner = ${owner} and asset_id = ${assetId}`;
    return s?.status === "generating" ? { state: "busy" } : { state: "none" };
  }

  async succeed(p: Parameters<CreationStore["succeed"]>[0]) {
    return (await this.sql.begin(async (tx) => {
      const [done] = await tx`
        update chalito.avatar_creations
        set status = 'succeeded', manifest = ${tx.json(p.manifest as never)}, images = ${p.images},
            cost_usd_micros = ${p.costMicros}, source_id = ${p.event?.source_id ?? null}, finished_at = ${new Date(p.now)}
        where creation_id = ${p.creationId} and status = 'generating'
        returning creation_id`;
      if (!done) return false;
      await enqueueUsage(tx, p.owner, [p.event]);
      return true;
    })) as boolean;
  }

  async fail(p: Parameters<CreationStore["fail"]>[0]) {
    await this.sql`
      update chalito.avatar_creations
      set status = 'failed', failure = ${p.failure}, images = ${p.images}, cost_usd_micros = ${p.costMicros},
          finished_at = ${new Date(p.now)}
      where creation_id = ${p.creationId} and status = 'generating'`;
  }
}

/** In memory, for tests. */
export class MemoryCreationStore implements CreationStore {
  readonly rows = new Map<
    string,
    {
      creationId: string;
      owner: string;
      assetId: string;
      status: string;
      free: boolean;
      reservationId: string | null;
      uploadDeadline: number;
      claimedAt?: number;
      failure?: Failure;
      images?: number;
      costMicros?: number;
      manifest?: CardManifest;
    }
  >();
  readonly outbox: HubUsageEvent[] = [];

  add(r: { creationId: string; owner: string; assetId: string; free: boolean; reservationId?: string }, now: number) {
    this.rows.set(r.creationId, {
      ...r,
      reservationId: r.reservationId ?? null,
      status: "queued",
      uploadDeadline: now + 30 * 60_000,
    });
  }

  async claim(owner: string, assetId: string, now: number): Promise<ClaimResult> {
    const r = [...this.rows.values()].find((x) => x.owner === owner && x.assetId === assetId);
    if (!r) return { state: "none" };
    const open = ["awaiting_upload", "queued"].includes(r.status) && r.uploadDeadline > now;
    const stale = r.status === "generating" && (r.claimedAt ?? 0) < now - STALE_CLAIM_MS;
    if (open || stale) {
      r.status = "generating";
      r.claimedAt = now;
      return { state: "claimed", claim: { creationId: r.creationId, free: r.free, reservationId: r.reservationId } };
    }
    return r.status === "generating" ? { state: "busy" } : { state: "none" };
  }

  async succeed(p: Parameters<CreationStore["succeed"]>[0]) {
    const r = this.rows.get(p.creationId);
    if (r?.status !== "generating") return false;
    Object.assign(r, { status: "succeeded", manifest: p.manifest, images: p.images, costMicros: p.costMicros });
    if (p.event) this.outbox.push(p.event);
    return true;
  }

  async fail(p: Parameters<CreationStore["fail"]>[0]) {
    const r = this.rows.get(p.creationId);
    if (r?.status !== "generating") return;
    Object.assign(r, { status: "failed", failure: p.failure, images: p.images, costMicros: p.costMicros });
  }
}
