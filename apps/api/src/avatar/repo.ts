import type { Sql } from "postgres";

/**
 * Custom companion creations (chalito.avatar_creations, migration 20261005000100). The api starts,
 * confirms, expires and settles them; the avatar job claims and finishes them (apps/avatar-jobs
 * src/creation.ts) in its own transaction with the usage event.
 */
export type CreationStatus =
  | "awaiting_upload"
  | "queued"
  | "generating"
  | "succeeded"
  | "failed"
  | "expired"
  /** The owner deleted it (migration 20261005000400): drawings gone, the row kept for billing and audit. */
  | "deleted";
export type CreationFailure = "rejected" | "refused" | "provider" | "upload_missing" | "timeout";
export const ACTIVE: readonly CreationStatus[] = ["awaiting_upload", "queued", "generating"];
export const TERMINAL: readonly CreationStatus[] = ["succeeded", "failed", "expired", "deleted"];
/** Statuses that hold (or held) the free creation: a deleted free creation still used it up. */
export const HOLDS_FREE: readonly CreationStatus[] = [...ACTIVE, "succeeded", "deleted"];
export const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type UploadType = (typeof UPLOAD_TYPES)[number];
/** The age bands a person can attest to and still create (under 13 can't). */
export type AgeBand = "13_17" | "18_plus";

/**
 * What the person confirmed when starting a creation (self-attestation, recorded on the row):
 * the photo is of themselves, their age band and, for 13–17, a parent's or guardian's permission.
 */
export interface Attestation {
  ownPhoto: true;
  ageBand: AgeBand;
  guardianConsent: boolean;
  at: number;
}

/** The card the job wrote (card.json), as far as the api reads it. */
export interface CardManifestLike {
  emotions: { mode: string; src: Record<string, string> };
  thumbs: Record<string, string>;
  [k: string]: unknown;
}

export interface CreationRecord {
  creationId: string;
  owner: string;
  assetId: string;
  status: CreationStatus;
  free: boolean;
  reservationId: string | null;
  estTokens: number | null;
  settled: boolean;
  contentType: UploadType;
  failure: CreationFailure | null;
  manifest: CardManifestLike | null;
  uploadDeadline: number;
  claimedAt: number | null;
  createdAt: number;
  /** Onboarding: the companion wears the card as soon as it succeeds (migration 20261005000200). */
  useWhenReady: boolean;
  /** When the owner deleted it (status "deleted"). */
  deletedAt: number | null;
  /** The deletion's drawings are gone from the bucket (false: the storage step must run again). */
  filesDeleted: boolean;
}

export interface NewCreation {
  creationId: string;
  owner: string;
  assetId: string;
  free: boolean;
  reservationId: string | null;
  estTokens: number | null;
  contentType: UploadType;
  uploadDeadline: number;
  createdAt: number;
  attestation: Attestation;
  useWhenReady: boolean;
  /** A free creation's markers (src/avatar/free-marker.ts): recorded once it succeeds. Null when paid. */
  freeMarkers: string[] | null;
}

/**
 * - `duplicate_id`: that creation id exists (a concurrent retry of the same start);
 * - `busy`: the owner has a creation in flight;
 * - `free_taken`: a free creation was taken concurrently (in flight or succeeded).
 */
export type InsertResult = "inserted" | "duplicate_id" | "busy" | "free_taken";

/** One of the owner's kept characters (GET /v1/avatar/creations). */
export interface KeptCreation {
  creationId: string;
  assetId: string;
  manifest: CardManifestLike;
  createdAt: number;
}

