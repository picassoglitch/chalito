import type { RoomEventRow } from "./keys.js";

/**
 * The slice of a supabase-js client (schema `chalito`) the feed uses; inject a fake in tests.
 * The client must carry this device's session (accessToken callback).
 */
export interface RoomsDb {
  realtime: { setAuth(token?: string | null): Promise<void> | void };
  channel(topic: string, opts: { config: { private: boolean } }): RoomChannel;
  removeChannel(ch: RoomChannel): Promise<unknown>;
  from(table: "room_members"): {
    select(cols: "companion_id"): {
      eq(
        col: "room_id",
        v: string,
      ): {
        eq(col: "companion_id", v: string): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
      };
    };
  };
  from(table: "room_events"): {
    select(cols: string): {
      eq(
        col: "room_id",
        v: string,
      ): {
        gt(
          col: "rev",
          v: number,
        ): {
          order(
            col: "rev",
            o: { ascending: boolean },
          ): PromiseLike<{ data: RoomEventRow[] | null; error: { message: string } | null }>;
        };
      };
    };
  };
}
export interface RoomChannel {
  on(type: "broadcast", filter: { event: string }, cb: (msg: { payload?: unknown }) => void): RoomChannel;
  subscribe(cb?: (status: string, err?: Error) => void): RoomChannel;
}

export const roomTopic = (roomId: string) => `chalito:room:${roomId}`;

/**
 * A room's event feed with no polling: a private channel on `chalito:room:<id>` carries pointers;
 * each pointer (and each (re)join) triggers ONE read of rows with `rev` above the last seen.
 * Expired rows never reach the handler (the read policy hides them; the caller filters held rows).
 *
 * Leaving the room (review R-L14): Realtime authorizes a channel when it joins (and on a token
 * refresh), not per message, so a removed member's open channel would keep receiving pointers.
 * The feed stops itself, with status KICKED, on its own `kicked` pointer or when a membership
 * change or rekey shows (one RLS read) it is no longer a member; DISSOLVED when the room goes.
 * Content stays sealed to the new key epoch either way.
 */
export class RoomFeed {
  #rev = 0;
  #channel: RoomChannel | null = null;
  #reading: Promise<void> | null = null;
  #again = false;
  #ended = false;
  /** Data API reads made (tests assert there is no read loop). */
  reads = 0;

  constructor(
    private readonly db: RoomsDb,
    private readonly roomId: string,
    private readonly onEvents: (rows: RoomEventRow[]) => void,
    private readonly onStatus: (status: string, err?: Error) => void = () => undefined,
    /** This device's companion in the room: enables the membership checks above. */
    private readonly opts: { companionId?: string } = {},
  ) {}

  async start(): Promise<void> {
    // The session must reach the socket before the join, or Realtime authorizes it as anon.
    await this.db.realtime.setAuth();
    this.#channel = this.db
      .channel(roomTopic(this.roomId), { config: { private: true } })
      .on("broadcast", { event: "*" }, (msg) => this.#onPointer(msg?.payload))
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED") void this.#safeRead();
        this.onStatus(status, err);
      });
  }

  async stop(): Promise<void> {
    if (this.#channel) await this.db.removeChannel(this.#channel);
    this.#channel = null;
  }

  /** Whether the feed stopped because the device is no longer in the room. */
  get ended(): boolean {
    return this.#ended;
  }

  #onPointer(p: unknown): void {
    if (this.#ended) return;
    const { table, op, key } = (p ?? {}) as { table?: unknown; op?: unknown; key?: { companion_id?: unknown } };
    if (op === "dissolve") return void this.#end("DISSOLVED");
    if (table === "room_members" && op === "kicked" && key?.companion_id === this.opts.companionId)
      return void this.#end("KICKED");
    if (table === "room_members" || table === "rooms") {
      if (this.opts.companionId) void this.#checkMembership();
      return;
    }
    void this.#safeRead();
  }

  async #checkMembership(): Promise<void> {
    try {
      const { data, error } = await this.db
        .from("room_members")
        .select("companion_id")
        .eq("room_id", this.roomId)
        .eq("companion_id", this.opts.companionId!);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) await this.#end("KICKED");
    } catch (err) {
      this.onStatus("READ_ERROR", err instanceof Error ? err : new Error(String(err)));
    }
  }

  async #end(status: "KICKED" | "DISSOLVED"): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    await this.stop();
    this.onStatus(status);
  }

  #safeRead(): Promise<void> {
    return this.#read().catch((err: unknown) =>
      this.onStatus("READ_ERROR", err instanceof Error ? err : new Error(String(err))),
    );
  }

  /** One read at a time; pointers that arrive during a read cause exactly one more. */
  async #read(): Promise<void> {
    if (this.#reading) {
      this.#again = true;
      return this.#reading;
    }
    this.#reading = (async () => {
      do {
        this.#again = false;
        this.reads++;
        const { data, error } = await this.db
          .from("room_events")
          .select(
            "room_id, eid, from_companion_id, to_companions, kind, urgency, ct, key_epoch, promoted, t, expires_at, rev",
          )
          .eq("room_id", this.roomId)
          .gt("rev", this.#rev)
          .order("rev", { ascending: true });
        if (error) throw new Error(error.message);
        const rows = data ?? [];
        for (const r of rows) this.#rev = Math.max(this.#rev, Number(r.rev));
        if (rows.length) this.onEvents(rows);
      } while (this.#again);
    })().finally(() => {
      this.#reading = null;
    });
    return this.#reading;
  }
}
