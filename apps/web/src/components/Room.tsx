"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { RoomController, type ReportInput, type RoomSnapshot, type RoomsDb } from "@chalito/rooms";
import {
  RoomComposer,
  RoomEnded,
  RoomEventList,
  RoomMembers,
  RoomReportDialog,
  memberLabel,
  type ReportTarget,
  type RoomEndReason,
} from "@chalito/ui";
import type { RoomEventKind } from "@chalito/protocol";
import { DEFAULT_COMPANION, rosterEntry } from "@chalito/roster";
import { Link } from "@/i18n/navigation";
import { markSeen } from "@/lib/room-seen";
import type { StoreItem } from "@/lib/store";
import { useChalito, useLive } from "./ChalitoProvider";
import { RoomStage } from "./RoomStage";

type Report = ReportTarget & { label: string };

type DirDb = {
  from(t: string): {
    select(c: string): PromiseLike<{
      data: { companion_id?: unknown; avatar_thumb?: unknown; equipped?: unknown }[] | null;
      error: unknown;
    }>;
  };
};
type Card = { avatar: string; equipped: string[] };
/**
 * Co-members' public companion cards (chalito.companion_directory, server-written; RLS shows only
 * co-members): roster avatar and equipped cosmetic ids.
 */
const readDirectory = async (db: unknown): Promise<Record<string, Card>> => {
  const { data, error } = await (db as DirDb)
    .from("companion_directory")
    .select("companion_id, avatar_thumb, equipped");
  if (error || !data) return {};
  const out: Record<string, Card> = {};
  for (const r of data)
    if (typeof r.companion_id === "string")
      out[r.companion_id] = {
        avatar: typeof r.avatar_thumb === "string" ? r.avatar_thumb : "",
        equipped: Array.isArray(r.equipped) ? r.equipped.filter((x): x is string => typeof x === "string") : [],
      };
  return out;
};

const LOADING: RoomSnapshot = { status: "loading", room: null, members: [], events: [] };
const noop = () => () => undefined;

/**
 * /r/[id]: one room, driven by @chalito/rooms' RoomController (feed on pointers, this device's room
 * key, events opened and shown as TEXT). It stops and says why when this companion leaves or is
 * removed, the room is dissolved, or this device is revoked (review R-L14).
 */
