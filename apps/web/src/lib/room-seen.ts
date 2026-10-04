/**
 * The newest event `rev` this browser has shown per room, for the unread markers on /salas
 * (RoomController's onSeen). A per-device convenience: losing it only re-marks rooms as unread.
 */
const KEY = "chalito.rooms.seen.v1";

const read = (): Record<string, number> => {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
};

export const seenRev = (roomId: string): number => {
  const v = read()[roomId];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
};

export const markSeen = (roomId: string, rev: number): void => {
  const all = read();
  if ((all[roomId] ?? 0) >= rev) return;
  all[roomId] = rev;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: unread markers just stay */
  }
};
