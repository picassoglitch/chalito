import type { Sql } from "postgres";

/**
 * Rooms on Postgres. Every write is one call to a chalito_private.room_* function, which takes
 * the actor (the verified owner id and the companion it acts as) and enforces the room rules in
 * one transaction (supabase/migrations/20261004001400_chalito_rooms.sql). Run as chalito_server.
 */
export class RoomError extends Error {
  constructor(
    readonly status: 400 | 402 | 403 | 404 | 409 | 410,
    readonly code: string,
  ) {
    super(code);
  }
}

const STATUS: Record<string, RoomError["status"]> = {
  PT402: 402,
  PT404: 404,
  PT409: 409,
  PT410: 410,
  "42501": 403,
  "22023": 400,
  "23514": 400,
  "23505": 409,
  "23503": 404,
};

/** Maps the functions' SQLSTATEs to HTTP errors with a short machine code. */
const mapped = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const status = e.code ? STATUS[e.code] : undefined;
    if (!status) throw err;
    const code = (e.message ?? "error")
      .replace(/^chalito: /, "")
      .replace(/[^a-z0-9]+/gi, "_")
      .toLowerCase();
    throw new RoomError(status, code);
  }
};

export interface RoomRow {
  room_id: string;
  type: string;
  name: string;
  owner_uid: string;
  owner_companion_id: string;
  ephemeral_ttl: string;
  keep_promoted: boolean;
  key_epoch: number;
  needs_rotation: boolean;
}

export class PostgresRoomsRepo {
  constructor(private readonly sql: Sql) {}

  async userTier(uid: string): Promise<string | null> {
    const [r] = await this.sql<{ tier: string | null }[]>`select tier from chalito.users where id = ${uid}`;
    return r?.tier ?? null;
  }

  /** The tier of the owner of the room an invite (by short-code or glyph hash) belongs to. */
  async inviteOwnerTier(hash: string): Promise<string | null> {
    const [r] = await this.sql<{ tier: string | null }[]>`
      select u.tier from chalito.room_invites i
      join chalito.rooms r on r.room_id = i.room_id
      join chalito.users u on u.id = r.owner_uid
      where i.short_code_hash = ${hash} or i.glyph_payload_hash = ${hash}`;
    return r?.tier ?? null;
  }

  async room(roomId: string): Promise<RoomRow | null> {
    const [r] = await this.sql<RoomRow[]>`select * from chalito.rooms where room_id = ${roomId}`;
    return r ?? null;
  }

  create(a: {
    uid: string;
    companion: string;
    roomId: string;
    type: string;
    name: string;
    wrapped: Record<string, string>;
    roomLimit: number;
    ttl: string;
    keepPromoted: boolean;
  }) {
    return mapped(async () => {
      const [r] = await this.sql<RoomRow[]>`
        select * from chalito_private.room_create(${a.uid}, ${a.companion}, ${a.roomId}, ${a.type}, ${a.name},
          ${this.sql.json(a.wrapped)}, ${a.roomLimit}, ${a.ttl}, ${a.keepPromoted})`;
      return r!;
    });
  }

  invite(a: {
    uid: string;
    companion: string;
    roomId: string;
    inviteId: string;
    glyphHash: string;
    shortHash: string;
    maxUses: number;
    expiresAt: number;
  }) {
    return mapped(async () => {
      await this.sql`select chalito_private.room_invite(${a.uid}, ${a.companion}, ${a.roomId}, ${a.inviteId},
        ${a.glyphHash}, ${a.shortHash}, ${a.maxUses}, ${new Date(a.expiresAt)})`;
    });
  }

  join(a: { uid: string; companion: string; hash: string; memberLimit: number }) {
    return mapped(async () => {
      const [r] = await this.sql<{ room_id: string }[]>`
        select chalito_private.room_join(${a.uid}, ${a.companion}, ${a.hash}, ${a.memberLimit}) as room_id`;
      return r!.room_id;
    });
  }

  /** Active client devices (id, box key) of a member, for a co-member's client to wrap the key to. */
  memberDevices(a: { uid: string; companion: string; roomId: string; target: string }) {
    return mapped(async () => {
      const [me] = await this.sql`select 1 from chalito.room_members
        where room_id = ${a.roomId} and companion_id = ${a.companion} and uid = ${a.uid}`;
      if (!me) throw Object.assign(new Error("chalito: not a member of this room"), { code: "42501" });
      return this.sql<{ device_id: string; pub_box: string }[]>`
        select d.device_id, d.pub_box from chalito.room_members m
        join chalito.devices d on d.owner = m.uid and d.role = 'client' and not d.revoked
        where m.room_id = ${a.roomId} and m.companion_id = ${a.target}
        order by d.device_id`;
    });
  }

  wrapKeys(a: {
    uid: string;
    companion: string;
    roomId: string;
    target: string;
    epoch: number;
    wrapped: Record<string, string>;
  }) {
    return mapped(async () => {
      await this
        .sql`select chalito_private.room_wrap_keys(${a.uid}, ${a.companion}, ${a.roomId}, ${a.target}, ${a.epoch},
        ${this.sql.json(a.wrapped)})`;
    });
  }

  leave(a: { uid: string; companion: string; roomId: string }) {
    return mapped(async () => {
      await this.sql`select chalito_private.room_leave(${a.uid}, ${a.companion}, ${a.roomId})`;
    });
  }

  rotate(a: {
    uid: string;
    companion: string;
    roomId: string;
    epoch: number;
    wrapped: Record<string, Record<string, string>>;
  }) {
    return mapped(async () => {
      await this.sql`select chalito_private.room_rotate(${a.uid}, ${a.companion}, ${a.roomId}, ${a.epoch},
        ${this.sql.json(a.wrapped)})`;
    });
  }

  dissolve(a: { uid: string; companion: string; roomId: string }) {
    return mapped(async () => {
      await this.sql`select chalito_private.room_dissolve(${a.uid}, ${a.companion}, ${a.roomId})`;
    });
  }

  post(a: {
    uid: string;
    companion: string;
    roomId: string;
    eid: string;
    to: string[];
    kind: string;
    urgency: string;
    ct: unknown;
    epoch: number;
  }) {
    return mapped(async () => {
      const [e] = await this.sql<{ t: Date; expires_at: Date | null; rev: string }[]>`
        select t, expires_at, rev from chalito_private.room_post(${a.uid}, ${a.companion}, ${a.roomId}, ${a.eid},
          ${a.to}, ${a.kind}, ${a.urgency}, ${this.sql.json(a.ct as never)}, ${a.epoch})`;
      return { t: e!.t.getTime(), expiresAt: e!.expires_at ? e!.expires_at.getTime() : null };
    });
  }

  promote(a: { uid: string; companion: string; roomId: string; eid: string; rid: string; kind: string; ct: unknown }) {
    return mapped(async () => {
      await this.sql`select chalito_private.room_promote(${a.uid}, ${a.companion}, ${a.roomId}, ${a.eid}, ${a.rid},
        ${a.kind}, ${this.sql.json(a.ct as never)})`;
    });
  }

  setRetention(a: { uid: string; companion: string; roomId: string; ttl: string; keepPromoted: boolean }) {
    return mapped(async () => {
      const [r] = await this.sql<RoomRow[]>`
        select * from chalito_private.room_set_retention(${a.uid}, ${a.companion}, ${a.roomId}, ${a.ttl}, ${a.keepPromoted})`;
      return r!;
    });
  }
}

export type RoomsRepo = PostgresRoomsRepo;
