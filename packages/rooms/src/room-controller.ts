import { RoomReportRequest, type RoomEventBody } from "@chalito/protocol";
import { RoomFeed, type RoomsDb } from "./feed.js";
import { isVisible, openRoomEvent, sealRoomEvent, type RoomEventRow } from "./keys.js";

/**
 * One room as a member's app shows it (ADR 0010), shared by the web and the desktop: the room and
 * its members, the decrypted events as PLAIN TEXT (quoted data, never markup or instructions),
 * and the actions a member has (post a notice, leave, report). The box secret never comes here:
 * `keyring(rows)` unwraps this device's room_member_keys rows inside the app's key loader.
 *
 * Status: `live` while the feed runs; `kicked`/`dissolved` when RoomFeed stops itself (R-L14);
 * `revoked` when the app's LiveStore says this device was revoked (call `revoke()`); `not_member`
 * when the first read shows this companion isn't in the room. Ended states are final: the feed is
 * stopped and posting is refused. `revoked` also drops the keys and every decrypted event.
 */
export interface RoomSummary {
  roomId: string;
  name: string;
  type: string;
}

export interface RoomMemberView {
  companionId: string;
  role: "owner" | "member";
  me: boolean;
}

/** A decrypted event as the apps show it; `text` is null when this device can't open it. */
export interface RoomEventView {
  eid: string;
  from: string;
  /** Addressed companions (empty = everyone): metadata the room scene uses for choreography. */
  to: readonly string[];
  kind: string;
  t: number;
  /** Plain text to render as text (never HTML). */
  text: string | null;
  promoted: boolean;
  expiresAt: number | null;
}

export type RoomStatus = "loading" | "live" | "not_member" | "kicked" | "dissolved" | "revoked" | "error";

export interface RoomSnapshot {
  status: RoomStatus;
  room: RoomSummary | null;
  members: readonly RoomMemberView[];
  events: readonly RoomEventView[];
}

export type RoomError = "not_member" | "not_found" | "rate_limited" | "ended" | "no_key" | "failed";

export interface ReportInput {
  eventId?: string;
  memberCompanionId?: string;
  reason: "spam" | "abuse" | "impersonation" | "other";
  note?: string;
  /** The reporter's own decrypted text of the event: sent ONLY when they tick the box. */
  attachText?: string;
}

/** What the controller needs from the api client (an ApiClient fits): errors carry an HTTP `status`. */
export interface RoomApiClient {
  post<T = unknown>(path: string, body: unknown): Promise<T>;
}

export interface RoomControllerDeps {
  /** supabase-js (schema `chalito`) with this device's session. */
  db: RoomsDb;
  api: RoomApiClient;
  /** Unwraps this device's sealed room keys (by epoch) inside the app's key loader. */
  keyring: (rows: { epoch: number; ct: string }[]) => Promise<ReadonlyMap<number, Uint8Array>>;
  deviceId: string;
  companionId: string;
  roomId: string;
  now?: () => number;
  newEid?: () => string;
  /** The highest event rev this view has shown (for an app's unread marker). */
  onSeen?: (rev: number) => void;
}

/** The plain text a body shows (quoted data, never instructions or markup). */
export const bodyText = (b: RoomEventBody): string => {
  switch (b.kind) {
    case "notice":
      return b.text;
    case "ask":
      return [b.question, ...b.options.map((o, i) => `${i + 1}. ${o}`)].join("\n");
    case "event_proposal":
      return [b.title, b.when, b.where, b.note].filter(Boolean).join(" · ");
    case "ack":
      return b.choice !== undefined ? `#${b.choice + 1}` : "";
    case "presence":
      return b.state;
    case "enter":
    case "leave":
      return "";
  }
};

/** The report body: the plaintext goes along only with the explicit opt-in, and only for an event. */
export const reportBody = (companionId: string, r: ReportInput) =>
  RoomReportRequest.parse({
    companionId,
    ...(r.eventId ? { eventId: r.eventId } : {}),
    ...(r.memberCompanionId ? { memberCompanionId: r.memberCompanionId } : {}),
    reason: r.reason,
    ...(r.note?.trim() ? { note: r.note.trim().slice(0, 500) } : {}),
    ...(r.eventId && r.attachText ? { attachedPlaintext: r.attachText.slice(0, 4000), attachPlaintext: true } : {}),
  });

const errorOf = (err: unknown): RoomError => {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 429) return "rate_limited";
  if (status === 403) return "not_member";
  if (status === 404) return "not_found";
  return "failed";
};

type Rows = PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>;
type Reads = {
  from(t: string): {
    select(c: string): { eq(c: string, v: unknown): Rows & { eq(c: string, v: unknown): Rows } };
  };
};
const rowsOf = async (q: Rows) => {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
};
const ms = (v: string | number) => new Date(v).getTime();

export interface RoomListItem extends RoomSummary {
  memberCount: number;
  /** Someone else posted after `seen(roomId)`. */
  unread: boolean;
}

/**
 * The rooms list with what a list needs: member count and an unread dot (an event from another
 * companion above the rev this device last showed). Metadata only: nothing is decrypted here.
 */