export interface AvatarRepo {
  get(creationId: string): Promise<CreationRecord | null>;
  /** The owner's creation in flight (awaiting_upload, queued or generating), if any. */
  active(owner: string): Promise<CreationRecord | null>;
  /**
   * The first creation is free, once per person: no free creation of this owner in flight or
   * succeeded (deleted included: deleting never gives it back), and none of `markers` left by a free success (this account or a deleted one).
   */
  freeAvailable(owner: string, markers: readonly string[]): Promise<boolean>;
  /** The hub account's email Chalito has for the owner (chalito.users.email, from SSO). */
  ownerEmail(owner: string): Promise<string | null>;
  /** Creations started since `since` (every attempt counts: the daily cap). */
  startedSince(owner: string, since: number): Promise<number>;
  insert(c: NewCreation): Promise<InsertResult>;
  /** awaiting_upload → queued (the client says the upload is done). */
  markQueued(creationId: string): Promise<void>;
  /** awaiting_upload → expired, or queued/generating → failed (timeout). False when it moved on meanwhile. */
  expire(creationId: string, from: CreationStatus, now: number): Promise<boolean>;
  markSettled(creationId: string, now: number): Promise<void>;
  /** Terminal paid creations whose reservation hasn't been settled yet. */
  unsettled(owner: string): Promise<CreationRecord[]>;
  /** The owner's succeeded (not deleted) creations, newest first. */
  kept(owner: string, limit: number): Promise<KeptCreation[]>;
  /**
   * succeeded → deleted (manifest dropped; a companion wearing it goes back to its roster avatar, in
   * the same transaction). False when it isn't succeeded (any more).
   */
  markDeleted(creationId: string, now: number): Promise<boolean>;
  /** The deleted creation's drawings are gone from the bucket. */
  markFilesDeleted(creationId: string, now: number): Promise<void>;
  /** Points the owner's companion at a succeeded creation's card (null: back to the roster avatar). */
  setCompanion(owner: string, card: { assetId: string; manifest: CardManifestLike } | null): Promise<boolean>;
  /** The owner's companion's custom card, if it has one. */
  companionCard(owner: string): Promise<{ assetId: string; manifest: CardManifestLike } | null>;
  /**
   * The custom cards of a room's members (the viewer's own included), only when `viewer` is a
   * member of that room right now; otherwise none (chalito_private.room_member_cards).
   */
  roomCards(viewer: string, roomId: string): Promise<RoomMemberCard[]>;
}

export interface RoomMemberCard {
  companionId: string;
  owner: string;
  assetId: string;
  manifest: CardManifestLike;
}

type Row = {
  creation_id: string;
  owner: string;
  asset_id: string;
  status: CreationStatus;
  free: boolean;
  reservation_id: string | null;
  est_tokens: number | null;
  settled_at: Date | null;
  content_type: UploadType;
  failure: CreationFailure | null;
  manifest: CardManifestLike | null;
  upload_deadline: Date;
  claimed_at: Date | null;
  created_at: Date;
  use_when_ready: boolean;
  deleted_at: Date | null;
  files_deleted_at: Date | null;
};

const record = (r: Row): CreationRecord => ({
  creationId: r.creation_id,
  owner: r.owner,
  assetId: r.asset_id,
  status: r.status,
  free: r.free,
  reservationId: r.reservation_id,
  estTokens: r.est_tokens,
  settled: r.settled_at !== null,
  contentType: r.content_type,
  failure: r.failure,
  manifest: r.manifest,
  uploadDeadline: r.upload_deadline.getTime(),
  claimedAt: r.claimed_at?.getTime() ?? null,
  createdAt: r.created_at.getTime(),
  useWhenReady: r.use_when_ready,
  deletedAt: r.deleted_at?.getTime() ?? null,
  filesDeleted: r.files_deleted_at !== null,
});

const COLS = [
  "creation_id",
  "owner",
  "asset_id",
  "status",
  "free",
  "reservation_id",
  "est_tokens",
  "settled_at",
  "content_type",
  "failure",
  "manifest",
  "upload_deadline",
  "claimed_at",
  "created_at",
  "use_when_ready",
  "deleted_at",
  "files_deleted_at",
];

export class PostgresAvatarRepo implements AvatarRepo {
  constructor(private readonly sql: Sql) {}

