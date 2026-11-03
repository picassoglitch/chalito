import { useCallback, useEffect, useState } from "react";
import { useT } from "../lib/i18n.js";
import type { AgentIpc } from "../lib/ipc.js";

// Owner 2026-11-02 — allow everything: on by default, so the panel always shows when it is on.
const useAllowEverything = (ipc: AgentIpc, pollMs: number) => {
  const [on, setOn] = useState<boolean | null>(null);
  const reload = useCallback(() => {
    ipc.allowEverythingStatus().then(
      (s) => setOn(s.on),
      () => setOn(null),
    );
  }, [ipc]);
  useEffect(() => {
    reload();
    if (!pollMs) return;
    const t = setInterval(reload, pollMs);
    return () => clearInterval(t);
  }, [reload, pollMs]);
  return [on, reload] as const;
};

/** Shown on every tab while the switch is on. */
export const AllowEverythingBanner = ({ ipc, pollMs = 5000 }: { ipc: AgentIpc; pollMs?: number }) => {
  const t = useT();
  const [on, reload] = useAllowEverything(ipc, pollMs);
  if (!on) return null;
  return (
    <div className="card" role="status" data-allow-everything="on">
      <strong>{t("security.allowEverything.banner")}</strong>{" "}
      <button onClick={() => void ipc.disableAllowEverything().finally(reload)}>
        {t("security.allowEverything.disable")}
      </button>
    </div>
  );
};

/** Security tab: turn off anytime; turn on only here (the agent asks the OS, then this yes). */
export const AllowEverythingSection = ({ ipc }: { ipc: AgentIpc }) => {
  const t = useT();
  const [on, reload] = useAllowEverything(ipc, 0);
  const [confirming, setConfirming] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (on === null) return null;
  return (
    <section aria-labelledby="sec-allow-everything" data-section="allow-everything">
      <h2 id="sec-allow-everything">{t("security.allowEverything.title")}</h2>
      <p role="note">{t("security.allowEverything.warning")}</p>
      {failure && <p role="alert">{t("security.allowEverything.failed", { reason: failure })}</p>}
      {confirming ? (
        <div className="row" data-step="confirm">
          <button
            onClick={() =>
              void ipc.enableAllowEverything({ confirm: true }).then(
                (r) => {
                  setConfirming(false);
                  setFailure(r.ok ? null : r.reason);
                  reload();
                },
                (e: unknown) => {
                  setConfirming(false);
                  setFailure(String(e));
                },
              )
            }
          >
            {t("security.allowEverything.confirm")}
          </button>
          <button onClick={() => setConfirming(false)}>{t("security.devmode.cancel")}</button>
        </div>
      ) : (
        <div className="row" data-allow-everything={on ? "on" : "off"}>
          <span>{t(on ? "security.allowEverything.on" : "security.allowEverything.off")}</span>
          {on ? (
            <button onClick={() => void ipc.disableAllowEverything().finally(reload)}>
              {t("security.allowEverything.disable")}
            </button>
          ) : (
            <button onClick={() => setConfirming(true)}>{t("security.allowEverything.enable")}</button>
          )}
        </div>
      )}
    </section>
  );
};
