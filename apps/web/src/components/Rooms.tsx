"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { JoinRoomForm } from "@chalito/ui";
import { Link, useRouter } from "@/i18n/navigation";
import { joinRoom, roomList, type RoomListItem, type RoomsDb } from "@chalito/rooms";
import { seenRev } from "@/lib/room-seen";
import { useChalito } from "./ChalitoProvider";

/** /salas: the rooms this companion is in, and "Unirse con código". */
export const Rooms = () => {
  const t = useTranslations("settings.rooms");
  const { rooms, readCompanion } = useChalito();
  const router = useRouter();
  const [me, setMe] = useState<string | null | undefined>(undefined);
  const [list, setList] = useState<RoomListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rooms || !readCompanion) return;
    let alive = true;
    void (async () => {
      const c = await readCompanion();
      if (!alive) return;
      const id = c && c !== "error" ? c.companionId : null;
      setMe(id);
      if (id) setList(await roomList(rooms.db as RoomsDb, id, seenRev).catch(() => []));
    })();
    return () => {
      alive = false;
    };
  }, [rooms, readCompanion]);

  if (!rooms || me === undefined) return <p aria-live="polite">…</p>;
  return (
    <div className="grid gap-4" data-testid="rooms">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p className="text-sm text-neutral-600">{t("intro")}</p>
      {me === null ? (
        <p data-testid="room-no-companion">{t("noCompanion")}</p>
      ) : (
        <>
          {list && list.length ? (
            <ul className="grid gap-2">
              {list.map((r) => (
                <li key={r.roomId}>
                  <Link
                    href={{ pathname: "/r/[id]", params: { id: r.roomId } }}
                    className="block rounded-xl border bg-white p-3 font-medium"
                    data-testid="room-link"
                  >
                    <span className="flex items-center gap-2">
                      {r.name}
                      <span className="text-xs font-normal text-neutral-600">
                        {t("memberCount", { n: r.memberCount })}
                      </span>
                      {r.unread ? (
                        <span
                          data-testid="room-unread"
                          className="ml-auto rounded-full bg-emerald-700 px-2 text-xs text-white"
                        >
                          {t("unread")}
                        </span>
                      ) : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-neutral-600">{t("none")}</p>
          )}
          <section className="grid gap-2">
            <h2 className="font-semibold">{t("joinTitle")}</h2>
            <JoinRoomForm
              onJoin={async (code) => {
                setError(null);
                const r = await joinRoom(rooms.api, me, code);
                if (r.ok) router.push({ pathname: "/r/[id]", params: { id: r.roomId } });
                else setError(t(`error.${r.reason}`));
              }}
            />
            {error ? (
              <p role="alert" data-testid="room-join-error" className="text-sm text-red-800">
                {error}
              </p>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
};