  async get(creationId: string) {
    const [r] = await this.sql<Row[]>`
      select ${this.sql(COLS)} from chalito.avatar_creations where creation_id = ${creationId}`;
    return r ? record(r) : null;
  }

  async active(owner: string) {
    const [r] = await this.sql<Row[]>`
      select ${this.sql(COLS)} from chalito.avatar_creations
      where owner = ${owner} and status in ('awaiting_upload', 'queued', 'generating')`;
    return r ? record(r) : null;
  }

  async freeAvailable(owner: string, markers: readonly string[]) {
    const [r] = await this.sql<{ taken: boolean }[]>`
      select exists (
        select 1 from chalito.avatar_creations
        where owner = ${owner} and free and status in ('awaiting_upload', 'queued', 'generating', 'succeeded', 'deleted')
      ) or exists (
        select 1 from chalito_private.avatar_free_markers where marker = any(${this.sql.array([...markers])}::text[])
      ) as taken`;
    return !r!.taken;
  }

  async ownerEmail(owner: string) {
    const [r] = await this.sql<{ email: string | null }[]>`select email from chalito.users where id = ${owner}`;
    return r?.email ?? null;
  }

  async startedSince(owner: string, since: number) {
    const [r] = await this.sql<{ n: number }[]>`
      select count(*)::int as n from chalito.avatar_creations
      where owner = ${owner} and created_at >= ${new Date(since)}`;
    return r!.n;
  }

  async insert(c: NewCreation): Promise<InsertResult> {
    try {
      await this.sql`
        insert into chalito.avatar_creations
          (creation_id, owner, asset_id, free, reservation_id, est_tokens, content_type, upload_deadline, created_at,
           attest_own_photo, attest_age_band, attest_guardian, attested_at, use_when_ready, free_markers)
        values (${c.creationId}, ${c.owner}, ${c.assetId}, ${c.free}, ${c.reservationId}, ${c.estTokens},
                ${c.contentType}, ${new Date(c.uploadDeadline)}, ${new Date(c.createdAt)},
                ${c.attestation.ownPhoto}, ${c.attestation.ageBand}, ${c.attestation.guardianConsent},
                ${new Date(c.attestation.at)}, ${c.useWhenReady}, ${c.freeMarkers ? this.sql.array(c.freeMarkers) : null}::text[])`;
      return "inserted";
    } catch (err) {
      const e = err as { code?: string; constraint_name?: string };
      if (e.code !== "23505") throw err;
      if (e.constraint_name === "avatar_creations_one_active") return "busy";
      if (e.constraint_name === "avatar_creations_one_free") return "free_taken";
      return "duplicate_id";
    }
  }

  async markQueued(creationId: string) {
    await this.sql`
      update chalito.avatar_creations set status = 'queued'
      where creation_id = ${creationId} and status = 'awaiting_upload'`;
  }

  async expire(creationId: string, from: CreationStatus, now: number) {
    const rows =
      from === "awaiting_upload"
        ? await this.sql`
            update chalito.avatar_creations set status = 'expired', finished_at = ${new Date(now)}
            where creation_id = ${creationId} and status = 'awaiting_upload' returning creation_id`
        : await this.sql`
            update chalito.avatar_creations set status = 'failed', failure = 'timeout', finished_at = ${new Date(now)}
            where creation_id = ${creationId} and status = ${from} returning creation_id`;
    return rows.length > 0;
  }

  async markSettled(creationId: string, now: number) {
    await this.sql`
      update chalito.avatar_creations set settled_at = ${new Date(now)}
      where creation_id = ${creationId} and settled_at is null`;
  }

  async unsettled(owner: string) {
    const rows = await this.sql<Row[]>`
      select ${this.sql(COLS)} from chalito.avatar_creations
      where owner = ${owner} and reservation_id is not null and settled_at is null
        and status in ('succeeded', 'failed', 'expired', 'deleted')`;
    return rows.map(record);
  }

