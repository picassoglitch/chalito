import { useId, useState, type FormEvent } from "react";
import type { ReactNode } from "react";
import type {
  ReportInput,
  RoomError,
  RoomEventView,
  RoomInvite,
  RoomMemberView,
  RoomRetentionView,
} from "@chalito/rooms";
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
  onRemove,
}: {
  members: readonly RoomMemberView[];
  onReport?: (companionId: string) => void;
  /** "Quitar de la sala": pass it only when this companion owns the room. Never on yourself or the owner. */
  onRemove?: (companionId: string) => Promise<RoomError | null>;
}) => {
  const { t } = useUiText();
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RoomError | null>(null);
  const remove = async (id: string) => {
    if (!onRemove) return;
    setBusy(true);
    const err = await onRemove(id);
    setBusy(false);
    setError(err);
    if (!err) setAsking(null);
  };
  return (
    <div className="grid gap-1">
      <ul className="grid gap-1" aria-label={t("rooms.members")}>
        {members.map((m) => (
          <li
            key={m.companionId}
            data-testid="room-member"
            data-companion={m.companionId}
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <span>{memberLabel(m.companionId, m.me, t)}</span>
            {m.role === "owner" ? <span className="text-xs text-neutral-600">{t("rooms.owner")}</span> : null}
            <span className="ml-auto flex items-center gap-3">
              {onRemove && !m.me && m.role !== "owner" ? (
                asking === m.companionId ? (
                  <span className="flex items-center gap-2 text-xs">
                    {t("rooms.removeConfirm", { member: memberLabel(m.companionId, false, t) })}
                    <button
                      type="button"
                      className="rounded bg-red-700 px-2 py-0.5 text-white disabled:opacity-50"
                      disabled={busy}
                      onClick={() => void remove(m.companionId)}
                    >
                      {t("rooms.removeYes")}
                    </button>
                    <button type="button" className="rounded border px-2 py-0.5" onClick={() => setAsking(null)}>
                      {t("rooms.cancel")}
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="text-xs text-red-800 underline"
                    onClick={() => (setError(null), setAsking(m.companionId))}
                  >
                    {t("rooms.remove")}
                  </button>
                )
              ) : null}
              {onReport && !m.me ? (
                <button
                  type="button"
                  className="text-xs text-red-800 underline"
                  onClick={() => onReport(m.companionId)}
                >
                  {t("rooms.report")}
                </button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="text-sm text-red-800">
          {t(`rooms.error.${error}`)}
        </p>
      ) : null}
    </div>
  );
};

/** Event lifetimes the owner can pick (rooms.yaml allowedEphemeralTtl; the database checks the same list). */
export const ROOM_TTLS = ["PT1H", "PT24H", "P7D", "P30D", "until_dissolved"] as const;
export const ROOM_TYPES = ["family", "business", "project"] as const;
export type RoomTypeId = (typeof ROOM_TYPES)[number];

/** "Nueva sala": a name and a type; the shell creates it (createRoom) and opens it. */
export const NewRoomForm = ({
  onCreate,
}: {
  /** Resolves to null when created (the shell navigates), or an error key under rooms.create.error. */
  onCreate: (name: string, type: RoomTypeId) => Promise<string | null>;
}) => {
  const { t } = useUiText();
  const nameId = useId();
  const typeId = useId();
  const [name, setName] = useState("");
  const [type, setType] = useState<RoomTypeId>("family");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      data-testid="room-new"
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        setError(null);
        void onCreate(name.trim(), type).then((err) => {
          setBusy(false);
          setError(err);
        });
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor={nameId} className="grid gap-1">
          <span className="text-sm font-medium">{t("rooms.create.name")}</span>
          <input
            id={nameId}
            className="rounded-lg border px-3 py-2"
            maxLength={60}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label htmlFor={typeId} className="grid gap-1">
          <span className="text-sm font-medium">{t("rooms.create.type")}</span>
          <select
            id={typeId}
            className="rounded-lg border px-3 py-2"
            value={type}
            onChange={(e) => setType(e.target.value as RoomTypeId)}
          >
            {ROOM_TYPES.map((x) => (
              <option key={x} value={x}>
                {t(`rooms.types.${x}`)}
              </option>
            ))}
          </select>
        </label>
        <button
          className="rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50"
          disabled={busy || !name.trim()}
        >
          {t("rooms.create.submit")}
        </button>
      </div>
      {error ? (
        <p role="alert" data-testid="room-new-error" className="text-sm text-red-800">
          {t(`rooms.create.error.${error}`)}
        </p>
      ) : null}
    </form>
  );
};

/** "Invitar": a new invite's glyph (drawn by the shell) and short code, with its expiry. */
export const RoomInvitePanel = ({
  onInvite,
  renderGlyph,
}: {
  onInvite: () => Promise<{ ok: true; invite: RoomInvite } | { ok: false; reason: RoomError }>;
  /** The shell's glyph canvas. */
  renderGlyph: (glyph: RoomInvite["glyph"]) => ReactNode;
}) => {
  const { t, locale } = useUiText();
  const [invite, setInvite] = useState<RoomInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RoomError | null>(null);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  return (
    <div className="grid gap-2" data-testid="room-invite">
      <button
        type="button"
        className="w-fit rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void onInvite().then((r) => {
            setBusy(false);
            if (r.ok) setInvite(r.invite);
            else setError(r.reason);
          });
        }}
      >
        {invite ? t("rooms.invite.again") : t("rooms.invite.create")}
      </button>
      {invite ? (
        <div className="grid gap-2 rounded-lg border bg-white p-3">
          <p className="text-sm">{t("rooms.invite.how")}</p>
          {renderGlyph(invite.glyph)}
          <p className="font-mono text-2xl tracking-widest" data-testid="room-invite-code">
            {invite.shortCode}
          </p>
          <p className="text-xs text-neutral-600">
            {t("rooms.invite.expires", { date: date.format(invite.expiresAt) })}
          </p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-800">
          {t(`rooms.error.${error}`)}
        </p>
      ) : null}
    </div>
  );
};

