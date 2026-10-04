import { useCallback, useEffect, useState } from "react";
import { DevModeToggle } from "@chalito/protocol";
import { useT } from "../lib/i18n.js";
import {
  IpcUnavailableError,
  answersComplete,
  type AgentIpc,
  type DevModeChallenge,
  type DevModeState,
  type PendingPairing,
  type PolicyView,
} from "../lib/ipc.js";

type Load<T> =
  { state: "loading" } | { state: "ok"; value: T } | { state: "unavailable" } | { state: "error"; error: string };

/** Loads from the agent; IpcUnavailableError (no agent / no IPC server yet) is its own state. */
const useAgent = <T,>(fetch: () => Promise<T>): [Load<T>, () => void] => {
  const [v, setV] = useState<Load<T>>({ state: "loading" });
  const reload = useCallback(() => {
    fetch().then(
      (value) => setV({ state: "ok", value }),
      (e: unknown) =>
        setV(e instanceof IpcUnavailableError ? { state: "unavailable" } : { state: "error", error: String(e) }),
    );
  }, [fetch]);
  useEffect(reload, [reload]);
  return [v, reload];
};

const Unavailable = () => {
  const t = useT();
  return <p className="muted">{t("security.unavailable")}</p>;
};

const ReverseCheck = ({ ipc }: { ipc: AgentIpc }) => {
  const t = useT();
  const fetch = useCallback(() => ipc.pendingPairing(), [ipc]);
  const [p, reload] = useAgent<PendingPairing | null>(fetch);
  return (
    <section aria-labelledby="sec-pairing" data-section="pairing">
      <h2 id="sec-pairing">{t("security.pairing.title")}</h2>
      {p.state === "unavailable" && <Unavailable />}
      {p.state === "error" && <p role="alert">{p.error}</p>}
      {p.state === "ok" && !p.value && <p className="muted">{t("security.pairing.none")}</p>}
      {p.state === "ok" && p.value && (
        <div className="card">
          <p>{t("security.pairing.compare", { label: p.value.label })}</p>
          <code className="fingerprint">{p.value.fingerprint}</code>
          {p.value.passkeyId && <p className="muted">{t("security.pairing.passkey", { id: p.value.passkeyId })}</p>}
          <div className="row">
            <button onClick={() => void ipc.confirmPairing(p.value!.pairingId, true).finally(reload)}>
              {t("security.pairing.match")}
            </button>
            <button onClick={() => void ipc.confirmPairing(p.value!.pairingId, false).finally(reload)}>
              {t("security.pairing.mismatch")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
};

const Policy = ({ ipc }: { ipc: AgentIpc }) => {
  const t = useT();
  const fetch = useCallback(() => ipc.policy(), [ipc]);
  const [p] = useAgent<PolicyView>(fetch);
  return (
    <section aria-labelledby="sec-policy" data-section="policy">
      <h2 id="sec-policy">{t("security.policy.title")}</h2>
      {p.state === "unavailable" && <Unavailable />}
      {p.state === "error" && <p role="alert">{p.error}</p>}
      {p.state === "ok" && (
        <>
          <p className="muted">{t("security.policy.chain", { seq: p.value.seq, hash: p.value.hash.slice(0, 12) })}</p>
          <ul className="list">
            {p.value.rules.map((r) => (
              <li key={r.id} className={`rule rule-${r.effect}`}>
                <span>{r.summary}</span> <em>{t(`security.policy.${r.effect}`)}</em>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
};

/** The agent's three confirmations, one screen each; the agent re-checks and asks the OS. */
const EnableFlow = ({
  ipc,
  challenge,
  onDone,
}: {
  ipc: AgentIpc;
  challenge: DevModeChallenge;
  onDone: (s: DevModeState | null, failure?: string) => void;
}) => {
  const t = useT();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [checked, setChecked] = useState(false);
  const [typed, setTyped] = useState("");
  const answers = { first: step >= 2, second: step >= 3, liability: { checked, typed } };
  const cancel = <button onClick={() => onDone(null)}>{t("security.devmode.cancel")}</button>;
  if (step === 1)
    return (
      <div className="card" data-step="1">
        <p>{t("security.devmode.step1", { toggle: challenge.toggle })}</p>
        <ul>
          {challenge.examples.map((e) => (
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
        <p>{t("security.devmode.step2")}</p>
        <p className="warn">{challenge.risk}</p>
        <div className="row">
          <button onClick={() => setStep(3)}>{t("security.devmode.continue")}</button>
          {cancel}
        </div>
      </div>
    );
  return (
    <div className="card" data-step="3">
      <p>{t("security.devmode.step3", { phrase: challenge.liability.phrase })}</p>
      <pre className="liability">{challenge.liability.text}</pre>
      <label>
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />{" "}
        {t("security.devmode.accept")}
      </label>
      <input aria-label={challenge.liability.phrase} value={typed} onChange={(e) => setTyped(e.target.value)} />
      <div className="row">
        <button
          disabled={!answersComplete(answers, challenge.liability.phrase)}
          onClick={() =>
            void ipc.enableDevToggle(challenge.toggle, answers).then(
              (r) => (r.ok ? onDone(r.state) : onDone(null, r.reason)),
              (e: unknown) => onDone(null, String(e)),
            )
          }
        >
          {t("security.devmode.confirm")}
        </button>
        {cancel}
      </div>
    </div>
  );
};

const DevMode = ({ ipc }: { ipc: AgentIpc }) => {
  const t = useT();
  const fetch = useCallback(() => ipc.devMode(), [ipc]);
  const [s, reload] = useAgent<DevModeState>(fetch);
  const [challenge, setChallenge] = useState<DevModeChallenge | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <section aria-labelledby="sec-devmode" data-section="devmode">
      <h2 id="sec-devmode">{t("security.devmode.title")}</h2>
      {s.state === "unavailable" && <Unavailable />}
      {s.state === "error" && <p role="alert">{s.error}</p>}
      {failure && <p role="alert">{t("security.devmode.failed", { reason: failure })}</p>}
      {s.state === "ok" && (
        <>
          {s.value.on && <p className="banner warn">{t("security.devmode.active")}</p>}
          {challenge ? (
            <EnableFlow
              ipc={ipc}
              challenge={challenge}
              onDone={(_state, why) => {
                setChallenge(null);
                setFailure(why ?? null);
                reload();
              }}
            />
          ) : (
            <ul className="list">
              {DevModeToggle.options.map((toggle) => {
                const on = s.value.toggles.includes(toggle);
                return (
                  <li key={toggle} data-toggle={toggle} className="row">
                    <span>{toggle}</span>
                    {on ? (
                      <button onClick={() => void ipc.disableDevToggle(toggle).finally(reload)}>
                        {t("security.devmode.disable")}
                      </button>
                    ) : (
                      <button
                        onClick={() =>
                          void ipc.devModeChallenge(toggle).then(setChallenge, (e: unknown) => setFailure(String(e)))
                        }
                      >
                        {t("security.devmode.enable")}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
};

export const Security = ({ ipc }: { ipc: AgentIpc }) => {
  const t = useT();
  return (
    <div className="stack">
      <p className="muted">{t("security.localOnly")}</p>
      <ReverseCheck ipc={ipc} />
      <Policy ipc={ipc} />
      <DevMode ipc={ipc} />
    </div>
  );
};
