import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n.js";
import type { AgentIpc, TeamConnectionsView, TeamProvider } from "../lib/ipc.js";

/** Per-app trust for automatic communication; vendor login and tool approvals stay with each app. */
export const Connections = ({ ipc }: { ipc: AgentIpc }) => {
  const t = useT();
  const [view, setView] = useState<TeamConnectionsView | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [failure, setFailure] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      if (!ipc.teamConnections) throw new Error("unavailable");
      const next = await ipc.teamConnections();
      if (mounted.current && request === generation.current) {
        setView(next);
        setLoadError(false);
      }
    } catch {
      if (mounted.current && request === generation.current) setLoadError(true);
    }
  }, [ipc]);
  useEffect(() => {
    if (busy) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      clearInterval(timer);
      generation.current++;
    };
  }, [refresh, busy]);
  const selected = view?.workspaces.find((w) => w.label === workspace) ?? view?.workspaces[0];
  const trust = async (provider: TeamProvider, trusted: boolean) => {
    if (!selected || !ipc.setTeamTrust) return;
    ++generation.current;
    setBusy(true);
    setFailure(false);
    try {
      const next = await ipc.setTeamTrust(provider, selected.label, trusted, selected.path);
      if (mounted.current) setView(next);
    } catch {
      if (mounted.current) setFailure(true);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section className="card" aria-labelledby="team-connections-title">
      <h2 id="team-connections-title">{t("integrations.team.title")}</h2>
      <p>{t("integrations.team.intro")}</p>
      {(loadError || failure) && <p role="alert">{t("integrations.team.error")}</p>}
      {view && !selected && <p>{t("integrations.team.noWorkspace")}</p>}
      {selected && (
        <>
          <label>
            {t("integrations.team.workspace")}
            <select value={selected.label} disabled={busy} onChange={(e) => setWorkspace(e.target.value)}>
              {view!.workspaces.map((w) => (
                <option key={w.label} value={w.label}>
                  {w.label} · {w.path}
                </option>
              ))}
            </select>
          </label>
          <ul className="list">
            {selected.connections.map((connection) => (
              <li key={connection.provider} data-team-provider={connection.provider}>
                <h3>{t(`integrations.team.name.${connection.provider}`)}</h3>
                <label>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={connection.trusted}
                    disabled={busy || !ipc.setTeamTrust}
                    onChange={(e) => void trust(connection.provider, e.target.checked)}
                  />
                  {t("integrations.team.trust", { name: t(`integrations.team.name.${connection.provider}`) })}
                </label>
                <p>
                  {t(
                    `integrations.team.${!connection.trusted ? "notTrusted" : connection.connected ? "connected" : "ready"}`,
                  )}
                </p>
                {connection.trusted && (
                  <details>
                    <summary>{t("integrations.team.setup")}</summary>
                    <p>{t("integrations.team.setupHint")}</p>
                    <textarea
                      aria-label={t("integrations.team.config", {
                        name: t(`integrations.team.name.${connection.provider}`),
                      })}
                      readOnly
                      rows={8}
                      value={JSON.stringify(
                        { mcpServers: { chalito_team: { command: connection.command, args: connection.args } } },
                        null,
                        2,
                      )}
                    />
                  </details>
                )}
              </li>
            ))}
          </ul>
          <p className="muted">{t("integrations.team.scope")}</p>
        </>
      )}
    </section>
  );
};