export const roomList = async (
  db: RoomsDb,
  companionId: string,
  seen: (roomId: string) => number,
): Promise<RoomListItem[]> => {
  const d = db as unknown as Reads & {
    from(t: "room_events"): {
      select(c: string): {
        eq(c: string, v: unknown): { gt(c: string, v: number): { order(c: string, o: { ascending: boolean }): Rows } };
      };
    };
  };
  const out: RoomListItem[] = [];
  for (const r of await myRooms(db, companionId)) {
    const members = await rowsOf(d.from("room_members").select("companion_id").eq("room_id", r.roomId));
    const newer = await rowsOf(
      d
        .from("room_events")
        .select("rev, from_companion_id")
        .eq("room_id", r.roomId)
        .gt("rev", seen(r.roomId))
        .order("rev", { ascending: true }),
    );
    out.push({ ...r, memberCount: members.length, unread: newer.some((e) => e.from_companion_id !== companionId) });
  }
  return out;
};

export type JoinError = "bad_code" | "full" | "rate_limited" | "failed";

/** Join with a typed invite code. The room key is wrapped to this device next, by a member. */
export const joinRoom = async (
  api: RoomApiClient,
  companionId: string,
  shortCode: string,
): Promise<{ ok: true; roomId: string } | { ok: false; reason: JoinError }> => {
  const code = shortCode.trim();
  if (code.length < 8 || code.length > 20) return { ok: false, reason: "bad_code" };
  try {
    const r = await api.post<{ roomId: string }>("/v1/rooms/join", { companionId, shortCode: code });
    return { ok: true, roomId: r.roomId };
  } catch (err) {
    const status = (err as { status?: unknown } | null)?.status;
    // An unknown, used-up or expired invite: 400/404/410; the owner's plan caps members: 402.
    if (status === 400 || status === 404 || status === 410) return { ok: false, reason: "bad_code" };
    if (status === 402) return { ok: false, reason: "full" };
    if (status === 429) return { ok: false, reason: "rate_limited" };
    return { ok: false, reason: "failed" };
  }
};

