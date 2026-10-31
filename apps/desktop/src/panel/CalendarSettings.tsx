import { useState, useSyncExternalStore, type FormEvent } from "react";
import { useT } from "../lib/i18n.js";
import { IpcUnavailableError } from "../lib/ipc.js";
import type { MeetingWatch } from "../lib/meetings.js";

/** Settings → Reuniones: the private iCal link (kept in the keychain by the agent) and the Granola opt-in. */
export const CalendarSettings = ({ watch }: { watch: MeetingWatch }) => {
  const t = useT();
  const snap = useSyncExternalStore(watch.subscribe, watch.getSnapshot);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    try {
      setNotice(await fn());
    } catch (e) {
      setNotice(t(`meetings.calendar.error.${e instanceof IpcUnavailableError ? "unavailable" : "internal"}`));
    } finally {
      setBusy(false);
      await watch.poll();
    }
  };

  const save = (ev: FormEvent) => {
    ev.preventDefault();
    void run(async () => {
      const r = await watch.ipc.setCalendar(url.trim());
      if (!r.ok) return t(`meetings.calendar.error.${r.reason}`);
      setUrl("");
      return t("meetings.calendar.saved");
    });
  };

  const fu = snap.followUps;
  return (
    <section aria-labelledby="meetings-settings" className="stack" data-calendar-settings>
      <h2 id="meetings-settings">{t("meetings.calendar.title")}</h2>
      <p className="muted">{t("meetings.calendar.intro")}</p>
      {notice && <p role="status">{notice}</p>}
      {snap.pollError && (
        <p className="warn" data-poll-error={snap.pollError}>
          {t(`meetings.calendar.error.${snap.pollError}`)}
        </p>
      )}
      {snap.configured === null ? null : snap.configured ? (
        <div className="row">
          <span>{t("meetings.calendar.connected")}</span>
          {snap.error && <span className="warn">{t(`meetings.calendar.error.${snap.error}`)}</span>}
          {snap.unsupported > 0 && (
            <span className="warn">{t("meetings.calendar.unsupported", { count: snap.unsupported })}</span>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await watch.ipc.clearCalendar();
                return t("meetings.calendar.removed");
              })
            }
          >
            {t("meetings.calendar.remove")}
          </button>
        </div>
      ) : (
        <form className="stack" onSubmit={save}>
          <label>
            {t("meetings.calendar.label")}
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…/basic.ics"
            />
          </label>
          <span className="muted">{t("meetings.calendar.hint")}</span>
          <button type="submit" disabled={busy || !url.trim()}>
            {t("meetings.calendar.save")}
          </button>
        </form>
      )}
      <h3>{t("meetings.granola.title")}</h3>
      {fu?.available ? (
        <label>
          <input
            type="checkbox"
            checked={fu.enabled}
            disabled={busy}
            onChange={(e) => {
              const on = e.target.checked;
              void run(async () => {
                await watch.ipc.enableFollowUps(on);
                return null;
              });
            }}
          />{" "}
          {t("meetings.granola.optIn")}
        </label>
      ) : (
        <p className="muted">{t("meetings.granola.soon")}</p>
      )}
    </section>
  );
};
