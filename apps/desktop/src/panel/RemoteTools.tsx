import { useState, useSyncExternalStore } from "react";
import type { ChalitoClient } from "@chalito/client";
import { useT } from "../lib/i18n.js";
import { useVisiblePoll } from "../lib/visible-poll.js";

/** The same signed command path as the phone. The selected PC owns its login and credentials. */
export const RemoteTools = ({ client }: { client: Pick<ChalitoClient, "live" | "actions"> }) => {
  const t = useT();
  const live = useSyncExternalStore(client.live.subscribe, client.live.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState(false);
  // Presence isn't broadcast (migration 20261004000700): pull while this view is on screen, not every few seconds.
  useVisiblePoll(
    () =>
      void client.live.resync().then(
        () => setError(false),
        () => setError(true),
      ),
    20_000,
  );
  const connect = async (deviceId: string, appId: string, computer: string) => {
    setBusy(true);
    setError(false);
    setNotice(null);
    try {
      await client.actions.connectApp(deviceId, appId);
      setNotice(t("integrations.remote.finish", { computer }));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const computers = live.devices.filter((d) => d.role === "agent" && !d.revoked);
  const refresh = async (deviceId: string) => {
    setBusy(true);
    setError(false);
    try {
      await client.actions.refreshApps(deviceId);
      await client.live.resync();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="remote-tools-title" className="card">
      <h2 id="remote-tools-title">{t("integrations.remote.title")}</h2>
      <p className="muted">{t("integrations.remote.intro")}</p>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{t("integrations.remote.failed")}</p>}
      {computers.length === 0 && <p>{t("integrations.remote.noComputers")}</p>}
      {computers.map((d) => (
        <div key={d.deviceId} data-tool-computer={d.deviceId}>
          <h3>
            {d.name} · {t(d.online ? "sessions.online" : "sessions.offline")}
          </h3>
          <button disabled={busy || !d.online} onClick={() => void refresh(d.deviceId)}>
            {t("integrations.remote.refresh")}
          </button>
          {!d.online && <p className="muted">{t("sessions.computerOffline")}</p>}
          {!d.setup?.tools?.length && <p>{t("sessions.setupUnavailable")}</p>}
          <ul className="list">
            {d.setup?.tools
              ?.filter((tool) => tool.sessionCapable)
              .map((tool) => (
                <li key={tool.appId} data-remote-tool={tool.appId}>
                  <strong>{tool.name}</strong> · {t(`integrations.connect.state.${tool.state}`)}
                  {tool.state === "connected" && !tool.sessionEnabled && (
                    <p className="muted">{t("integrations.remote.allowSessions", { computer: d.name })}</p>
                  )}
                  {d.online &&
                    tool.installed &&
                    tool.signinAllowed &&
                    !["connected", "signing_in", "installing"].includes(tool.state) && (
                      <button disabled={busy} onClick={() => void connect(d.deviceId, tool.appId, d.name)}>
                        {t("integrations.connect.signin")}
                      </button>
                    )}
                  {tool.installed && !tool.signinAllowed && tool.state !== "connected" && (
                    <p className="muted">{t("integrations.apps.signinOff")}</p>
                  )}
                </li>
              ))}
          </ul>
        </div>
      ))}
    </section>
  );
};
