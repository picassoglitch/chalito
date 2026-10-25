import { useState, useSyncExternalStore } from "react";
import { useUiText } from "@chalito/ui";
import { useT } from "../lib/i18n.js";
import { formatStart, type MeetingWatch } from "../lib/meetings.js";

/** Meeting warnings and Granola follow-up cards, at the top of the inbox. Nothing here files anything. */
export const Meetings = ({
  watch,
  openUrl,
  onSession,
}: {
  watch: MeetingWatch;
  openUrl?: (url: string) => Promise<void>;
  /** "Sí" opened a drafting session: follow it in Sessions. */
  onSession?: (sid: string) => void;
}) => {
  const t = useT();
  const { locale } = useUiText();
  const snap = useSyncExternalStore(watch.subscribe, watch.getSnapshot);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState(false);
  const cards = snap.followUps?.enabled ? snap.followUps.cards : [];
  // Warnings may be stale or missing: say so where the person looks, not only in Settings.
  const notice =
    snap.configured && snap.pollError
      ? t("meetings.warnings.agentDown")
      : snap.configured && snap.error
        ? t("meetings.warnings.calendarStale")
        : null;
  if (!snap.warnings.length && !cards.length && !notice) return null;

  const join = (key: string, url: string) =>
    openUrl!(url).then(
      () => {
        setJoinError(false);
        watch.ack(key);
      },
      () => setJoinError(true),
    );

  const decide = async (ref: string, choice: "yes" | "later" | "no") => {
    setBusy(ref);
    try {
      const r = await watch.decide(ref, choice);
      setError(null);
      if (choice === "yes" && r.sid) onSession?.(r.sid);
    } catch (e) {
      const code = e instanceof Error ? e.message : "internal";
      setError(t(`meetings.followUps.error.${["no_app", "no_workspace"].includes(code) ? code : "other"}`));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack" data-meetings>
      {notice && (
        <p className="warn" role="status" data-meetings-notice>
          {notice}
        </p>
      )}
      {snap.warnings.length > 0 && (
        <section aria-labelledby="meeting-warnings">
          <h2 id="meeting-warnings">{t("meetings.warnings.title")}</h2>
          {joinError && <p role="alert">{t("meetings.warnings.joinFailed")}</p>}
          <ul className="list">
            {snap.warnings.map((w) => (
              <li key={w.key} className="card" data-warning={w.stage} data-level={w.level}>
                <strong>{w.meeting.title || t("meetings.untitled")}</strong>
                <span>
                  {t("meetings.warnings.startsIn", {
                    minutes: w.minutes,
                    time: formatStart(w.meeting.startMs, { locale: locale === "es" ? "es-MX" : "en-US" }),
                  })}
                </span>
                <div className="row">
                  {w.meeting.joinUrl && openUrl && (
                    <button onClick={() => void join(w.key, w.meeting.joinUrl!)}>{t("meetings.warnings.join")}</button>
                  )}
                  <button onClick={() => watch.ack(w.key)}>{t("meetings.warnings.ok")}</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {cards.length > 0 && (
        <section aria-labelledby="meeting-followups">
          <h2 id="meeting-followups">{t("meetings.followUps.title")}</h2>
          <p className="muted">{t("meetings.followUps.intro")}</p>
          {error && <p role="alert">{error}</p>}
          <ul className="list">
            {cards.map((c) => (
              <li key={c.ref} className="card" data-followup={c.item.type} data-ref={c.ref}>
                <span className="pill">{t(`meetings.followUps.type.${c.item.type}`)}</span>
                <strong>{c.item.title}</strong>
                {c.item.why && <span>{c.item.why}</span>}
                <span className="muted">
                  {t("meetings.followUps.from", { meeting: c.meeting || t("meetings.untitled") })}
                  {c.due ? ` · ${t("meetings.followUps.due")}` : ""}
                </span>
                <div className="row">
                  <button disabled={busy !== null} onClick={() => void decide(c.ref, "yes")}>
                    {t("meetings.followUps.yes")}
                  </button>
                  <button disabled={busy !== null} onClick={() => void decide(c.ref, "later")}>
                    {t("meetings.followUps.later")}
                  </button>
                  <button disabled={busy !== null} onClick={() => void decide(c.ref, "no")}>
                    {t("meetings.followUps.no")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};
