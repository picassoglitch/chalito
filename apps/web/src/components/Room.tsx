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
import { Link } from "@/i18n/navigation";
import { useChalito, useLive } from "./ChalitoProvider";

type Report = ReportTarget & { label: string };

const LOADING: RoomSnapshot = { status: "loading", room: null, members: [], events: [] };
const noop = () => () => undefined;

/**
 * /r/[id]: one room, driven by @chalito/rooms' RoomController (feed on pointers, this device's room
 * key, events opened and shown as TEXT). It stops and says why when this companion leaves or is
 * removed, the room is dissolved, or this device is revoked (review R-L14).
 */
export const Room = ({ roomId }: { roomId: string }) => {
  const t = useTranslations("settings.rooms");
  const { rooms, readCompanion, deviceId } = useChalito();
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
            api: rooms.api.client,
            keyring: rooms.keyring,
            deviceId,
            companionId: me,
            roomId,
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
