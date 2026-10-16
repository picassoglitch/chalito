import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ChalitoClient } from "@chalito/client";
import { setupChecklist, type SetupStep } from "@chalito/ui";
import { useT } from "../lib/i18n.js";
import type { AgentIpc, AppView } from "../lib/ipc.js";
import type { AgentStatus } from "../lib/local-agent.js";

/** How often the checklist re-reads this computer while something is left to do. */
export const SETUP_POLL_MS = 5000;

/** The kinds Chalito starts sessions with (the hub's START_ADAPTERS). */
const SESSION_KINDS = new Set(["claude-sdk", "codex", "acp"]);
/** An app counts once Chalito trusts its CLI here (First Run C's "Usar"). */
export const pinnedSessionApps = (apps: readonly AppView[]): string[] =>
  apps.filter((a) => a.pin?.state === "pinned" && a.recipe.kinds.some((k) => SESSION_KINDS.has(k))).map((a) => a.appId);

const NO_SESSIONS = { sessions: [] as readonly unknown[] };
const noop = () => () => undefined;

/**
 * First Run D (ADR 0028 §6): the same checklist as the hub's Inicio, read from this computer's own
 * state (signed in, paired, pinned apps, folders, sessions). It can't be ticked by hand, and it
 * disappears once everything is done. Each open step has one button to the place that does it.
 */
export const SetupChecklist = ({
  client,
  ipc,
  agentStatus,
  openTab,
  firstTaskUrl,
  openUrl,
  pollMs = SETUP_POLL_MS,
}: {
  client: Pick<ChalitoClient, "live"> | null;
  ipc: AgentIpc;
  agentStatus?: () => Promise<AgentStatus>;
  openTab: (tab: "inbox" | "ai" | "settings") => void;
  /** The hub's New Session with the ready-made first task. */
  firstTaskUrl?: string;
  openUrl?: (url: string) => Promise<void>;
  pollMs?: number;
}) => {
  const t = useT();
  const [paired, setPaired] = useState(false);
  const [adapters, setAdapters] = useState<string[]>([]);
  const [folders, setFolders] = useState(0);
  const live = useSyncExternalStore(
    client?.live.subscribe ?? noop,
    client ? client.live.getSnapshot : () => NO_SESSIONS,
  );

  const read = useCallback(async () => {
    const status = agentStatus ? await agentStatus().catch(() => null) : null;
    const notPaired = status?.state === "not_paired";
    const ws = notPaired ? null : await ipc.workspaces().catch(() => null);
    const apps = notPaired ? null : await ipc.apps().catch(() => null);
    // Paired: the supervisor says so, or (dev builds without one) the agent answers at all.
    setPaired(!notPaired && (status ? status.state !== "no_sidecar" : ws !== null));
    setFolders(ws?.workspaces.length ?? 0);
    setAdapters(apps ? pinnedSessionApps(apps.apps) : []);
  }, [ipc, agentStatus]);

  const state = setupChecklist({
    signedIn: client !== null,
    deviceReady: client !== null,
    computers: paired ? [{ adapters, workspaces: folders }] : [],
    sessions: live.sessions.length,
  });

  useEffect(() => {
    if (state.complete) return;
    void read();
    const timer = setInterval(() => void read(), pollMs);
    return () => clearInterval(timer);
  }, [read, pollMs, state.complete]);

  if (state.complete) return null;

  const action = (id: SetupStep) => {
    switch (id) {
      case "account":
      case "browser":
        return { label: t("setup.action.signIn"), run: () => openTab("inbox") };
      case "computer":
        return null; // The "Conectar esta computadora" card is right above.
      case "ai":
        return { label: t("setup.action.ai"), run: () => openTab("ai") };
      case "folder":
        return { label: t("setup.action.folder"), run: () => openTab("settings") };
      case "firstTask":
        return firstTaskUrl && openUrl
          ? { label: t("setup.action.firstTask"), run: () => void openUrl(firstTaskUrl).catch(() => undefined) }
          : null;
    }
  };

  return (
    <section className="card setup" aria-labelledby="setup-title" data-testid="setup-checklist">
      <h2 id="setup-title">{t("setup.title")}</h2>
      <p className="muted">{t("setup.progress", { done: state.doneCount, total: state.steps.length })}</p>
      <ol>
        {state.steps.map(({ id, done }) => {
          const current = id === state.current;
          const a = current ? action(id) : null;
          return (
            <li key={id} data-step={id} data-done={done} aria-current={current ? "step" : undefined}>
              <span aria-hidden>{done ? "✓" : current ? "→" : "○"}</span> {t(`setup.step.${id}`)}
              {current ? <p className="muted">{t(`setup.hint.${id}`)}</p> : null}
              {a ? (
                <button type="button" onClick={a.run} data-testid={`setup-go-${id}`}>
                  {a.label}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
};
