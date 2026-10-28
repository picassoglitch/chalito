import type { AlertActions, EventView, NotificationView, SessionView } from "@chalito/client";
import { useT } from "../lib/i18n.js";
import { alertReason, noticeSid, type WaitingOn } from "../lib/alert-notice.js";

/** Calmer alerts in the inbox (from Alux, by Omar (homiomar)): why, postpone, and "Esperando a alguien". */

export type Alerts = Pick<AlertActions, "seen" | "waiting" | "snooze" | "available" | "subscribe">;

/** "Parece atorado: `<cmd>` falló 5 veces" / "Parece detenido…" for an agent alert, else nothing. */
export const AlertReasonLine = ({
  n,
  events,
}: {
  n: NotificationView;
  events: Readonly<Record<string, readonly EventView[]>>;
}) => {
  const t = useT();
  const r = alertReason(n, events);
  if (!r) return null;
  const text =
    r.kind === "stalled"
      ? t("alerts.stalled")
      : r.cmd && r.count
        ? t("alerts.stuck", { cmd: r.cmd, count: r.count })
        : t("alerts.stuckPlain");
  return (
    <span data-alert-reason={r.kind} className="muted">
      {text}
    </span>
  );
};

export const NoticeCalmButtons = ({
  n,
  alerts,
  waiting,
  sessions,
  run,
  onChange,
  onOpen,
  available,
}: {
  n: NotificationView;
  alerts: Alerts;
  waiting: WaitingOn;
  sessions: readonly SessionView[];
  run: (p: Promise<void>) => void;
  onChange: () => void;
  /** Opens the session in the Sessions tab, which counts as seen. */
  onOpen?: (sid: string) => void;
  /** The actions exist on this database (as last heard from `alerts.subscribe`). */
  available: boolean;
}) => {
  const t = useT();
  const sid = noticeSid(n);
  return (
    <>
      {sid && onOpen && (
        <button data-open-session onClick={() => onOpen(sid)}>
          {t("alerts.open")}
        </button>
      )}
      {available && (
        <button data-snooze onClick={() => run(alerts.snooze(n.nid))}>
          {t("alerts.snooze")}
        </button>
      )}
      {sid && available && (
        <button
          data-waiting
          onClick={() => {
            waiting.mark(sid, sessions.find((s) => s.sid === sid)?.state);
            onChange();
            // The list must not claim a park the server never got.
            run(
              alerts.waiting(sid, true).catch((e: unknown) => {
                waiting.unmark(sid);
                onChange();
                throw e;
              }),
            );
          }}
        >
          {t("alerts.waiting")}
        </button>
      )}
    </>
  );
};

/** Sessions parked here until they change again, each with an undo. */
export const WaitingList = ({
  alerts,
  waiting,
  sessions,
  run,
  onChange,
}: {
  alerts: Alerts;
  waiting: WaitingOn;
  sessions: readonly SessionView[];
  run: (p: Promise<void>) => void;
  onChange: () => void;
}) => {
  const t = useT();
  const marks = waiting.current(sessions);
  if (!marks.length) return null;
  return (
    <section aria-labelledby="inbox-waiting" data-waiting-list>
      <h2 id="inbox-waiting">{t("alerts.waitingTitle")}</h2>
      <p className="muted">{t("alerts.waitingHint")}</p>
      <ul className="list">
        {marks.map((m) => (
          <li key={m.sid} data-waiting-sid={m.sid} className="card">
            <span>{sessions.find((s) => s.sid === m.sid)?.label ?? m.sid}</span>
            <button
              onClick={() => {
                waiting.unmark(m.sid);
                onChange();
                run(
                  alerts.waiting(m.sid, false).catch((e: unknown) => {
                    waiting.mark(m.sid, m.state);
                    onChange();
                    throw e;
                  }),
                );
              }}
            >
              {t("alerts.notWaiting")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
};
