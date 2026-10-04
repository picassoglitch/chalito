import { useState, type FormEvent } from "react";
import type { ReportInput, RoomController, RoomEventView, RoomSnapshot } from "@chalito/rooms";
import { useT } from "../lib/i18n.js";

/**
 * One room's view. Everything a room event says is rendered as a text node (React escapes it):
 * never markup, never a link, never an action. Stand-in until picassoglitch-37's packages/ui room
 * components (RoomEventList, RoomMembers, RoomComposer, RoomReportDialog, RoomEnded) land; the
 * props here are the controller's snapshot so the swap stays local to this file.
 */
export const RoomBody = ({ snapshot, controller }: { snapshot: RoomSnapshot; controller: RoomController }) => {
  const t = useT();
  const [reporting, setReporting] = useState<
    (Pick<ReportInput, "eventId" | "memberCompanionId"> & { text?: string }) | null
  >(null);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const live = snapshot.status === "live";
  const ended = ["kicked", "dissolved", "revoked", "not_member"].includes(snapshot.status);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const r = await controller.postNotice(text.slice(0, 500));
    if (r.ok) setDraft("");
    else setNotice(t(`room.error.${r.reason}`));
  };

  return (
    <section className="room" aria-label={snapshot.room?.name ?? t("room.title")}>
      <h1>{snapshot.room?.name ?? t("room.title")}</h1>
      {ended && <p role="alert">{t(`room.ended.${snapshot.status}`)}</p>}
      {snapshot.status === "error" && <p role="alert">{t("room.error.failed")}</p>}
      {notice && <p role="status">{notice}</p>}

      <ol className="room-events">
        {snapshot.events.map((e) => (
          <RoomEventItem
            key={e.eid}
            e={e}
            onReport={() => setReporting({ eventId: e.eid, text: e.text ?? undefined })}
          />
        ))}
      </ol>

      {snapshot.members.length > 0 && (
        <ul className="room-members" aria-label={t("room.members")}>
          {snapshot.members.map((m) => (
            <li key={m.companionId}>
              <span>{m.me ? t("room.you") : m.companionId}</span>
              {m.role === "owner" && <span className="muted"> · {t("room.owner")}</span>}
              {!m.me && (
                <button
                  type="button"
                  className="link"
                  onClick={() => setReporting({ memberCompanionId: m.companionId })}
                >
                  {t("room.report")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {live && (
        <form onSubmit={(e) => void send(e)}>
          <label>
            {t("room.compose")}
            <textarea value={draft} maxLength={500} onChange={(e) => setDraft(e.target.value)} />
          </label>
          <button type="submit" disabled={!draft.trim()}>
            {t("room.send")}
          </button>
          <button type="button" className="link" onClick={() => void controller.leave()}>
            {t("room.leave")}
          </button>
        </form>
      )}

      {reporting && (
        <ReportForm
          target={reporting}
          onCancel={() => setReporting(null)}
          onSubmit={async (input) => {
            const r = await controller.report(input);
            setReporting(null);
            setNotice(
              r.ok ? t(r.duplicate ? "room.reported.duplicate" : "room.reported.ok") : t(`room.error.${r.reason}`),
            );
          }}
        />
      )}
    </section>
  );
};

const RoomEventItem = ({ e, onReport }: { e: RoomEventView; onReport: () => void }) => {
  const t = useT();
  if (e.kind === "enter" || e.kind === "leave" || e.kind === "presence") return null;
  return (
    <li className="room-event">
      <span className="muted">{e.from}</span>
      {e.text === null ? <em className="muted">{t("room.unreadable")}</em> : <blockquote>{e.text}</blockquote>}
      <button type="button" className="link" onClick={onReport}>
        {t("room.report")}
      </button>
    </li>
  );
};

const REASONS = ["spam", "abuse", "impersonation", "other"] as const;

const ReportForm = ({
  target,
  onSubmit,
  onCancel,
}: {
  target: Pick<ReportInput, "eventId" | "memberCompanionId"> & { text?: string };
  onSubmit: (r: ReportInput) => Promise<void>;
  onCancel: () => void;
}) => {
  const t = useT();
  const [reason, setReason] = useState<ReportInput["reason"]>("spam");
  const [note, setNote] = useState("");
  // Off by default: the decrypted text leaves this device only if the person ticks it.
  const [attach, setAttach] = useState(false);
  return (
    <form
      aria-label={t("room.report")}
      onSubmit={(e) => {
        e.preventDefault();
        const { text, ...ids } = target;
        void onSubmit({ ...ids, reason, note, ...(attach && ids.eventId && text ? { attachText: text } : {}) });
      }}
    >
      <label>
        {t("room.reportReason")}
        <select value={reason} onChange={(e) => setReason(e.target.value as ReportInput["reason"])}>
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`room.reasons.${r}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("room.reportNote")}
        <textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </label>
      {target.eventId && target.text && (
        <label>
          <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
          {t("room.attachText")}
        </label>
      )}
      <button type="submit">{t("room.reportSend")}</button>
      <button type="button" className="link" onClick={onCancel}>
        {t("room.cancel")}
      </button>
    </form>
  );
};
