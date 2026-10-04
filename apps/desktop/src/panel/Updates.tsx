import { useSyncExternalStore } from "react";
import { useT } from "../lib/i18n.js";
import type { UpdateController } from "../lib/updates.js";

export const Updates = ({ updates }: { updates: UpdateController }) => {
  const t = useT();
  const s = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  const check = <button onClick={() => void updates.check()}>{t("updates.check")}</button>;
  return (
    <section aria-labelledby="updates-title" data-updates={s.step} className="card">
      <h2 id="updates-title">{t("updates.title")}</h2>
      {s.step === "idle" && check}
      {s.step === "checking" && <p className="muted">{t("updates.checking")}</p>}
      {s.step === "current" && (
        <>
          <p>{t("updates.current")}</p>
          {check}
        </>
      )}
      {s.step === "available" && (
        <>
          <p>{t("updates.available", { version: s.version })}</p>
          {s.notes && <p className="muted">{s.notes}</p>}
          <button onClick={() => void updates.install()}>{t("updates.install")}</button>
        </>
      )}
      {s.step === "downloading" && (
        <p>
          {s.total
            ? t("updates.downloadingPct", { pct: Math.min(100, Math.round((s.received / s.total) * 100)) })
            : t("updates.downloading")}
        </p>
      )}
      {s.step === "ready" && (
        <>
          <p>{t("updates.ready", { version: s.version })}</p>
          <button onClick={() => void updates.relaunch()}>{t("updates.relaunch")}</button>
        </>
      )}
      {s.step === "unavailable" && <p className="muted">{t("updates.unavailable")}</p>}
      {s.step === "error" && (
        <>
          <p role="alert">{t("updates.error")}</p>
          {check}
        </>
      )}
    </section>
  );
};
