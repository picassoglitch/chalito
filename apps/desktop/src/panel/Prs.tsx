import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n.js";
import type { AgentIpc } from "../lib/ipc.js";
import { REPO_LIST_MAX, parseRepoList, type PrWatchSettings, type PrWatchView } from "../lib/prs.js";

const READ_MS = 60_000;
const RECENT_SHOWN = 5;

const hintKey = (state: string) => `chalito-pr-hint-${state}`;
/** Fallback when storage is blocked: the Inbox tab unmounts this list, so component state alone would nag. */
const dismissedThisRun = new Set<string>();
const hintDismissed = (state: string) => {
  if (dismissedThisRun.has(state)) return true;
  try {
    return localStorage.getItem(hintKey(state)) === "1";
  } catch {
    return false;
  }
};
/** Tests start each case with nothing dismissed. */
export const forgetDismissedHints = () => dismissedThisRun.clear();
const dismissHint = (state: string) => {
  dismissedThisRun.add(state);
  try {
    localStorage.setItem(hintKey(state), "1");
  } catch {
    // Kept for this run only.
  }
};

/** The agent's view, read on open, on focus and every minute; a failed read keeps the last one. */
const usePrWatch = (ipc: Pick<AgentIpc, "prWatch">, probe = false) => {
  const [view, setLatest] = useState<PrWatchView | null>(null);
  // A slow read (the gh probe) must not undo a newer answer, such as the switch the person just flipped.
  const asked = useRef(0);
  const read = useCallback(() => {
    const n = ++asked.current;
    void ipc.prWatch(probe ? { probe } : undefined).then(
      (v) => n === asked.current && setLatest(v),
      () => undefined,
    );
  }, [ipc, probe]);
  const setView = useCallback((v: PrWatchView) => {
    asked.current++;
    setLatest(v);
  }, []);
  useEffect(() => {
    read();
    const id = setInterval(read, READ_MS);
    window.addEventListener("focus", read);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", read);
    };
  }, [read]);
  return [view, setView] as const;
};

