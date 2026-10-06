import { useCallback, useEffect, useState } from "react";
import type { RecipeKind } from "@chalito/protocol";
import { useT } from "../lib/i18n.js";
import { IpcUnavailableError, type AgentIpc, type AppView, type AppsView, type CustomChallenge } from "../lib/ipc.js";

/** How often the panel re-reads the apps while one is installing or signing in. */
export const APPS_POLL_MS = 3000;

type Confirm = { appId: string; kind: "install" | "disconnect" } | null;
type Enabling = { appId: string; challenge: CustomChallenge; typed: string; result?: string } | null;

/** The sections of the catalog, in order; an app goes in its recipe's first kind. */
const GROUPS: { id: string; kinds: RecipeKind[] }[] = [
  { id: "agents", kinds: ["claude-sdk", "codex", "acp", "terminal"] },
  { id: "desktop", kinds: ["desktop-app"] },
  { id: "web", kinds: ["web-app"] },
];

/**
 * "IA conectadas" as a catalog (engine contract v2): every AI app this computer knows, the
 * curated ones (signed by Chalito) and the person's own recipes ("Personalizada"). An API key
 * goes straight to this computer's keychain through the local agent; a sign-in is always the
 * app's own (its CLI login, its desktop app, its real website); an install is the app's official
 * one and runs only after a yes on this screen (also when another device asked for it). A custom
 * recipe is turned on only here, after the OS check, reviewing what it runs and typing its id.
 */
