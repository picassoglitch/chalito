import { useCallback, useEffect, useState } from "react";
import type { Provider } from "@chalito/protocol";
import { useT } from "../lib/i18n.js";
import { IpcUnavailableError, type AgentIpc, type ProviderView } from "../lib/ipc.js";

/** How often the panel re-reads the providers while one is installing or signing in. */
export const PROVIDERS_POLL_MS = 3000;

type Confirm = { provider: Provider; kind: "install" | "disconnect" } | null;

/**
 * "IA conectadas": the four providers on this computer (connect contract, 2026-10-05). An API
 * key goes straight to this computer's keychain through the local agent; a sign-in is the
 * provider's own, in the browser here; an install is the provider's official package and runs
 * only after a yes on this screen (also when the phone or the web asked for it).
 */
export const Providers = ({ ipc, pollMs = PROVIDERS_POLL_MS }: { ipc: AgentIpc; pollMs?: number }) => {
  const t = useT();
  const [list, setList] = useState<ProviderView[] | "loading" | "unavailable">("loading");
  const [keyFor, setKeyFor] = useState<Provider | null>(null);
  const [key, setKey] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ provider: Provider; code: string } | null>(null);

  const read = useCallback(
    () =>
      ipc.providers().then(setList, (e: unknown) => {
        if (e instanceof IpcUnavailableError) setList("unavailable");
      }),
    [ipc],
  );
  useEffect(() => void read(), [read]);
  // Keep polling while something is in progress here (install, sign-in) or waiting for a yes.
  const active =
    Array.isArray(list) &&
    list.some((v) => ["installing", "signing_in"].includes(v.doc.state) || v.installRequestedUntil !== null);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void read(), pollMs);
    return () => clearInterval(timer);
  }, [active, read, pollMs]);

  const act = async (provider: Provider, run: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await run();
    } catch (e) {
      setFailure({ provider, code: e instanceof Error ? e.message : "internal" });
    } finally {
      setBusy(false);
      setConfirm(null);
      void read();
    }
  };

  const saveKey = (provider: Provider) =>
    act(provider, async () => {
      await ipc.connectProviderKey(provider, key.trim());
      setKey("");
      setKeyFor(null);
    });

  if (list === "loading") return null;
  return (
    <section aria-labelledby="ai-title" data-section="providers" className="card">
      <h2 id="ai-title">{t("integrations.connect.title")}</h2>
      {list === "unavailable" ? (
        <p className="muted">{t("security.unavailable")}</p>
      ) : (
        <ul className="providers">
          {list.map((v) => {
            const p = v.provider;
            const s = v.doc.state;
            const installed = v.doc.cli.installed;
            return (
              <li key={p} data-provider={p} data-state={s}>
                <h3>
                  {t(`integrations.connect.agent.${p}`)} <span className="muted">({t(`integrations.${p}.name`)})</span>
                </h3>
                <p>
                  {t(`integrations.connect.state.${s}`)}
                  {v.doc.mode && s === "connected" ? ` · ${t(`integrations.connect.mode.${v.doc.mode}`)}` : ""}
                  {v.doc.cli.version ? ` · v${v.doc.cli.version}` : ""}
                </p>
                {v.doc.error && s !== "connected" && (
                  <p role="alert">{t(`integrations.connect.error.${v.doc.error}`)}</p>
                )}
                {failure?.provider === p && (
                  <p role="alert">
                    {t(
                      `integrations.connect.failure.${["blocked_by_policy", "provider_busy"].includes(failure.code) ? failure.code : "other"}`,
                    )}
                  </p>
                )}

                {v.installRequestedUntil !== null && confirm?.provider !== p && (
                  <div role="group" aria-label={t("integrations.connect.install")}>
                    <p>{t("integrations.connect.remoteInstall", { pkg: t(`integrations.connect.package.${p}`) })}</p>
                    <div className="row">
                      <button disabled={busy} onClick={() => void act(p, () => ipc.installProvider(p))}>
                        {t("integrations.connect.yesInstall")}
                      </button>
                      <button disabled={busy} onClick={() => void act(p, () => ipc.declineProviderInstall(p))}>
                        {t("integrations.connect.cancel")}
                      </button>
                    </div>
                  </div>
                )}

                {confirm?.provider === p ? (
                  <div role="group" aria-label={t(`integrations.connect.${confirm.kind}`)}>
                    <p>
                      {confirm.kind === "install"
                        ? t("integrations.connect.confirmInstall", { pkg: t(`integrations.connect.package.${p}`) })
                        : t("integrations.connect.confirmDisconnect")}
                    </p>
                    <div className="row">
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(p, () =>
                            confirm.kind === "install" ? ipc.installProvider(p) : ipc.disconnectProvider(p),
                          )
                        }
                      >
                        {confirm.kind === "install"
                          ? t("integrations.connect.yesInstall")
                          : t("integrations.connect.yesDisconnect")}
                      </button>
                      <button disabled={busy} onClick={() => setConfirm(null)}>
                        {t("integrations.connect.cancel")}
                      </button>
                    </div>
                  </div>
                ) : keyFor === p ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (key.trim()) void saveKey(p);
                    }}
                  >
                    <label>
                      {t("integrations.connect.keyLabel")}
                      <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={key}
                        onChange={(e) => setKey(e.target.value)}
                      />
                    </label>
                    <p className="muted">{t("integrations.connect.keyLocal")}</p>
                    <div className="row">
                      <button type="submit" disabled={busy || !key.trim()}>
                        {t("integrations.connect.saveKey")}
                      </button>
                      <button type="button" onClick={() => (setKeyFor(null), setKey(""))}>
                        {t("integrations.connect.cancel")}
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="row">
                    {!installed && s !== "installing" && (
                      <button disabled={busy} onClick={() => setConfirm({ provider: p, kind: "install" })}>
                        {t("integrations.connect.install")}
                      </button>
                    )}
                    {installed && s !== "connected" && s !== "signing_in" && (
                      <>
                        <button disabled={busy} onClick={() => setKeyFor(p)}>
                          {t("integrations.connect.withKey")}
                        </button>
                        {v.signinAllowed && (
                          <button disabled={busy} onClick={() => void act(p, () => ipc.signinProvider(p))}>
                            {t("integrations.connect.signin")}
                          </button>
                        )}
                      </>
                    )}
                    {(s === "connected" || v.doc.mode !== null) && (
                      <button disabled={busy} onClick={() => setConfirm({ provider: p, kind: "disconnect" })}>
                        {t("integrations.connect.disconnect")}
                      </button>
                    )}
                  </div>
                )}
                {installed && !v.signinAllowed && s !== "connected" && (
                  <p className="muted">{t(`integrations.connect.signinOff.${p}`)}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