  async kept(owner: string, limit: number) {
    const rows = await this.sql<
      { creation_id: string; asset_id: string; manifest: CardManifestLike; created_at: Date }[]
    >`
      select creation_id, asset_id, manifest, created_at from chalito.avatar_creations
      where owner = ${owner} and status = 'succeeded'
      order by created_at desc
      limit ${limit}`;
    return rows.map((r) => ({
      creationId: r.creation_id,
      assetId: r.asset_id,
      manifest: r.manifest,
      createdAt: r.created_at.getTime(),
    }));
  }

  async markDeleted(creationId: string, now: number) {
    // The migration's triggers drop the manifest and clear a companion that wears it.
    const rows = await this.sql`
      update chalito.avatar_creations set status = 'deleted', deleted_at = ${new Date(now)}
      where creation_id = ${creationId} and status = 'succeeded' returning creation_id`;
    return rows.length > 0;
  }

  async markFilesDeleted(creationId: string, now: number) {
    await this.sql`
      update chalito.avatar_creations set files_deleted_at = ${new Date(now)}
      where creation_id = ${creationId} and status = 'deleted' and files_deleted_at is null`;
  }

  async setCompanion(owner: string, card: { assetId: string; manifest: CardManifestLike } | null) {
    const rows = card
      ? await this.sql`
          update chalito.companions
          set asset_id = ${card.assetId}, expression_map = ${this.sql.json(card.manifest.emotions as never)}
          where owner = ${owner} returning companion_id`
      : await this.sql`
          update chalito.companions set asset_id = null, expression_map = null
          where owner = ${owner} returning companion_id`;
    return rows.length > 0;
  }

  async companionCard(owner: string) {
    const [r] = await this.sql<{ asset_id: string; manifest: CardManifestLike }[]>`
      select c.asset_id, a.manifest from chalito.companions c
      join chalito.avatar_creations a on a.asset_id = c.asset_id and a.owner = c.owner and a.status = 'succeeded'
      where c.owner = ${owner} and c.asset_id is not null
      limit 1`;
    return r ? { assetId: r.asset_id, manifest: r.manifest } : null;
  }

  async roomCards(viewer: string, roomId: string) {
    const rows = await this.sql<
      { companion_id: string; owner: string; asset_id: string; manifest: CardManifestLike }[]
    >`
      select companion_id, owner, asset_id, manifest from chalito_private.room_member_cards(${viewer}, ${roomId})`;
    return rows.map((r) => ({
      companionId: r.companion_id,
      owner: r.owner,
      assetId: r.asset_id,
      manifest: r.manifest,
    }));
  }
}

/** The same rules in memory (unit tests, the dev backend): unique ids, one in flight, one free. */
export class MemoryAvatarRepo implements AvatarRepo {
  readonly rows = new Map<string, CreationRecord & { attestation: Attestation; freeMarkers: string[] | null }>();
  /** chalito_private.avatar_free_markers: survives deleteOwner, like the table survives delete_account. */
  readonly markers = new Set<string>();
  /** chalito.users.email */
  readonly emails = new Map<string, string>();
  /** owner → the companion's custom card (undefined: the owner has no companion). */
  readonly companions = new Map<string, { assetId: string; manifest: CardManifestLike } | null>();
  /** roomId → its members (room_members). */
  readonly rooms = new Map<string, { companionId: string; owner: string }[]>();

