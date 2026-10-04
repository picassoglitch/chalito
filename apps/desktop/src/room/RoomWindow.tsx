import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { RoomController, myRooms, type RoomSummary } from "@chalito/rooms";
import { useT } from "../lib/i18n.js";
import type { RoomWindowDeps } from "../lib/room-window.js";
import type { DesktopShell } from "../lib/shell.js";
import { RoomBody } from "./RoomBody.js";

export interface RoomWindowProps {
  /** Null until the panel has signed in and enrolled this device. */
  deps: RoomWindowDeps | null;
  shell: Pick<DesktopShell, "onOpenRoom" | "onDeviceRevoked">;
  listRooms?: (deps: RoomWindowDeps) => Promise<RoomSummary[]>;
  controllerFor?: (deps: RoomWindowDeps, roomId: string) => RoomController;
  /** How often expired events are dropped from view. */
  pruneMs?: number;
}

const defaultController = (deps: RoomWindowDeps, roomId: string) => new RoomController({ ...deps, roomId });

/**
 * The desktop room window: the rooms this companion is in, and one room at a time through the
 * shared RoomController (feed, KICKED/DISSOLVED, the report API). Event content is quoted plain
 * text. When the panel relays a revoke, the open room forgets its keys and everything decrypted.
 */
export const RoomWindow = ({
  deps,
  shell,
  listRooms = (d) => myRooms(d.db, d.companionId),
  controllerFor = defaultController,
  pruneMs = 30_000,
}: RoomWindowProps) => {
  const t = useT();
  const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);

  useEffect(() => {
    if (!deps || revoked) return;
    let alive = true;
    listRooms(deps)
      .then((r) => alive && setRooms(r))
      .catch(() => alive && setRooms([]));
    return () => {
      alive = false;
    };
  }, [deps, revoked, listRooms]);

  useEffect(() => {
    const offOpen = shell.onOpenRoom((id) => setRoomId(id));
    const offRevoked = shell.onDeviceRevoked(() => setRevoked(true));
    return () => {
      void offOpen.then((f) => f());
      void offRevoked.then((f) => f());
    };
  }, [shell]);

  const controller = useMemo(
    () => (deps && roomId ? controllerFor(deps, roomId) : null),
    [deps, roomId, controllerFor],
  );
  useEffect(() => {
    if (!controller) return;
    void controller.start();
    const id = setInterval(() => controller.prune(), pruneMs);
    return () => {
      clearInterval(id);
      void controller.stop();
    };
  }, [controller, pruneMs]);
  useEffect(() => {
    if (revoked) void controller?.revoke();
  }, [revoked, controller]);

  if (revoked && !controller) return <p role="alert">{t("room.revoked")}</p>;
  if (!deps) return <p className="muted">{t("room.signedOut")}</p>;
  if (controller)
    return (
      <div className="room-window">
        <button type="button" className="link" onClick={() => setRoomId(null)}>
          {t("room.back")}
        </button>
        <RoomPane controller={controller} />
      </div>
    );
  if (rooms === null) return <p className="muted">{t("room.loading")}</p>;
  if (rooms.length === 0) return <p className="muted">{t("room.none")}</p>;
  return (
    <nav aria-label={t("room.list")}>
      <ul className="room-list">
        {rooms.map((r) => (
          <li key={r.roomId}>
            <button type="button" onClick={() => setRoomId(r.roomId)}>
              {r.name}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
};

const RoomPane = ({ controller }: { controller: RoomController }) => {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return <RoomBody snapshot={snap} controller={controller} />;
};
