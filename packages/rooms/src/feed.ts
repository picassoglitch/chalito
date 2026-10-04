import type { RoomEventRow } from "./keys.js";

/**
 * The slice of a supabase-js client (schema `chalito`) the feed uses; inject a fake in tests.
 * The client must carry this device's session (accessToken callback).
 */
export interface RoomsDb {
  realtime: { setAuth(token?: string | null): Promise<void> | void };
  channel(topic: string, opts: { config: { private: boolean } }): RoomChannel;
  removeChannel(ch: RoomChannel): Promise<unknown>;
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
 */
export class RoomFeed {
  #rev = 0;
  #channel: RoomChannel | null = null;
  #reading: Promise<void> | null = null;
  #again = false;
  /** Data API reads made (tests assert there is no read loop). */
  reads = 0;

  constructor(
    private readonly db: RoomsDb,
    private readonly roomId: string,
    private readonly onEvents: (rows: RoomEventRow[]) => void,
    private readonly onStatus: (status: string, err?: Error) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    // The session must reach the socket before the join, or Realtime authorizes it as anon.
    await this.db.realtime.setAuth();
    this.#channel = this.db
      .channel(roomTopic(this.roomId), { config: { private: true } })
      .on("broadcast", { event: "room_events" }, () => void this.#safeRead())
      .subscribe((status, err) => {
        if (status === "SUBSCRIBED") void this.#safeRead();
        this.onStatus(status, err);
      });
  }

  async stop(): Promise<void> {
    if (this.#channel) await this.db.removeChannel(this.#channel);
    this.#channel = null;
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