/** Bandeja: the person's open PRs and the latest news, each tied to the session on its branch. */
export const PrList = ({
  ipc,
  openUrl,
}: {
  ipc: Pick<AgentIpc, "prWatch">;
  openUrl?: (url: string) => Promise<void>;
}) => {
  const t = useT();
  const [view] = usePrWatch(ipc);
  const [, setDismissed] = useState(0);
  if (!view?.enabled) return null;

  // One hint, then silence: gh missing or signed out never comes back once dismissed (owner, 2026-10-25).
  if (view.state === "gh_missing" || view.state === "logged_out") {
    if (hintDismissed(view.state)) return null;
    return (
      <section className="card" data-section="prs" data-pr-hint={view.state}>
        <h2>{t("prs.title")}</h2>
        <p className="muted">{t(`prs.hint.${view.state}`)}</p>
        <button
          onClick={() => {
            dismissHint(view.state);
            setDismissed((n) => n + 1);
          }}
        >
          {t("prs.hint.dismiss")}
        </button>
      </section>
    );
  }

  const name = (p: { repo: string; number: number; url: string }) =>
    openUrl ? (
      <button onClick={() => void openUrl(p.url).catch(() => undefined)}>
        {p.repo}#{p.number}
      </button>
    ) : (
      <span>
        {p.repo}#{p.number}
      </span>
    );
  return (
    <section className="card" data-section="prs" aria-labelledby="prs-title">
      <h2 id="prs-title">{t("prs.title")}</h2>
      {view.state === "error" && <p className="muted">{t("prs.error")}</p>}
      {view.prs.length === 0 && view.state === "ok" && <p className="muted">{t("prs.none")}</p>}
      <ul className="list">
        {view.prs.map((p) => (
          <li key={`${p.repo}#${p.number}`} data-pr={`${p.repo}#${p.number}`}>
            {name(p)} {p.title}{" "}
            <span className="muted">
              {[
                p.draft ? t("prs.draft") : null,
                p.review ? t(`prs.review.${p.review}`) : null,
                p.ci ? t(`prs.ci.${p.ci}`) : null,
                p.comments ? t(p.comments === 1 ? "prs.commentsOne" : "prs.comments", { n: p.comments }) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      {view.events.length > 0 && (
        <>
          <h3>{t("prs.recent")}</h3>
          <ul className="list">
            {view.events.slice(0, RECENT_SHOWN).map((e) => (
              <li key={e.key} data-pr-event={e.kind} data-session={e.session?.sid ?? ""}>
                {t(`prs.event.${e.kind}`, { by: e.by ?? "", number: e.number })}{" "}
                <span className="muted">
                  {e.repo} · {e.session ? t("prs.inSession", { label: e.session.label }) : t("prs.general")}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
};

type Problem = { key: string; values?: Record<string, string | number> };

/** Ajustes: off until the person turns it on, with what it reads and an optional repo allow/deny list. */
export const PrSettings = ({ ipc }: { ipc: Pick<AgentIpc, "prWatch" | "setPrWatch"> }) => {
  const t = useT();
  const [view, setView] = usePrWatch(ipc, true);
  const [allow, setAllow] = useState("");
  const [deny, setDeny] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const savedAllow = view?.allow.join(", ") ?? "";
  const savedDeny = view?.deny.join(", ") ?? "";
  useEffect(() => setAllow(savedAllow), [savedAllow]);
  useEffect(() => setDeny(savedDeny), [savedDeny]);
  if (!view) return null;

  const apply = (c: PrWatchSettings) => {
    setBusy(true);
    setProblem(null);
    void ipc
      .setPrWatch(c)
      .then(setView, () => setProblem({ key: "prs.settings.saveFailed" }))
      .finally(() => setBusy(false));
  };
  const saveLists = () => {
    const a = parseRepoList(allow);
    const d = parseRepoList(deny);
    const invalid = [...a.invalid, ...d.invalid];
    if (invalid.length) return setProblem({ key: "prs.settings.invalid", values: { list: invalid.join(", ") } });
    if (a.valid.length > REPO_LIST_MAX || d.valid.length > REPO_LIST_MAX)
      return setProblem({ key: "prs.settings.tooMany", values: { max: REPO_LIST_MAX } });
    apply({ allow: a.valid, deny: d.valid });
  };
  const stopped = view.enabled && (view.state === "gh_missing" || view.state === "logged_out");
  const status =
    view.enabled && view.state === "ok" && view.login
      ? t("prs.settings.watching", { login: view.login })
      : stopped
        ? t(`prs.hint.${view.state}`)
        : !view.enabled && view.gh
          ? t(`prs.settings.gh.${view.gh}`)
          : null;

  return (
    <section className="card" data-section="pr-settings" aria-labelledby="pr-settings-title">
      <h2 id="pr-settings-title">{t("prs.settings.title")}</h2>
      <label>
        <input
          type="checkbox"
          checked={view.enabled}
          disabled={busy}
          onChange={(e) => apply({ enabled: e.target.checked })}
        />{" "}
        {t("prs.settings.toggle")}
      </label>
      <p className="muted">{t("prs.settings.about")}</p>
      {status && (
        <p className="muted" data-pr-status>
          {status}
        </p>
      )}
      {stopped && (
        <button disabled={busy} onClick={() => apply({ enabled: true })}>
          {t("prs.retry")}
        </button>
      )}
      {view.enabled && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            saveLists();
          }}
        >
          <label>
            {t("prs.settings.allow")}
            <input value={allow} onChange={(e) => setAllow(e.target.value)} placeholder={t("prs.settings.listHint")} />
          </label>
          <label>
            {t("prs.settings.deny")}
            <input value={deny} onChange={(e) => setDeny(e.target.value)} placeholder={t("prs.settings.listHint")} />
          </label>
          <button type="submit" disabled={busy}>
            {t("prs.settings.save")}
          </button>
        </form>
      )}
      {problem && <p role="alert">{t(problem.key, problem.values)}</p>}
    </section>
  );
};