  async get(creationId: string) {
    const r = this.rows.get(creationId);
    return r ? { ...r } : null;
  }
  async active(owner: string) {
    const r = [...this.rows.values()].find((x) => x.owner === owner && ACTIVE.includes(x.status));
    return r ? { ...r } : null;
  }
  async freeAvailable(owner: string, markers: readonly string[]) {
    if (markers.some((m) => this.markers.has(m))) return false;
    return ![...this.rows.values()].some((x) => x.owner === owner && x.free && HOLDS_FREE.includes(x.status));
  }
  async ownerEmail(owner: string) {
    return this.emails.get(owner) ?? null;
  }
  /** What the avatar job's success does here, with the migration's trigger (markers, use_when_ready). */
  succeed(creationId: string, manifest: CardManifestLike) {
    const r = this.rows.get(creationId)!;
    Object.assign(r, { status: "succeeded", manifest });
    if (r.free) for (const m of r.freeMarkers ?? []) this.markers.add(m);
    if (r.useWhenReady && this.companions.has(r.owner)) this.companions.set(r.owner, { assetId: r.assetId, manifest });
  }
  /** chalito_private.delete_account: the owner's rows and companion go; the free markers stay. */
  deleteOwner(owner: string) {
    for (const [id, r] of this.rows) if (r.owner === owner) this.rows.delete(id);
    this.companions.delete(owner);
    this.emails.delete(owner);
  }
  async startedSince(owner: string, since: number) {
    return [...this.rows.values()].filter((x) => x.owner === owner && x.createdAt >= since).length;
  }
  async insert(c: NewCreation): Promise<InsertResult> {
    if (this.rows.has(c.creationId)) return "duplicate_id";
    if (await this.active(c.owner)) return "busy";
    if (c.free && !(await this.freeAvailable(c.owner, []))) return "free_taken";
    this.rows.set(c.creationId, {
      ...c,
      status: "awaiting_upload",
      settled: false,
      failure: null,
      manifest: null,
      claimedAt: null,
      deletedAt: null,
      filesDeleted: false,
    });
    return "inserted";
  }
  async markQueued(creationId: string) {
    const r = this.rows.get(creationId);
    if (r?.status === "awaiting_upload") r.status = "queued";
  }
  async expire(creationId: string, from: CreationStatus) {
    const r = this.rows.get(creationId);
    if (!r || r.status !== from) return false;
    if (from === "awaiting_upload") r.status = "expired";
    else Object.assign(r, { status: "failed", failure: "timeout" });
    return true;
  }
  async markSettled(creationId: string) {
    const r = this.rows.get(creationId);
    if (r) r.settled = true;
  }
  async unsettled(owner: string) {
    return [...this.rows.values()]
      .filter((x) => x.owner === owner && x.reservationId && !x.settled && TERMINAL.includes(x.status))
      .map((x) => ({ ...x }));
  }
  async kept(owner: string, limit: number) {
    return [...this.rows.values()]
      .filter((x) => x.owner === owner && x.status === "succeeded" && x.manifest)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((x) => ({ creationId: x.creationId, assetId: x.assetId, manifest: x.manifest!, createdAt: x.createdAt }));
  }
  /** With the migration's triggers: manifest dropped, a companion wearing it back to its roster avatar. */
  async markDeleted(creationId: string, now: number) {
    const r = this.rows.get(creationId);
    if (r?.status !== "succeeded") return false;
    Object.assign(r, { status: "deleted", manifest: null, deletedAt: now });
    if (this.companions.get(r.owner)?.assetId === r.assetId) this.companions.set(r.owner, null);
    return true;
  }
  async markFilesDeleted(creationId: string) {
    const r = this.rows.get(creationId);
    if (r?.status === "deleted") r.filesDeleted = true;
  }
  async setCompanion(owner: string, card: { assetId: string; manifest: CardManifestLike } | null) {
    if (!this.companions.has(owner)) return false;
    this.companions.set(owner, card);
    return true;
  }
  async companionCard(owner: string) {
    return this.companions.get(owner) ?? null;
  }
  async roomCards(viewer: string, roomId: string) {
    const members = this.rooms.get(roomId) ?? [];
    if (!members.some((m) => m.owner === viewer)) return [];
    return members.flatMap((m) => {
      const c = this.companions.get(m.owner);
      return c ? [{ companionId: m.companionId, owner: m.owner, ...c }] : [];
    });
  }
}
