import {
  joinRoom,
  roomList,
  type JoinError,
  type RoomApiClient,
  type RoomListItem,
  type RoomsDb,
} from "@chalito/rooms";
import type { SeenStore } from "./room-seen.js";

/** What the panel's Salas tab needs; the room itself opens in the room window. */
export interface RoomsSource {
  list(): Promise<RoomListItem[]>;
  join(code: string): Promise<{ ok: true; roomId: string } | { ok: false; reason: JoinError | "no_companion" }>;
  open(roomId: string): Promise<void>;
}

export const roomsSource = (o: {
  db: RoomsDb;
  api: RoomApiClient;
  /** Looked up once, lazily (the companion row exists once the account is set up). */
  companionId: () => Promise<string | null>;
  seen: SeenStore;
  open: (roomId: string) => Promise<void>;
}): RoomsSource => {
  let companion: Promise<string | null> | null = null;
  const me = () => (companion ??= o.companionId().then((c) => (c ? c : ((companion = null), null))));
  return {
    list: async () => {
      const c = await me();
      return c ? roomList(o.db, c, (id) => o.seen.get(id)) : [];
    },
    join: async (code) => {
      const c = await me();
      return c ? joinRoom(o.api, c, code) : { ok: false, reason: "no_companion" };
    },
    open: o.open,
  };
};
