import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { startedSessionFor, type ChalitoClient, type EventView, type Snapshot } from "@chalito/client";
import { sessionLink, startableApps } from "@chalito/protocol";
import { detectLocale, useT } from "../lib/i18n.js";
import { useVisiblePoll } from "../lib/visible-poll.js";
import { IpcUnavailableError, type AgentIpc, type CodeMode } from "../lib/ipc.js";
import { ApprovalRow } from "./Inbox.js";
import { Apps, APPS_POLL_MS } from "./Apps.js";

// ADR 0031 §1: start a session at this computer (origin `local`) and follow it here and on the phone.
// Start, prompt and stop go over the agent's IPC; the transcript and approvals come from the live store.

type Client = Pick<ChalitoClient, "live" | "actions">;
const EMPTY: Pick<Snapshot, "devices" | "sessions" | "events"> = { devices: [], sessions: [], events: {} };
const noSubscribe = () => () => undefined;
const emptySnapshot = () => EMPTY;
export const REMOTE_START_WAIT_MS = 30_000;

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
  remote = false,
}: {
  ipc: AgentIpc;
  client: Client | null;
  canStepUp?: boolean;
  /** The session this tab follows; kept by the panel so switching tabs doesn't lose it. */
  sid: string | null;
  onSid: (sid: string | null, remote?: boolean) => void;
  /** Kept by the panel with sid so switching tabs preserves remote routing. */
  remote?: boolean;
  /** A prompt dictated by voice: fills the form, never starts it. */
  draft?: { prompt: string };
}) => {
  const t = useT();
  const live = useSyncExternalStore(client?.live.subscribe ?? noSubscribe, client?.live.getSnapshot ?? emptySnapshot);
  const computers = live.devices.filter((d) => d.role === "agent" && !d.revoked);
  const [target, setTarget] = useState("");
  const computer = computers.find((d) => d.deviceId === target);
  const [pending, setPending] = useState<{
    cid: string;
    deviceId: string;
    since: number;
    before: ReadonlySet<string>;
  } | null>(null);
  useEffect(() => {
    if (!client) {
      setTarget("");
      setPending(null);
    }
  }, [client]);
  const [settingUp, setSettingUp] = useState(false);
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
  const [showLink, setShowLink] = useState(false);
  const [busy, setBusy] = useState(false);
  const approvalOnly = live.sessions.find((s) => s.sid === sid)?.control === "approvals";
  // Other computers' presence isn't broadcast; a failed pull just waits for the next one.
  useVisiblePoll(client ? () => void client.live.resync().catch(() => undefined) : null, 30_000);
  const apps = target ? (computer ? startableApps(computer.setup) : []) : (setup?.apps ?? []);
  const workspaces = target ? (computer?.setup?.labels ?? []) : (setup?.workspaces ?? []);
  // Each computer has its own catalog and allowed folders. Never reuse the previous PC's selection.
  const selectedApp = apps.includes(appId) ? appId : (apps[0] ?? "");
  const selectedWorkspace = workspaces.includes(workspace) ? workspace : (workspaces[0] ?? "");

  useEffect(() => {
    if (!pending) return;
    const started = startedSessionFor(live, pending);
    if (started) {
      setPending(null);
      setPrompt("");
      onSid(started, true);
      return;
    }
    const timer = setTimeout(
      () => {
        setPending(null);
        setError(t("sessions.remoteTimeout"));
      },
      Math.max(0, REMOTE_START_WAIT_MS - (Date.now() - pending.since)),
    );
    return () => clearTimeout(timer);
  }, [pending, live.sessions, live.events, onSid, t]);

  const fail = (e: unknown) =>
    setError(
      e instanceof IpcUnavailableError
        ? t("sessions.unavailable")
        : t("sessions.refused", { reason: e instanceof Error ? e.message : String(e) }),
    );

  useEffect(() => {
    if (target) return;
    let live = true;
    const read = () =>
      ipc.codeApps().then(
        (s) => {
          if (!live) return;
          setSetup(s);
          setAppId((a) => (s.apps.includes(a) ? a : (s.apps[0] ?? "")));
          setWorkspace((w) => (s.workspaces.includes(w) ? w : (s.workspaces[0] ?? "")));
        },
        (e: unknown) => live && fail(e),
      );
    void read();
    const timer = settingUp ? setInterval(() => void read(), APPS_POLL_MS) : undefined;
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [ipc, target, settingUp]);

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
    if (busy || pending || !selectedApp || !selectedWorkspace || !prompt.trim()) return;
    void run(async () => {
      if (target) {
        if (!client || !computer?.online) throw new Error(t("sessions.computerOffline"));
        const before = new Set(live.sessions.filter((s) => s.agentDeviceId === target).map((s) => s.sid));
        const cid = await client.actions.startSession({
          agentDeviceId: target,
          appId: selectedApp,
          workspaceLabel: selectedWorkspace,
          prompt: prompt.trim(),
          permissionMode: mode,
        });
        setPending({ cid, deviceId: target, since: Date.now(), before });
      } else {
        const r = await ipc.codeStart({
          appId: selectedApp,
          workspaceLabel: selectedWorkspace,
          prompt: prompt.trim(),
          permissionMode: mode,
        });
        onSid(r.sid, false);
        setPrompt("");
      }
    });
  };
  const send = (ev: FormEvent) => {
    ev.preventDefault();
    if (!sid || !next.trim()) return;
    if (next.trim() === "/link") {
      setShowLink(true);
      setNext("");
      return;
    }
    void run(async () => {
      if (remote) {
        if (!client) throw new Error(t("sessions.signInForRemote"));
        await client.actions.prompt(sid, next.trim());
      } else await ipc.codePrompt(sid, next.trim());
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
          {client && (
            <label>
              {t("sessions.computer")}
              <select
                value={target}
                disabled={busy || pending !== null}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setAppId("");
                  setWorkspace("");
                  setError(null);
                }}
              >
                <option value="">{t("sessions.thisComputer")}</option>
                {computers.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.name} · {t(d.online ? "sessions.online" : "sessions.offline")}
                  </option>
                ))}
              </select>
            </label>
          )}
          {target && !computer?.online && <p role="status">{t("sessions.computerOffline")}</p>}
          {target && !computer?.setup && <p>{t("sessions.setupUnavailable")}</p>}
          {(setup || target) && !apps.length && <p>{t("sessions.noApps")}</p>}
          {(setup || target) && !workspaces.length && <p>{t("sessions.noWorkspaces")}</p>}
          {!target && (
            <button type="button" aria-expanded={settingUp} onClick={() => setSettingUp((v) => !v)}>
              {t("sessions.setupAI")}
            </button>
          )}
          {!target && settingUp && (
            <div className="stack">
              <p className="muted">{t("sessions.setupHint")}</p>
              <Apps ipc={ipc} />
            </div>
          )}
          {apps.length > 0 && workspaces.length > 0 && (
            <form className="stack" onSubmit={start}>
              <fieldset disabled={busy || pending !== null} className="stack">
                <label>
                  {t("sessions.app")}
                  <select value={selectedApp} onChange={(e) => setAppId(e.target.value)}>
                    {apps.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("sessions.workspace")}
                  <select value={selectedWorkspace} onChange={(e) => setWorkspace(e.target.value)}>
                    {workspaces.map((w) => (
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
                <button
                  type="submit"
                  disabled={
                    busy ||
                    pending !== null ||
                    !prompt.trim() ||
                    !selectedApp ||
                    !selectedWorkspace ||
                    (!!target && !computer?.online)
                  }
                >
                  {t("sessions.start")}
                </button>
              </fieldset>
            </form>
          )}
          {pending && <p role="status">{t("sessions.waitingForComputer")}</p>}
          {client && computers.length > 0 && (
            <section aria-label={t("sessions.allComputers")}>
              <h3>{t("sessions.allComputers")}</h3>
              {computers.map((d) => (
                <div key={d.deviceId} data-computer={d.deviceId} className="card">
                  <strong>{d.name}</strong> · {t(d.online ? "sessions.online" : "sessions.offline")}
                  <p className="muted">{startableApps(d.setup).join(", ") || t("sessions.noConnectedTools")}</p>
                  <ul className="list">
                    {live.sessions
                      .filter((s) => s.agentDeviceId === d.deviceId)
                      .map((s) => (
                        <li key={s.sid}>
                          <button disabled={busy || pending !== null} onClick={() => onSid(s.sid, true)}>
                            {s.card?.goal || s.label || s.adapter || s.sid.slice(0, 8)}
                          </button>
                          {s.state && <> · {t(`sessions.state.${s.state}`)}</>}
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
            </section>
          )}
        </>
      ) : (
        <>
          <button type="button" onClick={() => setShowLink((shown) => !shown)}>
            {t("sessions.link")}
          </button>
          {showLink && (
            <p>
              <a href={sessionLink(sid, detectLocale())} target="_blank" rel="noreferrer">
                {sessionLink(sid, detectLocale())}
              </a>
              <br />
              {t("sessions.linkHint")}
            </p>
          )}
          {client ? (
            <Transcript client={client} sid={sid} canStepUp={canStepUp} />
          ) : (
            <p className="muted">{t("sessions.signInForLive")}</p>
          )}
          {approvalOnly ? (
            <p className="muted">{t("sessions.nativeScope")}</p>
          ) : (
            <form className="row" onSubmit={send}>
              <label className="grow">
                <span className="sr-only">{t("sessions.prompt")}</span>
                <textarea value={next} onChange={(e) => setNext(e.target.value)} rows={2} maxLength={20_000} />
              </label>
              <button type="submit" disabled={busy || !next.trim()}>
                {t("sessions.send")}
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (remote) {
                      if (!client) throw new Error(t("sessions.signInForRemote"));
                      await client.actions.interrupt(sid);
                    } else await ipc.codeStop(sid);
                  })
                }
              >
                {t("sessions.stop")}
              </button>
            </form>
          )}
          <button type="button" onClick={() => onSid(null)}>
            {t("sessions.another")}
          </button>
        </>
      )}
    </section>
  );
};
