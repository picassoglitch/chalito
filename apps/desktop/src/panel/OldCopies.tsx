import { useEffect, useState } from "react";
import { useT } from "../lib/i18n.js";
import { anythingFound, needsFix, type CopiesApi, type CopiesReport } from "../lib/copies.js";

const REFUSALS = ["running", "not_a_copy", "not_listed"] as const;

type Notice = { kind: "done" | "error"; key: string };

// Two AppImages ran at once and sign-in looped (owner, 2026-10-25). Lists what the check found;
// each fix runs only when the person clicks it.
export const OldCopies = ({ api }: { api: CopiesApi }) => {
  const t = useT();
  const [report, setReport] = useState<CopiesReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    void api.report().then(setReport, () => setReport(null));
  }, [api]);

  const act = async (run: () => Promise<CopiesReport>, done: string) => {
    setBusy(true);
    setNotice(null);
    try {
      setReport(await run());
      setNotice({ kind: "done", key: done });
    } catch (e) {
      const code = REFUSALS.find((r) => r === e) ?? "other";
      setNotice({ kind: "error", key: `copies.error.${code}` });
      void api.report().then(setReport, () => {});
    } finally {
      setBusy(false);
    }
  };

  if (!report || (!anythingFound(report) && !notice)) return null;
  const links = (["autostart", "handler"] as const).flatMap((which) => {
    const l = report[which];
    return needsFix(l) ? [{ which, state: l.state, path: l.path }] : [];
  });

  return (
    <section aria-labelledby="copies-title" data-section="old-copies" className="card">
      <h2 id="copies-title">{t("copies.title")}</h2>
      {anythingFound(report) && <p className="muted">{t("copies.intro")}</p>}

      {links.length > 0 && (
        <>
          <ul className="list" data-copies="links">
            {links.map((l) => (
              <li key={l.which} data-link={`${l.which}:${l.state}`}>
                {t(`copies.${l.which}.${l.state}`, { path: l.path })}
              </li>
            ))}
          </ul>
          <p className="muted mono">{t("copies.this", { path: report.running })}</p>
          <button disabled={busy} onClick={() => void act(() => api.useThis(), "copies.done.useThis")}>
            {t("copies.useThis")}
          </button>
        </>
      )}

      {report.instances.length > 0 && (
        <ul className="list" data-copies="instances">
          {report.instances.map((i) => (
            <li key={i.pid} data-instance={i.kind}>
              {t(`copies.running.${i.kind}`, { path: i.path })}{" "}
              <button disabled={busy} onClick={() => void act(() => api.close(i.pid), "copies.done.close")}>
                {t(i.kind === "agent" ? "copies.closeAgent" : "copies.close")}
              </button>
            </li>
          ))}
        </ul>
      )}

      {report.copies.length > 0 && (
        <>
          <ul className="list" data-copies="files">
            {report.copies.map((c) => (
              <li key={c.path} data-copy={c.path}>
                {c.version
                  ? t("copies.oldVersion", { version: c.version, path: c.path })
                  : t("copies.old", { path: c.path })}{" "}
                <button disabled={busy} onClick={() => void act(() => api.trash(c.path), "copies.done.trash")}>
                  {t("copies.trash")}
                </button>
              </li>
            ))}
          </ul>
          <p className="muted">{t("copies.trashHint")}</p>
        </>
      )}

      {notice && (
        <p role={notice.kind === "error" ? "alert" : "status"} data-notice={notice.kind}>
          {t(notice.key)}
        </p>
      )}
    </section>
  );
};
