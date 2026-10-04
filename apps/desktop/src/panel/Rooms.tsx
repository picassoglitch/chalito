import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { RoomListItem } from "@chalito/rooms";
import { useT } from "../lib/i18n.js";
import type { RoomsSource } from "../lib/rooms-source.js";

/**
 * Salas: this companion's rooms (name, member count, an unread dot) with "Abrir" (the room
 * opens in the room window) and joining with an invite code. Metadata only: nothing is
 * decrypted in the panel.
 */
export const Rooms = ({ source, refreshMs = 30_000 }: { source: RoomsSource; refreshMs?: number }) => {
  const t = useT();
  const [rooms, setRooms] = useState<RoomListItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [code, setCode] = useState("");
  const [joinMsg, setJoinMsg] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  const load = useCallback(
    () =>
      source.list().then(
        (r) => (setRooms(r), setFailed(false)),
        () => setFailed(true),
      ),
    [source],
  );
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), refreshMs);
    return () => clearInterval(id);
  }, [load, refreshMs]);

  const join = async (e: FormEvent) => {
    e.preventDefault();
    setJoining(true);
    const r = await source.join(code);
    setJoining(false);
    if (r.ok) {
      setCode("");
      setJoinMsg(t("rooms.joined"));
      await load();
      await source.open(r.roomId);
    } else setJoinMsg(t(`rooms.joinError.${r.reason}`));
  };

  return (
    <div className="stack">
      {failed && <p role="alert">{t("rooms.loadFailed")}</p>}
      {rooms === null && !failed && <p className="muted">{t("rooms.loading")}</p>}
      {rooms?.length === 0 && <p className="muted">{t("rooms.none")}</p>}
      {rooms && rooms.length > 0 && (
        <ul className="list" aria-label={t("rooms.title")}>
          {rooms.map((r) => (
            <li key={r.roomId} className="card row" data-room={r.roomId}>
              {r.unread && <span className="dot" role="img" aria-label={t("rooms.unread")} data-unread />}
              <strong>{r.name}</strong>
              <span className="muted">{t("rooms.members", { n: r.memberCount })}</span>
              <button onClick={() => void source.open(r.roomId)}>{t("rooms.open")}</button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => void join(e)} aria-label={t("rooms.join")}>
        <label>
          {t("rooms.join")}
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            maxLength={20}
            placeholder={t("rooms.codePlaceholder")}
          />
        </label>
        <button type="submit" disabled={joining || code.trim().length < 8}>
          {t("rooms.joinButton")}
        </button>
      </form>
      {joinMsg && <p role="status">{joinMsg}</p>}
    </div>
  );
};
