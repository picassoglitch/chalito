import { useCallback, useEffect, useState } from "react";
import type { AgentIpc, NativeConnectionView } from "../lib/ipc.js";
import { useT } from "../lib/i18n.js";

// The agent marks a row it could not read; that row explains itself instead of hiding the list.
type Row = NativeConnectionView & { error?: string };
const ERRORS = [
  "config_changed",
  "os_auth_failed",
  "unsafe_path",
  "invalid_config",
  "config_too_large",
  "state_corrupt",
  "app_unavailable",
  "unsafe_command",
  "cli_unavailable",
];
const errorKey = (code: string | undefined) => (code && ERRORS.includes(code) ? code : "other");
// Each read runs three CLI lookups in the agent: slow, and only while someone can see the panel.
const POLL_MS = 15_000;

/** Connect existing signed-in apps. This does not replace their login or start paid model calls. */
export const NativeConnections = ({ ipc }: { ipc: AgentIpc }) => {
  const t = useT();
  const [connections, setConnections] = useState<Row[] | null>(null);
  const [confirm, setConfirm] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(() => {
    if (!ipc.nativeConnections) return;
    void ipc.nativeConnections().then(setConnections, () => setConnections(null));
  }, [ipc]);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const sync = () => {
      const visible = document.visibilityState !== "hidden";
      if (visible && !timer) timer = setInterval(read, POLL_MS);
      if (!visible && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState !== "hidden" && !timer) read();
      sync();
    };
    read();
    sync();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [read]);
  const change = async (connection: Row) => {
    setBusy(true);
    setError(null);
    try {
      await ipc.setNativeConnection(connection.provider, !connection.configured, connection.hash);
      setConfirm(null);
    } catch (e) {
      const code = e instanceof Error ? e.message : "internal";
      setError(errorKey(code));
      setConfirm(null);
    } finally {
      setBusy(false);
      read();
    }
  };
  if (connections === null) return null;
  return (
    <section className="card" aria-labelledby="native-connect-title">
      <h2 id="native-connect-title">{t("integrations.native.title")}</h2>
      <p>{t("integrations.native.intro")}</p>
      <p className="muted">{t("integrations.native.scope")}</p>
      {error && <p role="alert">{t(`integrations.native.error.${error}`)}</p>}
      <ul className="list">
        {connections.map((connection) => (
          <li key={connection.provider} data-native={connection.provider}>
            <h3>{t(`integrations.native.name.${connection.provider}`)}</h3>
            <p>
              {t(
                `integrations.native.${connection.connected ? "connected" : connection.configured ? "configured" : !connection.available ? "missing" : "disconnected"}`,
              )}
            </p>
            {connection.error && (
              <p className="muted" data-native-error={connection.error}>
                {t(`integrations.native.error.${errorKey(connection.error)}`)}
              </p>
            )}
            {confirm?.provider === connection.provider ? (
              <div role="group" aria-label={t("integrations.native.confirm")}>
                <p>{t(connection.configured ? "integrations.native.removeHint" : "integrations.native.addHint")}</p>
                <details>
                  <summary>{t("integrations.native.changes")}</summary>
                  <p className="mono">{connection.path}</p>
                  <p>{connection.events.join(", ")}</p>
                </details>
                <button disabled={busy} onClick={() => void change(confirm)}>
                  {t(connection.configured ? "integrations.native.remove" : "integrations.native.connect")}
                </button>
                <button disabled={busy} onClick={() => setConfirm(null)}>
                  {t("integrations.connect.cancel")}
                </button>
              </div>
            ) : (
              <button
                disabled={busy || (!connection.configured && (!connection.available || !!connection.error))}
                onClick={() => {
                  setConfirm(connection);
                  setError(null);
                }}
              >
                {t(connection.configured ? "integrations.native.remove" : "integrations.native.connect")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};
