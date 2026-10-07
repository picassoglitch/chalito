import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { RoomController, myRooms, type RoomSummary } from "@chalito/rooms";
import { useT } from "../lib/i18n.js";
import type { RoomWindowDeps } from "../lib/room-window.js";
import { roomSeen } from "../lib/room-seen.js";
import type { DesktopShell } from "../lib/shell.js";
import { RoomBody } from "./RoomBody.js";
import { sceneMembersFor } from "./scene-members.js";
import { companionCardSource, roomCardsSource } from "../lib/custom-card.js";

const noSub = () => () => undefined;
const none = () => undefined;

export interface RoomWindowProps {
  /** Null until the panel has signed in and enrolled this device. */
  deps: RoomWindowDeps | null;
  shell: Pick<DesktopShell, "onOpenRoom" | "onDeviceRevoked">;
  listRooms?: (deps: RoomWindowDeps) => Promise<RoomSummary[]>;
  controllerFor?: (deps: RoomWindowDeps, roomId: string) => RoomController;
  /** How often expired events are dropped from view. */
  pruneMs?: number;
  /** The room scene (off where there's no WebGL, e.g. tests). */
  stage?: boolean;
}

const seen = roomSeen();
const defaultController = (deps: RoomWindowDeps, roomId: string) =>
  new RoomController({ ...deps, roomId, onSeen: (rev) => seen.mark(roomId, rev) });

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
  stage = true,
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
  // This companion's own custom card (signed URLs kept fresh) for the stage, while a room is open.
  const myCard = useMemo(
    () => (deps?.companionCard && controller && stage ? companionCardSource(async () => deps) : null),
    [deps, controller, stage],
  );
  useEffect(() => () => myCard?.dispose(), [myCard]);
  useSyncExternalStore(myCard?.subscribe ?? noSub, myCard?.getSnapshot ?? none, none);
  // Co-members' custom cards in the open room.
  const roomCards = useMemo(
    () => (deps?.roomCards && roomId && controller && stage ? roomCardsSource(deps.roomCards, roomId) : null),
    [deps, roomId, controller, stage],
  );
  useEffect(() => () => roomCards?.dispose(), [roomCards]);
  const membersSeen = useRef<string | null>(null);
  useSyncExternalStore(roomCards?.subscribe ?? noSub, roomCards?.getSnapshot ?? none, none);
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
        <RoomPane
          controller={controller}
          me={deps!.companionId}
          resolveMembers={(m) => {
            // Someone joined or left: ask again whether they wear a custom character (only then:
            // a refresh re-renders, which resolves the members again).
            const key = m.map((x) => x.companionId).join(",");
            if (key !== membersSeen.current) {
              if (membersSeen.current !== null) void roomCards?.refresh();
              membersSeen.current = key;
            }
            return sceneMembersFor(deps!.db, m, deps!.catalog, (x) =>
              x.me ? (myCard?.files() ?? null) : (roomCards?.files(x.companionId) ?? null),
            );
          }}
          stage={stage}
        />
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

const RoomPane = ({
  controller,
  ...rest
}: { controller: RoomController } & Omit<Parameters<typeof RoomBody>[0], "snapshot" | "controller">) => {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return <RoomBody snapshot={snap} controller={controller} {...rest} />;
};