/** Someone left or was removed: posting is refused until a remaining member rotates the key. */
export const RoomRotation = ({ onRotate }: { onRotate: () => Promise<RoomError | null> }) => {
  const { t } = useUiText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RoomError | null>(null);
  return (
    <div role="status" data-testid="room-rotation" className="grid gap-2 rounded-lg bg-amber-50 p-3 text-amber-900">
      <p>{t("rooms.rotation.why")}</p>
      <button
        type="button"
        className="w-fit rounded-lg bg-amber-800 px-3 py-1.5 text-white disabled:opacity-50"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void onRotate().then((err) => {
            setBusy(false);
            setError(err);
          });
        }}
      >
        {t("rooms.rotation.rotate")}
      </button>
      {error ? <p role="alert">{t(`rooms.error.${error}`)}</p> : null}
    </div>
  );
};

/** The owner's settings: how long events last, whether promoted records stay, and dissolving. */
export const RoomOwnerSettings = ({
  retention,
  onRetention,
  onDissolve,
}: {
  retention: RoomRetentionView;
  onRetention: (r: RoomRetentionView) => Promise<RoomError | null>;
  onDissolve: () => Promise<RoomError | null>;
}) => {
  const { t } = useUiText();
  const ttlId = useId();
  const [ttl, setTtl] = useState(retention.ephemeralTtl);
  const [keep, setKeep] = useState(retention.keepPromoted);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<RoomError | null>(null);
  const [confirm, setConfirm] = useState(false);
  const run = async (fn: () => Promise<RoomError | null>, after?: () => void) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const err = await fn();
    setBusy(false);
    setError(err);
    if (!err) after?.();
  };
  const changed = ttl !== retention.ephemeralTtl || keep !== retention.keepPromoted;
  return (
    <section className="grid gap-3 rounded-lg border p-3" data-testid="room-owner">
      <h2 className="font-semibold">{t("rooms.ownerTitle")}</h2>
      <label htmlFor={ttlId} className="grid gap-1 text-sm">
        <span className="font-medium">{t("rooms.retention.ttl")}</span>
        <select
          id={ttlId}
          className="w-fit rounded-lg border px-3 py-2"
          value={ttl}
          onChange={(e) => setTtl(e.target.value)}
        >
          {ROOM_TTLS.map((x) => (
            <option key={x} value={x}>
              {t(`rooms.retention.ttls.${x}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
        {t("rooms.retention.keepPromoted")}
      </label>
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="w-fit rounded-lg bg-emerald-700 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          disabled={busy || !changed}
          onClick={() =>
            void run(
              () => onRetention({ ephemeralTtl: ttl, keepPromoted: keep }),
              () => setSaved(true),
            )
          }
        >
          {t("rooms.retention.save")}
        </button>
        {saved ? (
          <span role="status" data-testid="room-retention-saved" className="text-sm text-emerald-800">
            {t("rooms.retention.saved")}
          </span>
        ) : null}
      </div>
      {confirm ? (
        <div className="grid gap-2 rounded-md bg-red-50 p-3 text-sm text-red-900">
          <p>{t("rooms.dissolve.confirm")}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded bg-red-700 px-3 py-1 text-white disabled:opacity-50"
              disabled={busy}
              onClick={() => void run(onDissolve, () => setConfirm(false))}
            >
              {t("rooms.dissolve.yes")}
            </button>
            <button type="button" className="rounded border px-3 py-1" onClick={() => setConfirm(false)}>
              {t("rooms.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="w-fit rounded-lg border border-red-800 px-3 py-1.5 text-sm text-red-900"
          onClick={() => setConfirm(true)}
        >
          {t("rooms.dissolve.button")}
        </button>
      )}
      {error ? (
        <p role="alert" className="text-sm text-red-800">
          {t(`rooms.error.${error}`)}
        </p>
      ) : null}
    </section>
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
