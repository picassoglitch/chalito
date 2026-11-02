import { useCallback, useEffect, useRef, useState } from "react";
import en from "../../../messages/en.json";
import { IpcUnavailableError } from "../../lib/ipc.js";
import { useT } from "../../lib/i18n.js";
import type { FoundIpc, FoundRow } from "../../lib/connections-found-ipc.js";

// The agent's codes (install-channel.ts CHANNEL_ERRORS); the agent's tests check the messages cover them.
const ERRORS = Object.keys(en.connections.found.error);
const errorKey = (code: string | undefined) => (code && ERRORS.includes(code) ? code : "other");

const statusKey = (row: FoundRow): string => {
  if (!row.mcpCapable) return "noMcp";
  if (!row.channel) return "notYet";
  if (row.channel.connected) return "connected";
  if (row.channel.channel === "needs_update") return "needsUpdate";
  return "notConnected";
};

/** "Encontradas en esta PC": AI tools installed here, and Connect for the ones whose MCP config Chalito can edit. */
export const FoundSection = ({ ipc }: { ipc: FoundIpc }) => {
  const t = useT();
  const [rows, setRows] = useState<FoundRow[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [confirm, setConfirm] = useState<FoundRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const latest = useRef(0);
  const read = useCallback(() => {
    // Only the newest scan may land: an older, slower one would show a stale Connect state.
    const n = ++latest.current;
    setScanning(true);
    void ipc.scan().then(
      (r) => {
        if (n !== latest.current) return;
        setRows(r);
        setReadFailed(false);
        setHidden(false);
        setScanning(false);
      },
      (e: unknown) => {
        if (n !== latest.current) return;
        setScanning(false);
        // No agent, or one without this feature, hides the section until a scan works; other failures keep the last rows.
        if (e instanceof IpcUnavailableError || (e instanceof Error && e.message === "unknown_method")) setHidden(true);
        else setReadFailed(true);
      },
    );
  }, [ipc]);
  useEffect(() => {
    read();
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") read();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [read]);
  const change = async (row: FoundRow) => {
    setBusy(true);
    setError(null);
    try {
      await (row.channel?.connected ? ipc.disconnect(row.id) : ipc.connect(row.id));
    } catch (e) {
      setError(errorKey(e instanceof Error ? e.message : undefined));
    } finally {
      setConfirm(null);
      setBusy(false);
      read();
    }
  };
  if (hidden) return null;
  return (
    <section className="card" aria-labelledby="connections-found-title" data-connections-found>
      <h2 id="connections-found-title">{t("connections.found.title")}</h2>
      <p>{t("connections.found.intro")}</p>
      {error && <p role="alert">{t(`connections.found.error.${error}`)}</p>}
      {readFailed && (
        <p role="alert">{t(rows === null ? "connections.found.scanFailed" : "connections.found.readFailed")}</p>
      )}
      {rows === null && !readFailed && <p className="muted">{t("connections.found.scanning")}</p>}
      {rows?.length === 0 && <p className="muted">{t("connections.found.empty")}</p>}
      <ul className="list">
        {(rows ?? []).map((row) => {
          const on = !!row.channel?.connected;
          // Disconnect stays possible whatever else is wrong; Connect needs a ready channel and a clean config.
          const canChange = !!row.channel && (on || (row.channel.channel === "ready" && !row.channel.error));
          return (
            <li key={row.id} data-found={row.id}>
              <h3>{row.name}</h3>
              <p className="muted">
                {t(`connections.found.kind.${row.kind}`)}
                {row.path ? (
                  <>
                    {" · "}
                    <span className="mono">{row.path}</span>
                  </>
                ) : null}
              </p>
              <p data-found-status={statusKey(row)}>{t(`connections.found.${statusKey(row)}`)}</p>
              {row.channel?.error && (
                <p className="muted" data-found-error={row.channel.error}>
                  {t(`connections.found.error.${errorKey(row.channel.error)}`)}
                </p>
              )}
              {row.channel &&
                (confirm?.id === row.id ? (
                  <div role="group" aria-label={t("connections.found.confirm")}>
                    <p>{t(on ? "connections.found.removeHint" : "connections.found.addHint")}</p>
                    <p className="mono">{row.channel.configPath}</p>
                    <button disabled={busy || !canChange} onClick={() => void change(row)}>
                      {t(on ? "connections.found.disconnect" : "connections.found.connect")}
                    </button>
                    <button disabled={busy} onClick={() => setConfirm(null)}>
                      {t("connections.found.cancel")}
                    </button>
                  </div>
                ) : (
                  <button
                    disabled={busy || !canChange}
                    onClick={() => {
                      setConfirm(row);
                      setError(null);
                    }}
                  >
                    {t(on ? "connections.found.disconnect" : "connections.found.connect")}
                  </button>
                ))}
            </li>
          );
        })}
      </ul>
      <button type="button" disabled={busy || scanning} onClick={read}>
        {t(scanning && rows !== null ? "connections.found.scanning" : "connections.found.rescan")}
      </button>
    </section>
  );
};
