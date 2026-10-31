import { useEffect, useState, useSyncExternalStore } from "react";
import { useT } from "../lib/i18n.js";
import type { AgentIpc, OwnOpenResult, OwnSessionView } from "../lib/ipc.js";
import { alertId, codexHookSnippet, type OwnSessionsFeed } from "../lib/own-sessions.js";

const MAX_CARDS = 8;

const folderName = (cwd: string | null): string | null => cwd?.split(/[\\/]/).filter(Boolean).pop() ?? null;

export const ownName = (v: Pick<OwnSessionView, "title" | "cwd" | "id">): string =>
  v.title ?? folderName(v.cwd) ?? v.id.slice(0, 8);

type Opened = OwnOpenResult | { opened: false; failed: string };

/** One observed session. Chalito only watches it, so there is no approve or answer button here. */
const OwnCard = ({ v, feed, ipc }: { v: OwnSessionView; feed: OwnSessionsFeed; ipc: AgentIpc }) => {
  const t = useT();
  const [opened, setOpened] = useState<Opened | null>(null);
  const alerting = v.level !== null && !feed.seen.has(alertId(v));
  const state = v.reviewing ? "reviewing" : v.guessed ? "guessed" : v.state;
  const detail = v.detailKey
    ? t(`own.detail.${v.detailKey}${v.detail ? "With" : ""}`, { x: v.detail ?? "" })
    : v.detail;
  const open = () => {
    setOpened(null);
    void ipc.openOwnSession(v.key).then(
      (r) => setOpened(r),
      (e: unknown) => setOpened({ opened: false, failed: e instanceof Error ? e.message : "internal" }),
    );
  };
  const failed = opened && "failed" in opened ? opened.failed : null;
  return (
    <li
      className={`card own-${v.state}${v.seen ? " muted" : ""}`}
      data-own={v.key}
      data-state={v.state}
      data-alert={alerting ? "on" : "off"}
    >
      <strong>{ownName(v)}</strong>{" "}
      <span className="muted">{t(`integrations.connect.agent.${v.source === "claude" ? "anthropic" : "openai"}`)}</span>
      <p data-own-state>{t(`own.state.${state}`)}</p>
      {detail && <p className="muted">{detail}</p>}
      {(v.state === "approval" || v.state === "question") && !v.reviewing && (
        <p className="muted" data-observed>
          {t("own.observed")}
        </p>
      )}
      <div className="row">
        <button onClick={open}>{t("own.open")}</button>
        {alerting && <button onClick={() => feed.markSeen(v)}>{t("own.seen")}</button>}
      </div>
      {opened !== null && !opened.opened && (
        <p data-open-fallback>
          {failed === "not_found" ? t("own.closed") : t("own.openFallback")}{" "}
          {v.cwd && <span className="mono">{v.cwd}</span>} <span className="mono">{v.id}</span>
        </p>
      )}
    </li>
  );
};

/** "Sesiones que abriste tú", under the inbox: shown only while the watch is on and finds something. */
export const OwnSessions = ({ feed, ipc }: { feed: OwnSessionsFeed; ipc: AgentIpc }) => {
  const t = useT();
  const snap = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  if (snap.enabled !== true || snap.sessions.length === 0) return null;
  return (
    <section aria-labelledby="own-title" data-section="own-sessions">
      <h2 id="own-title">{t("own.title")}</h2>
      {snap.error && (
        <p className="muted" data-own-error>
          {t("own.stale")}
        </p>
      )}
      <ul className="list">
        {snap.sessions.slice(0, MAX_CARDS).map((v) => (
          <OwnCard key={v.key} v={v} feed={feed} ipc={ipc} />
        ))}
      </ul>
    </section>
  );
};

/** The opt-in toggle and the Codex hook the person adds by hand (Chalito never edits ~/.codex). */
export const OwnSessionsSettings = ({
  feed,
  ipc,
  cliCommand,
}: {
  feed: OwnSessionsFeed;
  ipc: AgentIpc;
  cliCommand?: () => Promise<string | null>;
}) => {
  const t = useT();
  const snap = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    void feed.refresh(true);
  }, [feed]);
  useEffect(() => {
    if (snap.enabled && cliCommand) void cliCommand().then(setCommand, () => setCommand(null));
  }, [snap.enabled, cliCommand]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    setFailed(false);
    try {
      feed.confirmed((await ipc.setOwnSessions(on)).enabled);
    } catch {
      setFailed(true);
    }
    await feed.refresh(true);
    setBusy(false);
  };
  const snippet = codexHookSnippet(command);
  const copySnippet = () => {
    const done = navigator.clipboard?.writeText(snippet);
    if (!done) return setCopy("failed");
    void done.then(
      () => setCopy("copied"),
      () => setCopy("failed"),
    );
  };

  return (
    <section aria-labelledby="own-settings-title" data-section="own-sessions-settings" className="card">
      <h2 id="own-settings-title">{t("own.settings.title")}</h2>
      <label data-own-watch={snap.enabled ? "on" : "off"}>
        <input
          type="checkbox"
          checked={snap.enabled === true}
          disabled={busy || snap.enabled === null}
          onChange={(e) => void toggle(e.target.checked)}
        />{" "}
        {t("own.settings.label")}
      </label>
      <p className="muted">{t("own.settings.hint")}</p>
      {snap.enabled === null && <p className="muted">{t("own.settings.unavailable")}</p>}
      {snap.error && snap.enabled !== null && <p className="muted">{t("own.stale")}</p>}
      {failed && <p role="alert">{t("own.settings.failed")}</p>}
      {snap.enabled && (
        <details data-codex-hook>
          <summary>{t("own.hook.title")}</summary>
          <p>{t("own.hook.why")}</p>
          <p>{t("own.hook.steps")}</p>
          {!command && (
            <p className="warn" data-no-command>
              {t("own.hook.noCommand")}
            </p>
          )}
          <pre className="mono" data-snippet>
            {snippet}
          </pre>
          <button onClick={copySnippet}>{copy === "copied" ? t("own.hook.copied") : t("own.hook.copy")}</button>
          {copy === "failed" && <p role="alert">{t("own.hook.copyFailed")}</p>}
          <p className="muted">{t("own.hook.note")}</p>
        </details>
      )}
    </section>
  );
};
