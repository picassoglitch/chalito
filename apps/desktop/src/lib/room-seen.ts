/**
 * The highest room event rev this device has shown, per room, for the Salas tab's unread dot.
 * In localStorage, which every window of the app shares (same origin). Best effort: no storage
 * means every room with others' events looks unread.
 */
const KEY = (roomId: string) => `chalito-room-seen:${roomId}`;

export interface SeenStore {
  get(roomId: string): number;
  mark(roomId: string, rev: number): void;
}

export const roomSeen = (storage: Pick<Storage, "getItem" | "setItem"> | null = safeLocalStorage()): SeenStore => ({
  get: (roomId) => {
    const v = Number(storage?.getItem(KEY(roomId)) ?? 0);
    return Number.isFinite(v) && v > 0 ? v : 0;
  },
  mark: (roomId, rev) => {
    try {
      if (rev > Number(storage?.getItem(KEY(roomId)) ?? 0)) storage?.setItem(KEY(roomId), String(rev));
    } catch {
      // Storage full or blocked: the dot just stays.
    }
  },
});

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
