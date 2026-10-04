import { useCallback, useEffect, useState } from "react";
import { useT } from "../lib/i18n.js";
import {
  installError,
  type AgentStatus,
  type CliStatus,
  type InstallError,
  type LocalAgentApi,
} from "../lib/local-agent.js";

/** How often the panel re-reads the supervisor's state. */
export const AGENT_POLL_MS = 3000;

/**
 * This computer's agent (run by the app) and the "Instalar el comando chalito" action, which
 * changes the person's PATH only after they confirm here.
 */
export const LocalAgent = ({ api, pollMs = AGENT_POLL_MS }: { api: LocalAgentApi; pollMs?: number }) => {
  const t = useT();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<InstallError | null>(null);

  useEffect(() => {
    let live = true;
    const read = () =>
      void api.status().then(
        (s) => live && setStatus(s),
        () => live && setStatus(null),
      );
    read();
    const timer = setInterval(read, pollMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, pollMs]);

  const readCli = useCallback(() => void api.cliStatus().then(setCli, () => setCli(null)), [api]);
  useEffect(readCli, [readCli]);

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      setCli(await api.installCli());
      setConfirming(false);
    } catch (e) {
      setError(installError(e));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="agent-title" data-section="agent" className="card">
      <h2 id="agent-title">{t("agent.title")}</h2>
      {status && (
        <p data-agent={status.state}>
          {status.state === "restarting"
            ? t("agent.state.restarting", {
                code: String(status.exitCode ?? "?"),
                seconds: Math.max(1, Math.round(status.retryInMs / 1000)),
              })
            : t(`agent.state.${status.state}`)}
        </p>
      )}

      {cli && !cli.unavailable && (
        <div data-cli={cli.installed ? "installed" : "absent"}>
          <h3>{t("agent.cli.title")}</h3>
          {cli.installed ? (
            <>
              <p>{t("agent.cli.installed", { path: cli.command ?? "" })}</p>
              <p className="muted">{cli.onPath ? t("agent.cli.newTerminal") : t("agent.cli.notOnPath")}</p>
            </>
          ) : confirming ? (
            <div role="group" aria-label={t("agent.cli.install")}>
              <p>{t(`agent.cli.confirm.${cli.os}`, { path: cli.command ?? "" })}</p>
              <div className="row">
                <button disabled={busy} onClick={() => void install()}>
                  {t("agent.cli.yes")}
                </button>
                <button disabled={busy} onClick={() => setConfirming(false)}>
                  {t("agent.cli.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="muted">{t("agent.cli.why")}</p>
              <button onClick={() => setConfirming(true)}>{t("agent.cli.install")}</button>
            </>
          )}
        </div>
      )}
      {cli?.unavailable === "move_to_applications" && <p>{t("agent.cli.error.move_to_applications")}</p>}
      {error && <p role="alert">{t(`agent.cli.error.${error}`, { path: cli?.command ?? "" })}</p>}
    </section>
  );
};
