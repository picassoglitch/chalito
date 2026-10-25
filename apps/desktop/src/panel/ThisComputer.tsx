import { useCallback, useEffect, useState } from "react";
import { useT } from "../lib/i18n.js";
import { IpcUnavailableError, type AgentIpc, type Workspace } from "../lib/ipc.js";
import type { ThisComputerApi } from "../lib/this-computer.js";
import { loadPetWalk, savePetWalk } from "../lib/pet-prefs.js";

/** "Esta computadora" (ADR 0028): start with the computer, the pet's walks, and the folders Chalito may work
 * in, chosen with the OS picker (adding one asks the OS for a password in the agent; removing doesn't). */
export const ThisComputer = ({ api, ipc }: { api: ThisComputerApi; ipc: AgentIpc }) => {
  const t = useT();
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [folders, setFolders] = useState<Workspace[] | "unavailable" | null>(null);
  const [busy, setBusy] = useState(false);
  const [walk, setWalk] = useState(() => loadPetWalk());
  const [notice, setNotice] = useState<{ kind: "added" | "already" | "error"; text: string } | null>(null);

  useEffect(() => {
    void api.autostart().then(setAutostart, () => setAutostart(null));
  }, [api]);

  const readFolders = useCallback(
    () =>
      ipc.workspaces().then(
        (r) => setFolders(r.workspaces),
        (e: unknown) => setFolders(e instanceof IpcUnavailableError ? "unavailable" : null),
      ),
    [ipc],
  );
  useEffect(() => void readFolders(), [readFolders]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      setAutostart(await api.setAutostart(on));
    } catch {
      setNotice({ kind: "error", text: t("computer.autostart.failed") });
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    setNotice(null);
    const path = await api.pickFolder().catch(() => null);
    if (!path) return;
    setBusy(true);
    try {
      const r = await ipc.addWorkspace(path);
      if (r.ok)
        setNotice({
          kind: r.added ? "added" : "already",
          text: t(r.added ? "computer.folders.added" : "computer.folders.already", { label: r.label }),
        });
      else setNotice({ kind: "error", text: t(`computer.folders.error.${r.reason}`) });
    } catch {
      setNotice({ kind: "error", text: t("computer.folders.error.other") });
    } finally {
      setBusy(false);
      void readFolders();
    }
  };

  const remove = async (label: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await ipc.removeWorkspace(label);
    } finally {
      setBusy(false);
      void readFolders();
    }
  };

  return (
    <section aria-labelledby="computer-title" data-section="this-computer" className="card">
      <h2 id="computer-title">{t("computer.title")}</h2>

      {autostart !== null && (
        <label data-autostart={autostart ? "on" : "off"}>
          <input type="checkbox" checked={autostart} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />{" "}
          {t("computer.autostart.label")}
        </label>
      )}
      {autostart !== null && <p className="muted">{t("computer.autostart.hint")}</p>}

      <label data-pet-walk={walk ? "on" : "off"}>
        <input
          type="checkbox"
          checked={walk}
          onChange={(e) => {
            setWalk(e.target.checked);
            savePetWalk(e.target.checked);
          }}
        />{" "}
        {t("computer.petWalk.label")}
      </label>

      <h3>{t("computer.folders.title")}</h3>
      {folders === "unavailable" ? (
        <p className="muted">{t("computer.folders.unavailable")}</p>
      ) : (
        <>
          <p className="muted">{t("computer.folders.hint")}</p>
          {folders && folders.length === 0 && <p data-folders="none">{t("computer.folders.none")}</p>}
          {folders && folders.length > 0 && (
            <ul data-folders="list">
              {folders.map((w) => (
                <li key={w.label} data-folder={w.label}>
                  <strong>{w.label}</strong> <span className="muted mono">{w.path}</span>{" "}
                  <button disabled={busy} onClick={() => void remove(w.label)}>
                    {t("computer.folders.remove")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button disabled={busy} onClick={() => void add()}>
            {t("computer.folders.add")}
          </button>
        </>
      )}
      {notice && (
        <p role={notice.kind === "error" ? "alert" : "status"} data-notice={notice.kind}>
          {notice.text}
        </p>
      )}
    </section>
  );
};
