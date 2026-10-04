import { useId, useState, type FormEvent } from "react";
import type { ReportInput, RoomError, RoomEventView, RoomMemberView } from "@chalito/rooms";
import { useUiText } from "./text.js";

/**
 * Room screens (ADR 0010), shared by the PWA and the desktop window. Props only: the shell owns a
 * @chalito/rooms RoomController and passes its snapshot and actions. Everything a room event says
 * is shown as quoted TEXT, never markup and never as instructions (room events carry data only).
 * Strings live under `settings.rooms` in messages/*.json.
 */

export type ReportReason = ReportInput["reason"];

/** What a report is about; `text` is the reporter's own decrypted copy (attached only on opt-in). */
export interface ReportTarget {
  eventId?: string;
  memberCompanionId?: string;
  text?: string | null;
}

/** Why the feed stopped: the controller's ended statuses, plus "left" when this person left. */
export type RoomEndReason = "left" | "kicked" | "dissolved" | "revoked" | "not_member";

/** "Tú", or a short stable label for another family's companion (names aren't shared across owners). */
export const memberLabel = (
  companionId: string,
  me: boolean,
  t: (k: string, v?: Record<string, string | number>) => string,
) => (me ? t("rooms.you") : t("rooms.member", { id: companionId.slice(4, 8).toUpperCase() }));

export const RoomEventList = ({
  events,
  me,
  onReport,
}: {
  events: readonly RoomEventView[];
  /** This person's companion id (their own events get no "Reportar"). */
  me: string;
  onReport?: (eid: string) => void;
}) => {
  const { t, locale } = useUiText();
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  if (!events.length) return <p className="text-sm text-neutral-600">{t("rooms.empty")}</p>;
  return (
    <ol className="grid gap-2" aria-label={t("rooms.feed")}>
      {events.map((e) => (
        <li key={e.eid} data-testid="room-event" data-eid={e.eid} className="grid gap-1 rounded-lg border bg-white p-3">
          <div className="flex items-center gap-2 text-xs text-neutral-600">
            <span className="font-medium">{memberLabel(e.from, e.from === me, t)}</span>
            <span>{t(`rooms.kind.${e.kind}`)}</span>
            <time className="ml-auto" dateTime={new Date(e.t).toISOString()}>
              {time.format(e.t)}
            </time>
          </div>
          {e.text === null ? (
            <p className="text-sm italic text-neutral-500">{t("rooms.sealed")}</p>
          ) : e.text ? (
            // Quoted data: rendered as text (React escapes it), whitespace kept, never HTML.
            <blockquote data-testid="room-event-text" className="whitespace-pre-wrap break-words border-l-2 pl-2">
              {e.text}
            </blockquote>
          ) : null}
          {onReport && e.from !== me ? (
            <button type="button" className="w-fit text-xs text-red-800 underline" onClick={() => onReport(e.eid)}>
              {t("rooms.report")}
            </button>
          ) : null}
        </li>
      ))}
    </ol>
  );
};