export const Room = ({ roomId }: { roomId: string }) => {
  const t = useTranslations("settings.rooms");
  const { rooms, readCompanion, deviceId, store } = useChalito();
  const live = useLive();
  const [me, setMe] = useState<string | null | undefined>(undefined);
  const [leftByMe, setLeftByMe] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  useEffect(() => {
    if (!readCompanion) return;
    let alive = true;
    void readCompanion().then((c) => alive && setMe(c && c !== "error" ? c.companionId : null));
    return () => {
      alive = false;
    };
  }, [readCompanion]);

  const ctl = useMemo(
    () =>
      rooms && deviceId && me
        ? new RoomController({
            db: rooms.db as RoomsDb,
            api: rooms.api,
            keyring: rooms.keyring,
            deviceId,
            companionId: me,
            roomId,
            // Unread markers on /salas: the newest event this view has shown.
            onSeen: (rev) => markSeen(roomId, rev),
          })
        : null,
    [rooms, deviceId, me, roomId],
  );
  useEffect(() => {
    if (!ctl) return;
    void ctl.start();
    // Expired events disappear even without new traffic.
    const timer = setInterval(() => ctl.prune(), 30_000);
    return () => {
      clearInterval(timer);
      void ctl.stop();
    };
  }, [ctl]);
  // This device was revoked while connected: the controller drops keys, members and events.
  useEffect(() => {
    if (ctl && live.status === "revoked") void ctl.revoke();
  }, [ctl, live.status]);

  const snap = useSyncExternalStore(ctl?.subscribe ?? noop, ctl?.getSnapshot ?? (() => LOADING), () => LOADING);

  // The stage needs each companion's roster card: ours from the companion row, co-members' from the
  // companion directory (RLS: co-members only); without one, the default companion stands in.
  const [cards, setCards] = useState<Record<string, Card>>({});
  const [catalog, setCatalog] = useState<StoreItem[]>([]);
  const memberKey = snap.members.map((m) => m.companionId).join(",");
  useEffect(() => {
    if (!rooms || !me || !readCompanion) return;
    let alive = true;
    void (async () => {
      // Re-read on membership changes: the directory itself doesn't broadcast.
      const [mine, dir, items] = await Promise.all([
        readCompanion(),
        readDirectory(rooms.db).catch(() => ({}) as Record<string, Card>),
        store ? store.catalog() : Promise.resolve("error" as const),
      ]);
      if (!alive) return;
      if (Array.isArray(items)) setCatalog(items);
      setCards({
        ...dir,
        ...(mine && mine !== "error"
          ? { [mine.companionId]: { avatar: mine.avatar, equipped: Object.values(mine.equipped) } }
          : {}),
      });
    })();
    return () => {
      alive = false;
    };
  }, [rooms, me, readCompanion, store, roomId, memberKey]);
  const stageMembers = useMemo(
    () =>
      snap.members.map((m) => {
        const c = cards[m.companionId];
        return {
          companionId: m.companionId,
          avatar: c && rosterEntry(c.avatar) ? c.avatar : DEFAULT_COMPANION,
          // Equipped cosmetics as the store sells them (slot, art, card placement).
          cosmetics: (c?.equipped ?? []).flatMap((id) => {
            const item = catalog.find((i) => i.id === id);
            return item ? [{ slot: item.slot, art: item.art, card: item.card }] : [];
          }),
        };
      }),
    [snap.members, cards, catalog],
  );
  const stageEvents = useMemo(
    () =>
      snap.events.map((e) => ({
        eid: e.eid,
        fromCompanionId: e.from,
        to: e.to,
        kind: e.kind as RoomEventKind,
        t: e.t,
      })),
    [snap.events],
  );

  if (me === null)
    return (
      <p data-testid="room-no-companion">
        {t("noCompanion")}{" "}
        <Link href="/bienvenida" className="underline">
          →
        </Link>
      </p>
    );
  if (!ctl || snap.status === "loading") return <p aria-live="polite">…</p>;
  if (snap.status === "not_member" || (snap.status === "error" && !snap.room))
    return (
      <p role="alert" data-testid="room-not-found">
        {t("notFound")}
      </p>
    );

  const ended: RoomEndReason | null =
    snap.status === "kicked"
      ? leftByMe
        ? "left"
        : "kicked"
      : snap.status === "dissolved" || snap.status === "revoked"
        ? snap.status
        : null;
  const label = (id: string) => memberLabel(id, id === me, (k, v) => t(k.replace(/^rooms\./, ""), v));

  const send = async (text: string) => {
    setNote(null);
    const r = await ctl.postNotice(text);
    return r.ok ? null : r.reason;
  };
  const leave = async () => {
    setConfirmLeave(false);
    setLeftByMe(true);
    const r = await ctl.leave();
    if (!r.ok) {
      setLeftByMe(false);
      setNote(t(`error.${r.reason}`));
    }
  };
  const sendReport = async (input: ReportInput) => {
    const r = await ctl.report(input);
    setReport(null);
    setNote(r.ok ? t(r.duplicate ? "reportedDup" : "reported") : t(`error.${r.reason}`));
  };

  return (
    <div className="grid gap-4" data-testid="room" data-room={roomId} data-status={snap.status}>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-bold">{snap.room?.name ?? ""}</h1>
        {!ended ? (
          confirmLeave ? (
            <span className="ml-auto flex items-center gap-2 text-sm">
              {t("leaveConfirm")}
              <button className="rounded bg-red-700 px-2 py-1 text-white" onClick={() => void leave()}>
                {t("leaveYes")}
              </button>
              <button className="rounded border px-2 py-1" onClick={() => setConfirmLeave(false)}>
                {t("cancel")}
              </button>
            </span>
          ) : (
            <button className="ml-auto rounded border px-3 py-1 text-sm" onClick={() => setConfirmLeave(true)}>
              {t("leave")}
            </button>
          )
        ) : null}
      </div>
      {ended ? <RoomEnded status={ended} /> : null}
      {report ? (
        <RoomReportDialog target={report} label={report.label} onSubmit={sendReport} onCancel={() => setReport(null)} />
      ) : null}
      {note ? (
        <p role="status" data-testid="room-note" className="text-sm">
          {note}
        </p>
      ) : null}
      {!ended ? <RoomStage roomId={roomId} label={t("stage")} members={stageMembers} events={stageEvents} /> : null}
      <section className="grid gap-2">
        <RoomEventList
          events={snap.events}
          me={me ?? ""}
          onReport={
            snap.status === "revoked"
              ? undefined
              : (eid) => {
                  const e = snap.events.find((x) => x.eid === eid);
                  if (e) setReport({ eventId: eid, text: e.text, label: `${t(`kind.${e.kind}`)} · ${label(e.from)}` });
                }
          }
        />
        {!ended ? <RoomComposer onSend={send} /> : null}
      </section>
      <section className="grid gap-2" aria-labelledby="room-members">
        <h2 id="room-members" className="font-semibold">
          {t("members")}
        </h2>
        <RoomMembers
          members={snap.members}
          onReport={
            snap.status === "revoked" ? undefined : (id) => setReport({ memberCompanionId: id, label: label(id) })
          }
        />
      </section>
    </div>
  );
};
