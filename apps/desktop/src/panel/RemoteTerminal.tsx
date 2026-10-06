import { useCallback, useEffect, useState } from "react";
import { useT } from "../lib/i18n.js";
import {
  IpcUnavailableError,
  type AgentIpc,
  type TerminalAnswers,
  type TerminalChallenge,
  type TerminalCopy,
  type TerminalEnableResult,
  type TerminalStatus,
} from "../lib/ipc.js";

/**
 * Remote terminal (apps/agent/src/terminal): turned on only here, like computer control. The raw
 * shell is its own switch with a fourth confirmation. Open terminals stop with the same kill
 * switch as computer control (Ctrl+Alt+Esc, the tray's "Detener control", the indicator).
 */

type Load<T> =
  { state: "loading" } | { state: "ok"; value: T } | { state: "unavailable" } | { state: "error"; error: string };

/** The confirmations, one screen each; the agent asks the OS and re-checks every answer. */
const EnableFlow = ({
  copy,
  shell,
  enable,
  onDone,
}: {
  copy: TerminalCopy;
  shell: boolean;
  enable: (answers: TerminalAnswers) => Promise<TerminalEnableResult>;
  onDone: (failure?: string) => void;
}) => {
  const t = useT();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [typed, setTyped] = useState("");
  const k = shell ? "security.terminal.shell" : "security.terminal";
  const cancel = <button onClick={() => onDone()}>{t("security.devmode.cancel")}</button>;
  const submit = () =>
    void enable({ first: true, second: true, typed, ...(shell ? { final: true } : {}) }).then(
      (r) => onDone(r.ok ? undefined : r.reason),
      (e: unknown) => onDone(String(e)),
    );
  if (step === 1)
    return (
      <div className="card" data-step="1">
        <p>{t(`${k}.step1`)}</p>
        <ul>
          {copy.examples.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
        <div className="row">
          <button onClick={() => setStep(2)}>{t("security.devmode.continue")}</button>
          {cancel}
        </div>
      </div>
    );
  if (step === 2)
    return (
      <div className="card" data-step="2">
        <p>{t("security.terminal.step2")}</p>
        <p className="warn">{copy.risk}</p>
        <div className="row">
          <button onClick={() => setStep(3)}>{t("security.devmode.continue")}</button>
          {cancel}
        </div>
      </div>
    );
  if (step === 3)
    return (
      <div className="card" data-step="3">
        <p>{t("security.terminal.step3", { phrase: copy.phrase })}</p>
        <input aria-label={copy.phrase} value={typed} onChange={(e) => setTyped(e.target.value)} />
        <div className="row">
          <button disabled={typed.trim() !== copy.phrase} onClick={() => (shell ? setStep(4) : submit())}>
            {t(shell ? "security.devmode.continue" : "security.terminal.confirm")}
          </button>
          {cancel}
        </div>
      </div>
    );
  return (
    <div className="card" data-step="4">
      <p className="warn">{copy.warning}</p>
      <div className="row">
        <button onClick={submit}>{t("security.terminal.confirm")}</button>
        {cancel}
      </div>
    </div>
  );
};

export const RemoteTerminal = ({ ipc }: { ipc: AgentIpc }) => {
  const t = useT();
  const [s, setS] = useState<Load<TerminalStatus>>({ state: "loading" });
  const reload = useCallback(() => {
    ipc.terminalStatus().then(
      (value) => setS({ state: "ok", value }),
      (e: unknown) =>
        setS(e instanceof IpcUnavailableError ? { state: "unavailable" } : { state: "error", error: String(e) }),
    );
  }, [ipc]);
  useEffect(reload, [reload]);
  const [flow, setFlow] = useState<{ shell: boolean; challenge: TerminalChallenge } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const start = (shell: boolean) =>
    void ipc.terminalChallenge().then(
      (challenge) => setFlow({ shell, challenge }),
      (e: unknown) => setFailure(String(e)),
    );
  const labels = (xs: { label: string }[]) => xs.map((x) => x.label).join(", ");
  return (
    <section aria-labelledby="sec-terminal" data-section="terminal">
      <h2 id="sec-terminal">{t("security.terminal.title")}</h2>
      <p className="muted">{t("security.terminal.intro")}</p>
      {s.state === "unavailable" && <p className="muted">{t("security.unavailable")}</p>}
      {s.state === "error" && <p role="alert">{s.error}</p>}
      {failure && <p role="alert">{t("security.terminal.failed", { reason: failure })}</p>}
      {s.state === "ok" &&
        (flow ? (
          <EnableFlow
            copy={flow.shell ? flow.challenge.rawShell : flow.challenge.terminal}
            shell={flow.shell}
            enable={(a) => (flow.shell ? ipc.enableRawShell(a) : ipc.enableRemoteTerminal(a))}
            onDone={(why) => {
              setFlow(null);
              setFailure(why ?? null);
              reload();
            }}
          />
        ) : (
          <>
            {s.value.active.length > 0 && (
              <div className="banner warn">
                <p>{t("security.terminal.active", { labels: labels(s.value.active) })}</p>
                <button onClick={() => void ipc.stopComputer().finally(reload)}>{t("security.computer.stop")}</button>
              </div>
            )}
            {s.value.pending.length > 0 && (
              <p className="muted">{t("security.computer.pending", { labels: labels(s.value.pending) })}</p>
            )}
            <div className="row" data-terminal={s.value.enabled ? "on" : "off"}>
              <span>{t(s.value.enabled ? "security.computer.on" : "security.computer.off")}</span>
              {s.value.enabled ? (
                <button onClick={() => void ipc.disableRemoteTerminal().finally(reload)}>
                  {t("security.computer.disable")}
                </button>
              ) : (
                <button onClick={() => start(false)}>{t("security.computer.enable")}</button>
              )}
            </div>
            {s.value.enabled && (
              <div className="row" data-raw-shell={s.value.rawShell ? "on" : "off"}>
                <span>
                  {t("security.terminal.shell.title")}:{" "}
                  {t(s.value.rawShell ? "security.computer.on" : "security.computer.off")}
                </span>
                {s.value.rawShell ? (
                  <button onClick={() => void ipc.disableRawShell().finally(reload)}>
                    {t("security.computer.disable")}
                  </button>
                ) : (
                  <button onClick={() => start(true)}>{t("security.computer.enable")}</button>
                )}
              </div>
            )}
            {s.value.enabled && <p className="muted">{t("security.terminal.hotkey")}</p>}
          </>
        ))}
    </section>
  );
};