/** The rooms this companion belongs to (RLS: its own memberships), by name. */
export const myRooms = async (db: RoomsDb, companionId: string): Promise<RoomSummary[]> => {
  const d = db as unknown as Reads;
  const mine = await rowsOf(d.from("room_members").select("room_id").eq("companion_id", companionId));
  const out: RoomSummary[] = [];
  for (const m of mine) {
    const [r] = await rowsOf(d.from("rooms").select("room_id, name, type").eq("room_id", m.room_id));
    if (r) out.push({ roomId: String(r.room_id), name: String(r.name), type: String(r.type) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};
const ENDED: ReadonlySet<RoomStatus> = new Set(["not_member", "kicked", "dissolved", "revoked"]);

export class RoomController {
  #snap: RoomSnapshot = { status: "loading", room: null, members: [], events: [] };
  readonly #listeners = new Set<() => void>();
  readonly #rows = new Map<string, RoomEventRow>();
  #keyring: ReadonlyMap<number, Uint8Array> = new Map();
  /** Epochs we re-read the key rows for (once each), after a rekey. */
  readonly #refetched = new Set<number>();
  #feed: RoomFeed | null = null;
  readonly #now: () => number;
  readonly #newEid: () => string;

  constructor(private readonly d: RoomControllerDeps) {
    this.#now = d.now ?? Date.now;
    this.#newEid = d.newEid ?? (() => `evt_${crypto.randomUUID().replace(/-/g, "")}`);
  }

  subscribe = (l: () => void): (() => void) => {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  };
  getSnapshot = (): RoomSnapshot => this.#snap;

  get ended(): boolean {
    return ENDED.has(this.#snap.status);
  }

  async start(): Promise<void> {
    try {
      if (!(await this.#readRoom())) return this.#end("not_member");
      await this.#loadKeys();
      if (this.ended) return;
      this.#feed = new RoomFeed(
        this.d.db,
        this.d.roomId,
        (rows) => void this.#onRows(rows),
        (status) => this.#onFeedStatus(status),
        { companionId: this.d.companionId },
      );
      await this.#feed.start();
      if (!this.ended) this.#set({ status: "live" });
    } catch {
      if (!this.ended) this.#set({ status: "error" });
    }
  }

  async stop(): Promise<void> {
    await this.#feed?.stop();
    this.#feed = null;
  }

  /** The app's LiveStore went `revoked`: stop, and forget the keys and everything decrypted. */
  async revoke(): Promise<void> {
    this.#keyring = new Map();
    this.#rows.clear();
    await this.#end("revoked", true);
  }

  /** Drops events past their expiry (call on a timer: the server purges later). */
  prune(): void {
    const now = this.#now();
    const events = this.#snap.events.filter((e) => e.expiresAt === null || e.expiresAt > now);
    if (events.length !== this.#snap.events.length) this.#set({ events });
  }

  /** Seals a notice with the newest epoch this device holds and posts it. */
  async postNotice(text: string): Promise<{ ok: true } | { ok: false; reason: RoomError }> {
    if (this.ended) return { ok: false, reason: "ended" };
    const epoch = Math.max(0, ...this.#keyring.keys());
    const key = this.#keyring.get(epoch);
    if (!key) return { ok: false, reason: "no_key" };
    try {
      const req = await sealRoomEvent({
        roomId: this.d.roomId,
        epoch,
        key,
        eid: this.#newEid(),
        companionId: this.d.companionId,
        body: { kind: "notice", text },
      });
      await this.d.api.post(`/v1/rooms/${encodeURIComponent(this.d.roomId)}/events`, req);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: errorOf(err) };
    }
  }

  async leave(): Promise<{ ok: true } | { ok: false; reason: RoomError }> {
    try {
      await this.d.api.post(`/v1/rooms/${encodeURIComponent(this.d.roomId)}/leave`, {
        companionId: this.d.companionId,
      });
      await this.#end("kicked");
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: errorOf(err) };
    }
  }

  /** Works after the room ended too (a member may report what made them leave). */
  async report(r: ReportInput): Promise<{ ok: true; duplicate: boolean } | { ok: false; reason: RoomError }> {
    try {
      const res = await this.d.api.post<{ duplicate?: boolean } | undefined>(
        `/v1/rooms/${encodeURIComponent(this.d.roomId)}/reports`,
        reportBody(this.d.companionId, r),
      );
      return { ok: true, duplicate: res?.duplicate === true };
    } catch (err) {
      return { ok: false, reason: errorOf(err) };
    }
  }

  async #readRoom(): Promise<boolean> {
    const db = this.d.db as unknown as Reads;
    const [r] = await rowsOf(db.from("rooms").select("room_id, name, type").eq("room_id", this.d.roomId));
    if (!r) return false;
    const members = (
      await rowsOf(db.from("room_members").select("companion_id, role").eq("room_id", this.d.roomId))
    ).map((m) => ({
      companionId: String(m.companion_id),
      role: m.role === "owner" ? ("owner" as const) : ("member" as const),
      me: m.companion_id === this.d.companionId,
    }));
    if (!members.some((m) => m.me)) return false;
    this.#set({ room: { roomId: this.d.roomId, name: String(r.name), type: String(r.type) }, members });
    return true;
  }

  async #loadKeys(): Promise<void> {
    const db = this.d.db as unknown as Reads;
    const rows = (
      await rowsOf(
        db.from("room_member_keys").select("epoch, ct").eq("room_id", this.d.roomId).eq("device_id", this.d.deviceId),
      )
    ).map((r) => ({ epoch: Number(r.epoch), ct: String(r.ct) }));
    this.#keyring = await this.d.keyring(rows);
  }

  async #onRows(rows: RoomEventRow[]): Promise<void> {
    if (this.ended) return;
    try {
      // A rekey: the new epoch's wrapped key arrived after we loaded ours. Re-read once per epoch.
      const missing = rows.map((r) => r.key_epoch).find((e) => !this.#keyring.has(e) && !this.#refetched.has(e));
      if (missing !== undefined) {
        this.#refetched.add(missing);
        await this.#loadKeys();
      }
      if (rows.some((r) => r.kind === "enter" || r.kind === "leave")) await this.#readRoom();
      for (const r of rows) this.#rows.set(r.eid, r);
      await this.#render();
    } catch {
      if (!this.ended) this.#set({ status: "error" });
    }
  }

  async #render(): Promise<void> {
    const now = this.#now();
    const out: RoomEventView[] = [];
    for (const r of this.#rows.values()) {
      if (!isVisible(r, now)) continue;
      const body = await openRoomEvent(r, this.#keyring);
      out.push({
        eid: r.eid,
        from: r.from_companion_id,
        to: r.to_companions ?? [],
        kind: r.kind,
        t: ms(r.t),
        text: body ? bodyText(body) : null,
        promoted: r.promoted,
        expiresAt: r.expires_at === null ? null : ms(r.expires_at),
      });
    }
    if (this.ended) return;
    this.#set({ events: out.sort((a, b) => a.t - b.t) });
    const top = Math.max(0, ...[...this.#rows.values()].map((r) => Number(r.rev)));
    if (top > 0) this.d.onSeen?.(top);
  }

  #onFeedStatus(status: string): void {
    if (status === "KICKED") void this.#end("kicked");
    else if (status === "DISSOLVED") void this.#end("dissolved");
    else if ((status === "CHANNEL_ERROR" || status === "READ_ERROR") && !this.ended) this.#set({ status: "error" });
    else if (status === "SUBSCRIBED" && this.#snap.status === "error") this.#set({ status: "live" });
  }

  async #end(status: RoomStatus, clear = false): Promise<void> {
    if (this.ended && !clear) return;
    this.#set({ status, ...(clear ? { events: [], members: [] } : {}) });
    await this.stop();
  }

  #set(p: Partial<RoomSnapshot>): void {
    this.#snap = { ...this.#snap, ...p };
    for (const l of this.#listeners) l();
  }
}