export const RoomMembers = ({
  members,
  onReport,
}: {
  members: readonly RoomMemberView[];
  onReport?: (companionId: string) => void;
}) => {
  const { t } = useUiText();
  return (
    <ul className="grid gap-1" aria-label={t("rooms.members")}>
      {members.map((m) => (
        <li
          key={m.companionId}
          data-testid="room-member"
          data-companion={m.companionId}
          className="flex items-center gap-2 text-sm"
        >
          <span>{memberLabel(m.companionId, m.me, t)}</span>
          {m.role === "owner" ? <span className="text-xs text-neutral-600">{t("rooms.owner")}</span> : null}
          {onReport && !m.me ? (
            <button
              type="button"
              className="ml-auto text-xs text-red-800 underline"
              onClick={() => onReport(m.companionId)}
            >
              {t("rooms.report")}
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
};

/** Posts a notice (the only thing a person writes here; 500 characters, like the protocol). */
export const RoomComposer = ({
  onSend,
  disabled,
}: {
  /** Resolves to null when sent, or why not. */
  onSend: (text: string) => Promise<RoomError | null>;
  disabled?: boolean;
}) => {
  const { t } = useUiText();
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RoomError | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    setBusy(true);
    const err = await onSend(v);
    setError(err);
    if (!err) setText("");
    setBusy(false);
  };
  return (
    <form className="grid gap-1" onSubmit={(e) => void submit(e)}>
      <div className="flex gap-2">
        <label htmlFor={id} className="sr-only">
          {t("rooms.composer")}
        </label>
        <input
          id={id}
          data-testid="room-composer"
          className="min-w-0 flex-1 rounded-lg border px-3 py-2"
          maxLength={500}
          placeholder={t("rooms.composer")}
          value={text}
          disabled={disabled || busy}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          className="rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50"
          disabled={disabled || busy || !text.trim()}
        >
          {t("rooms.send")}
        </button>
      </div>
      {error ? (
        <p role="alert" data-testid="room-composer-error" className="text-sm text-red-800">
          {t(`rooms.error.${error}`)}
        </p>
      ) : null}
    </form>
  );
};

/**
 * Report an event or a member. The decrypted text goes along ONLY if the person ticks the box
 * (off by default, and only offered for an event they could read).
 */
export const RoomReportDialog = ({
  target,
  label,
  onSubmit,
  onCancel,
}: {
  target: ReportTarget;
  /** What is being reported, for the person ("Aviso · Miembro ABCD"). */
  label?: string;
  onSubmit: (r: ReportInput) => Promise<void>;
  onCancel: () => void;
}) => {
  const { t } = useUiText();
  const [reason, setReason] = useState<ReportReason>("spam");
  const [note, setNote] = useState("");
  const [attach, setAttach] = useState(false);
  const [busy, setBusy] = useState(false);
  const canAttach = !!target.eventId && !!target.text;
  return (
    <form
      role="dialog"
      aria-label={t("rooms.reportTitle")}
      data-testid="room-report"
      className="grid gap-3 rounded-xl border border-red-200 bg-red-50 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void onSubmit({
          ...(target.eventId ? { eventId: target.eventId } : {}),
          ...(target.memberCompanionId ? { memberCompanionId: target.memberCompanionId } : {}),
          reason,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(canAttach && attach ? { attachText: target.text! } : {}),
        }).finally(() => setBusy(false));
      }}
    >
      <p className="font-semibold">{t("rooms.reportTitle")}</p>
      {label ? <p className="text-sm">{label}</p> : null}
      <fieldset className="grid gap-1">
        <legend className="text-sm font-medium">{t("rooms.reason")}</legend>
        {(["spam", "abuse", "impersonation", "other"] as const).map((r) => (
          <label key={r} className="flex items-center gap-2 text-sm">
            <input type="radio" name="reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
            {t(`rooms.reasons.${r}`)}
          </label>
        ))}
      </fieldset>
      <label className="grid gap-1 text-sm">
        <span className="font-medium">{t("rooms.note")}</span>
        <textarea
          className="rounded-lg border px-3 py-2"
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {canAttach ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="room-report-attach"
            checked={attach}
            onChange={(e) => setAttach(e.target.checked)}
          />
          <span>{t("rooms.attach")}</span>
        </label>
      ) : null}
      <div className="flex gap-2">
        <button className="rounded-lg bg-red-700 px-4 py-2 text-white disabled:opacity-50" disabled={busy}>
          {t("rooms.reportSend")}
        </button>
        <button type="button" className="rounded-lg border px-4 py-2" onClick={onCancel}>
          {t("rooms.cancel")}
        </button>
      </div>
    </form>
  );
};

/** The feed stopped: say why (review R-L14). */
export const RoomEnded = ({ status }: { status: RoomEndReason }) => {
  const { t } = useUiText();
  return (
    <p role="alert" data-testid="room-ended" data-reason={status} className="rounded-lg bg-neutral-100 p-4">
      {t(`rooms.ended.${status}`)}
    </p>
  );
};

/** "Unirse con código": the typed short code of an invite. */
export const JoinRoomForm = ({ onJoin }: { onJoin: (code: string) => Promise<void> }) => {
  const { t } = useUiText();
  const id = useId();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void onJoin(code.trim()).finally(() => setBusy(false));
      }}
    >
      <label htmlFor={id} className="grid gap-1">
        <span className="text-sm font-medium">{t("rooms.joinLabel")}</span>
        <input
          id={id}
          data-testid="room-join-code"
          className="rounded-lg border px-3 py-2 font-mono uppercase tracking-widest"
          autoComplete="off"
          maxLength={12}
          placeholder="XXXX-XXXX"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </label>
      <button
        className="rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50"
        disabled={busy || code.trim().length < 8}
      >
        {t("rooms.join")}
      </button>
    </form>
  );
};
