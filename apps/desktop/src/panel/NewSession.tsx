import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import type { ChalitoClient, EventView } from "@chalito/client";
import { useT } from "../lib/i18n.js";
import { IpcUnavailableError, type AgentIpc, type CodeMode } from "../lib/ipc.js";
import { ApprovalRow } from "./Inbox.js";

// ADR 0031 §1: start a session at this computer (origin `local`) and follow it here and on the phone.
// Start, prompt and stop go over the agent's IPC; the transcript and approvals come from the live store.

type Client = Pick<ChalitoClient, "live" | "actions">;

const textOf = (c: unknown): string =>
  typeof (c as { text?: unknown } | null)?.text === "string" ? (c as { text: string }).text : "";

const toolLine = (e: EventView): string => {
  const c = e.content as { toolName?: unknown } | null;
  const name = typeof c?.toolName === "string" ? c.toolName : "";
  return `${String(e.meta.category ?? "other")}${name ? ` · ${name}` : ""}`;
};

const Transcript = ({ client, sid, canStepUp }: { client: Client; sid: string; canStepUp: boolean }) => {
  const t = useT();
  const snap = useSyncExternalStore(client.live.subscribe, client.live.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const events = (snap.events[sid] ?? []).filter((e) =>
    ["message.user", "message.assistant", "tool.started"].includes(e.type),
  );
  const draft = snap.drafts[sid];
  const state = snap.sessions.find((s) => s.sid === sid)?.state;
  const pending = snap.approvals.filter((a) => a.sid === sid && a.status === "pending");
  const who = (origin: unknown) =>
    origin === "local"
      ? t("sessions.you")
      : origin === "local:cli"
        ? t("sessions.terminal")
        : typeof origin === "string" && origin.startsWith("client:")
          ? t("sessions.phone")
          : t("sessions.agent");
  return (
    <div className="stack" data-sid={sid}>
      {state && (
        <span className="pill" data-state={state}>
          {t(`sessions.state.${state}`)}
        </span>
      )}
      <ol className="list transcript">
        {events.map((e) =>
          e.type === "tool.started" ? (
            <li key={e.eid} className="muted tool-step">
              {toolLine(e)}
            </li>
          ) : (
            <li key={e.eid} className={e.type === "message.user" ? "bubble user" : "bubble ai"}>
              <strong>{e.type === "message.user" ? who(e.meta.origin) : t("sessions.ai")}</strong> {textOf(e.content)}
            </li>
          ),
        )}
        {draft && (
          <li className="bubble ai draft" aria-live="polite">
            <strong>{t("sessions.ai")}</strong> {draft.text} <span className="muted">{t("sessions.writing")}</span>
          </li>
        )}
      </ol>
      {error && <p role="alert">{error}</p>}
      {pending.length > 0 && (
        <ul className="list">
          {pending.map((a) => (
            <ApprovalRow
              key={a.aid}
              a={a}
              canStepUp={canStepUp}
              run={(p) =>
                void p.then(
                  () => setError(null),
                  (e: unknown) => setError(t("inbox.error", { reason: e instanceof Error ? e.message : String(e) })),
                )
              }
              decide={(aid, allow) => client.actions.decide(aid, allow)}
            />
          ))}
        </ul>
      )}
    </div>
  );
};

export const NewSession = ({
  ipc,
  client,
  canStepUp = false,
  sid,
  onSid,
  draft,
}: {
  ipc: AgentIpc;
  client: Client | null;
  canStepUp?: boolean;
  /** The session this tab follows; kept by the panel so switching tabs doesn't lose it. */
  sid: string | null;
  onSid: (sid: string | null) => void;
  /** A prompt dictated by voice: fills the form, never starts it. */
  draft?: { prompt: string };
}) => {
  const t = useT();
  const [setup, setSetup] = useState<{ apps: string[]; workspaces: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appId, setAppId] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [mode, setMode] = useState<CodeMode>("default");
  const [prompt, setPrompt] = useState(draft?.prompt ?? "");
  useEffect(() => {
    if (draft) setPrompt(draft.prompt);
  }, [draft]);
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) =>
    setError(
      e instanceof IpcUnavailableError
        ? t("sessions.unavailable")
        : t("sessions.refused", { reason: e instanceof Error ? e.message : String(e) }),
    );

  useEffect(() => {
    let live = true;
    ipc.codeApps().then(
      (s) => {
        if (!live) return;
        setSetup(s);
        setAppId((a) => a || s.apps[0] || "");
        setWorkspace((w) => w || s.workspaces[0] || "");
      },
      (e: unknown) => live && fail(e),
    );
    return () => void (live = false);
  }, [ipc]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setError(null);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const start = (ev: FormEvent) => {
    ev.preventDefault();
    void run(async () => {
      const r = await ipc.codeStart({ appId, workspaceLabel: workspace, prompt: prompt.trim(), permissionMode: mode });
      onSid(r.sid);
      setPrompt("");
    });
  };
  const send = (ev: FormEvent) => {
    ev.preventDefault();
    if (!sid || !next.trim()) return;
    void run(async () => {
      await ipc.codePrompt(sid, next.trim());
      setNext("");
    });
  };

  return (
    <section aria-labelledby="new-session" className="stack">
      <h2 id="new-session">{t("sessions.title")}</h2>
      {error && <p role="alert">{error}</p>}
      {!sid ? (
        <>
          <p className="muted">{t("sessions.intro")}</p>
          {setup && !setup.apps.length && <p>{t("sessions.noApps")}</p>}
          {setup && !setup.workspaces.length && <p>{t("sessions.noWorkspaces")}</p>}
          {setup && setup.apps.length > 0 && setup.workspaces.length > 0 && (
            <form className="stack" onSubmit={start}>
              <label>
                {t("sessions.app")}
                <select value={appId} onChange={(e) => setAppId(e.target.value)}>
                  {setup.apps.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("sessions.workspace")}
                <select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
                  {setup.workspaces.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("sessions.mode")}
                <select value={mode} onChange={(e) => setMode(e.target.value as CodeMode)}>
                  {(["default", "plan", "acceptEdits"] as const).map((m) => (
                    <option key={m} value={m}>
                      {t(`sessions.modes.${m}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("sessions.prompt")}
                <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} maxLength={20_000} />
              </label>
              <button type="submit" disabled={busy || !prompt.trim() || !appId || !workspace}>
                {t("sessions.start")}
              </button>
            </form>
          )}
        </>
      ) : (
        <>
          {client ? (
            <Transcript client={client} sid={sid} canStepUp={canStepUp} />
          ) : (
            <p className="muted">{t("sessions.signInForLive")}</p>
          )}
          <form className="row" onSubmit={send}>
            <label className="grow">
              <span className="sr-only">{t("sessions.prompt")}</span>
              <textarea value={next} onChange={(e) => setNext(e.target.value)} rows={2} maxLength={20_000} />
            </label>
            <button type="submit" disabled={busy || !next.trim()}>
              {t("sessions.send")}
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => void run(() => ipc.codeStop(sid))}>
              {t("sessions.stop")}
            </button>
          </form>
          <button type="button" onClick={() => onSid(null)}>
            {t("sessions.another")}
          </button>
        </>
      )}
    </section>
  );
};