export const Apps = ({ ipc, pollMs = APPS_POLL_MS }: { ipc: AgentIpc; pollMs?: number }) => {
  const t = useT();
  const [view, setView] = useState<AppsView | "loading" | "unavailable">("loading");
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [enabling, setEnabling] = useState<Enabling>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ appId: string; code: string } | null>(null);

  const read = useCallback(
    () =>
      ipc.apps().then(setView, (e: unknown) => {
        if (e instanceof IpcUnavailableError) setView("unavailable");
      }),
    [ipc],
  );
  useEffect(() => void read(), [read]);
  const active =
    typeof view === "object" &&
    view.apps.some((v) => ["installing", "signing_in"].includes(v.doc.state) || v.installRequestedUntil !== null);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void read(), pollMs);
    return () => clearInterval(timer);
  }, [active, read, pollMs]);

  const act = async (appId: string, run: () => Promise<void>) => {
    setBusy(true);
    setFailure(null);
    try {
      await run();
    } catch (e) {
      setFailure({ appId, code: e instanceof Error ? e.message : "internal" });
    } finally {
      setBusy(false);
      setConfirm(null);
      void read();
    }
  };

  const saveKey = (appId: string) =>
    act(appId, async () => {
      await ipc.connectAppKey(appId, key.trim());
      setKey("");
      setKeyFor(null);
    });

  const startEnable = (appId: string) =>
    act(appId, async () => setEnabling({ appId, challenge: await ipc.customRecipeChallenge(appId), typed: "" }));
  const finishEnable = (e: NonNullable<Enabling>) =>
    act(e.appId, async () => {
      const r = await ipc.enableCustomRecipe(e.appId, { review: true, typed: e.typed });
      setEnabling(r.ok ? null : { ...e, result: r.reason });
    });

  const installText = (v: AppView) => {
    const i = v.install;
    if (!i) return "";
    return i.via === "official-url"
      ? t("integrations.apps.installPage", { vendor: v.recipe.vendor })
      : t("integrations.apps.installVia", { ref: i.ref, via: i.via });
  };

  const row = (v: AppView) => {
    const id = v.appId;
    const s = v.doc.state;
    const r = v.recipe;
    const kindOk = !v.custom || v.enabled;
    const cliSignin = r.signin.via === "cli" || r.signin.via === "acp";
    const openable = r.kinds.some((k) => k === "desktop-app" || k === "web-app");
    return (
      <li key={id} data-app={id} data-state={s} data-custom={v.custom || undefined}>
        <h3>
          {r.name} <span className="muted">· {r.vendor}</span>
          {v.custom && <span className="badge"> {t("integrations.apps.custom")}</span>}
        </h3>
        <p>
          {t(`integrations.connect.state.${s}`)}
          {v.doc.mode && s === "connected" ? ` · ${t(`integrations.connect.mode.${v.doc.mode}`)}` : ""}
          {v.doc.cli.version ? ` · v${v.doc.cli.version}` : ""}
        </p>
        {v.doc.error && s !== "connected" && <p role="alert">{t(`integrations.connect.error.${v.doc.error}`)}</p>}
        {failure?.appId === id && (
          <p role="alert">
            {t(
              `integrations.apps.failure.${["blocked_by_policy", "provider_busy", "recipe_disabled", "app_unavailable"].includes(failure.code) ? failure.code : "other"}`,
            )}
          </p>
        )}

        {v.custom && enabling?.appId === id ? (
          <div role="group" aria-label={t("integrations.apps.enable")}>
            <p>
              <strong>{enabling.challenge.title}</strong>
            </p>
            <p>{enabling.challenge.warn}</p>
            <ul className="mono">
              {enabling.challenge.summary.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <label>
              {enabling.challenge.type}
              <input
                value={enabling.typed}
                spellCheck={false}
                onChange={(e) => setEnabling({ ...enabling, typed: e.target.value })}
              />
            </label>
            {enabling.result && (
              <p role="alert">
                {t(
                  `integrations.apps.enableResult.${enabling.result === "os_auth_failed" ? "os_auth_failed" : "cancelled"}`,
                )}
              </p>
            )}
            <div className="row">
              <button disabled={busy || enabling.typed.trim() !== id} onClick={() => void finishEnable(enabling)}>
                {t("integrations.apps.enableYes")}
              </button>
              <button disabled={busy} onClick={() => setEnabling(null)}>
                {t("integrations.connect.cancel")}
              </button>
            </div>
          </div>
        ) : v.custom && !v.enabled ? (
          <div className="row">
            <button disabled={busy} onClick={() => void startEnable(id)}>
              {t("integrations.apps.enable")}
            </button>
          </div>
        ) : null}

        {kindOk && v.installRequestedUntil !== null && confirm?.appId !== id && (
          <div role="group" aria-label={t("integrations.connect.install")}>
            <p>{t("integrations.apps.remoteInstall", { name: r.name })}</p>
            <p className="muted">{installText(v)}</p>
            <div className="row">
              <button disabled={busy} onClick={() => void act(id, () => ipc.installApp(id))}>
                {t("integrations.connect.yesInstall")}
              </button>
              <button disabled={busy} onClick={() => void act(id, () => ipc.declineAppInstall(id))}>
                {t("integrations.connect.cancel")}
              </button>
            </div>
          </div>
        )}

        {!kindOk ? null : confirm?.appId === id ? (
          <div role="group" aria-label={t(`integrations.connect.${confirm.kind}`)}>
            <p>
              {confirm.kind === "install" ? (
                <>
                  {installText(v)}{" "}
                  <a href={r.termsUrl} target="_blank" rel="noreferrer">
                    {t("integrations.apps.terms", { vendor: r.vendor })}
                  </a>
                </>
              ) : (
                t("integrations.connect.confirmDisconnect")
              )}
            </p>
            <div className="row">
              <button
                disabled={busy}
                onClick={() =>
                  void act(id, () => (confirm.kind === "install" ? ipc.installApp(id) : ipc.disconnectApp(id)))
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
        ) : keyFor === id ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim()) void saveKey(id);
            }}
          >
            <label>
              {r.apiKey?.label ?? t("integrations.connect.keyLabel")}
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
            {v.supported && !v.doc.cli.installed && s !== "installing" && installText(v) && (
              <button disabled={busy} onClick={() => setConfirm({ appId: id, kind: "install" })}>
                {t("integrations.connect.install")}
              </button>
            )}
            {v.doc.cli.installed && s !== "connected" && s !== "signing_in" && (
              <>
                {r.apiKey && (
                  <button disabled={busy} onClick={() => setKeyFor(id)}>
                    {t("integrations.connect.withKey")}
                  </button>
                )}
                {v.signinAllowed && cliSignin && !r.signin.interactive && (
                  <button disabled={busy} onClick={() => void act(id, () => ipc.signinApp(id))}>
                    {t("integrations.connect.signin")}
                  </button>
                )}
              </>
            )}
            {v.doc.cli.installed && openable && (
              <button disabled={busy} onClick={() => void act(id, () => ipc.launchApp(id))}>
                {t(
                  r.signin.via === "web" || r.signin.via === "desktop-app"
                    ? "integrations.apps.openSignin"
                    : "integrations.apps.open",
                )}
              </button>
            )}
            {(s === "connected" || v.doc.mode !== null) && (
              <button disabled={busy} onClick={() => setConfirm({ appId: id, kind: "disconnect" })}>
                {t("integrations.connect.disconnect")}
              </button>
            )}
            {v.custom && v.enabled && (
              <button disabled={busy} onClick={() => void act(id, () => ipc.disableCustomRecipe(id))}>
                {t("integrations.apps.disable")}
              </button>
            )}
          </div>
        )}
        {kindOk && v.doc.cli.installed && r.signin.interactive && r.signin.command && (
          <p className="muted">{t("integrations.apps.signinTerminal", { cmd: r.signin.command.join(" ") })}</p>
        )}
        {kindOk && v.doc.cli.installed && cliSignin && !v.signinAllowed && s !== "connected" && (
          <p className="muted">{t("integrations.apps.signinOff")}</p>
        )}
      </li>
    );
  };

  if (view === "loading") return null;
  return (
    <section aria-labelledby="ai-title" data-section="apps" className="card">
      <h2 id="ai-title">{t("integrations.connect.title")}</h2>
      {view === "unavailable" ? (
        <p className="muted">{t("security.unavailable")}</p>
      ) : (
        <>
          <p className="muted">{t("integrations.apps.intro")}</p>
          {GROUPS.map((g) => {
            const apps = view.apps.filter((v) => !v.custom && g.kinds.includes(v.recipe.kinds[0]!));
            return apps.length ? (
              <div key={g.id} data-group={g.id}>
                <h3>{t(`integrations.apps.group.${g.id}`)}</h3>
                <ul className="providers">{apps.map(row)}</ul>
              </div>
            ) : null;
          })}
          <div data-group="custom">
            <h3>{t("integrations.apps.group.custom")}</h3>
            <p className="muted">{t("integrations.apps.customHint")}</p>
            <ul className="providers">{view.apps.filter((v) => v.custom).map(row)}</ul>
            {view.problems.map((p) => (
              <p key={p.file} role="alert">
                {t(`integrations.apps.problem.${p.reason}`, { file: p.file })}
              </p>
            ))}
          </div>
        </>
      )}
    </section>
  );
};
