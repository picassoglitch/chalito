import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertActionsUnavailable } from "@chalito/client";
import type { ChalitoClient } from "@chalito/client";
import type { PhoneVerifier, SettingContext, SettingsValues } from "@chalito/ui";
import { useT } from "../lib/i18n.js";
import { THEMES, applyTheme, loadTheme, type Theme } from "../lib/theme.js";
import { WaitingOn } from "../lib/alert-notice.js";
import type { AgentIpc } from "../lib/ipc.js";
import type { PushToTalk } from "../lib/voice.js";
import type { LocalAgentApi } from "../lib/local-agent.js";
import type { ThisComputerApi } from "../lib/this-computer.js";
import type { UpdateController } from "../lib/updates.js";
import type { RoomsSource } from "../lib/rooms-source.js";
import type { CopiesApi } from "../lib/copies.js";
import { ApprovalPopup } from "./ApprovalPopup.js";
import type { OwnSessionsFeed } from "../lib/own-sessions.js";
import { OwnSessions, OwnSessionsSettings } from "./OwnSessions.js";
import type { MeetingWatch } from "../lib/meetings.js";
import { CalendarSettings } from "./CalendarSettings.js";
import { Meetings } from "./Meetings.js";
import { Inbox } from "./Inbox.js";
import { NewSession } from "./NewSession.js";
import { OldCopies } from "./OldCopies.js";
import { PrList, PrSettings } from "./Prs.js";
import { Rooms } from "./Rooms.js";
import { ConnectComputer, type AutoPair } from "./ConnectComputer.js";
import { LocalAgent } from "./LocalAgent.js";
import { Apps } from "./Apps.js";
import { NativeConnections } from "./NativeConnections.js";
import { RemoteTools } from "./RemoteTools.js";
import { Security } from "./Security.js";
import { SecurityNotices } from "./SecurityNotices.js";
import { SetupChecklist } from "./SetupChecklist.js";
import { Settings } from "./Settings.js";
import { ThisComputer } from "./ThisComputer.js";
import { Updates } from "./Updates.js";
import { Voice } from "./Voice.js";
import { OfflineVoiceButton, VoiceCard, panelVoiceActions, type OfflineVoiceWiring } from "./VoiceCard.js";
import { OfflineVoiceSettings } from "./OfflineVoiceSettings.js";
import { BoardNotice, BoardSettings } from "./BoardNotice.js";
import type { BoardLink } from "../lib/board/link.js";

export type Tab = "inbox" | "sessions" | "rooms" | "ai" | "voice" | "security" | "settings";
/** Sidebar groups: daily use first, then the tools Chalito uses, then account and safety at the bottom. */
const NAV: readonly { key: "main" | "tools" | "account"; tabs: readonly Tab[] }[] = [
  { key: "main", tabs: ["inbox", "sessions", "rooms"] },
  { key: "tools", tabs: ["ai", "voice"] },
  { key: "account", tabs: ["security", "settings"] },
];

/** Stroke icons for the sidebar, 18 px, drawn on a 24 grid. */
const ICON: Record<Tab, ReactNode> = {
  inbox: <path d="M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z" />,
  sessions: <path d="M4 5h16v11H9l-5 4z" />,
  rooms: (
    <>
      <circle cx="9" cy="9" r="3" />
      <circle cx="17" cy="10" r="2.5" />
      <path d="M3 19c0-3 3-5 6-5s6 2 6 5M15 15c3 0 6 1.5 6 4" />
    </>
  ),
  ai: <path d="M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM19 15l1 2.5 2.5 1-2.5 1L19 22l-1-2.5-2.5-1 2.5-1z" />,
  voice: <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3" />,
  security: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
    </>
  ),
};
const Icon = ({ tab }: { tab: Tab }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {ICON[tab]}
  </svg>
);

export interface PanelProps {
  client: (Pick<ChalitoClient, "live" | "actions"> & Partial<Pick<ChalitoClient, "alerts">>) | null;
  /** This device holds a passkey for HIGH/CRITICAL step-up. */
  canStepUp?: boolean;
  /** Shown instead of the "not connected" note while signed out (the sign-in flow). */
  signIn?: ReactNode;
  /** Starts the sign-in (opens the hub in the browser): the checklist's "Sign in". */
  startSignIn?: () => void;
  /** Signed in: connects this computer by itself (owner decision 2026-10-19). */
  autoPair?: AutoPair | null;
  /** ADR 0032 — an approval is waiting: bring the panel forward. */
  onNeedsYou?: () => void;
  /** ADR 0032 — a pairing check only the person can answer (not held back by DND). */
  onPairingNeedsYou?: () => void;
  ipc: AgentIpc;
  /** Sessions the person started outside Chalito (opt-in); absent in tests that don't need them. */
  ownFeed?: OwnSessionsFeed;
  ptt: PushToTalk;
  /** null while loading. */
  settings: SettingsValues | null;
  onSetting: SettingContext["set"];
  settingsError?: "rejected" | "failed" | null;
  dnd: boolean;
  onDnd: (on: boolean) => void;
  hubPlansUrl: string;
  phoneVerifier: PhoneVerifier;
  updates?: UpdateController;
  /** The bundled agent and the `chalito` command (release builds). */
  localAgent?: LocalAgentApi;
  /** Start with the computer and the folder picker (First Run C). */
  thisComputer?: ThisComputerApi;
  /** The system browser (tauri-plugin-opener), for the pairing approval page. */
  openUrl?: (url: string) => Promise<void>;
  /** The hub's New Session with the ready-made first task (First Run D). */
  firstTaskUrl?: string;
  /** Salas: the rooms list and join; null while signed out. */
  rooms?: RoomsSource | null;
  /** Other copies of Chalito on this computer; null without the native side. */
  copies?: CopiesApi | null;
  /** Voice commands without internet (this device's setting). */
  offlineVoice?: OfflineVoiceWiring;
  /** Meeting warnings and follow-ups from the agent; absent outside the app. */
  meetings?: MeetingWatch;
  /** The LCD board over USB; absent outside the app. */
  board?: Pick<BoardLink, "subscribe" | "getSnapshot" | "pair" | "forget"> | null;
  initialTab?: Tab;
}

const localStore = (): Storage | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

export const Panel = (p: PanelProps) => {
  const t = useT();
  const [tab, setTab] = useState<Tab>(p.initialTab ?? "inbox");
  const [theme, setTheme] = useState<Theme>(loadTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const [codeSid, setCodeSid] = useState<string | null>(null);
  const [codeRemote, setCodeRemote] = useState(false);
  const ov = p.offlineVoice;
  // A fresh object per dictation, so saying the same prompt twice still fills the form.
  const [draft, setDraft] = useState<{ prompt: string } | null>(null);
  const voiceActions = panelVoiceActions({
    client: p.client,
    ipc: p.ipc,
    canStepUp: p.canStepUp ?? false,
    openSession: (sid) => {
      setCodeSid(sid);
      setCodeRemote(p.client !== null);
      setTab("sessions");
    },
    openNewSession: (prompt) => {
      setCodeSid(null);
      setDraft(prompt ? { prompt } : null);
      setTab("sessions");
    },
    pause: (m) => ov?.pause(m),
    setDnd: p.onDnd,
  });
  const waiting = useMemo(() => new WaitingOn(localStore()), []);
  const alerts = p.client?.alerts;
  // Opening a session here counts as seen: its alerts rest, with one gentle re-nudge later (from Alux, by Omar).
  useEffect(() => {
    if (tab === "sessions" && codeSid && alerts)
      void alerts.seen(codeSid).catch((e: unknown) => {
        // A missing function is reported once by the client, which then stops calling it.
        if (!(e instanceof AlertActionsUnavailable)) console.warn("alerts.seen failed", codeSid, e);
      });
  }, [tab, codeSid, alerts]);
  return (
    <div className="panel-shell">
      <aside className="side">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            C
          </span>
          <span>Chalito</span>
        </div>
        <nav role="tablist" aria-orientation="vertical">
          {NAV.map((g) => (
            <div key={g.key} className="nav-group" data-group={g.key}>
              {g.key !== "main" && <span className="nav-label">{t(`nav.${g.key}`)}</span>}
              {g.tabs.map((k) => (
                <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                  <Icon tab={k} />
                  <span>{t(`tabs.${k}`)}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <div className="theme" role="group" aria-label={t("theme.label")}>
            {THEMES.map((k) => (
              <button key={k} type="button" aria-pressed={theme === k} onClick={() => setTheme(k)}>
                {t(`theme.${k}`)}
              </button>
            ))}
          </div>
          <span className="conn" data-on={p.client !== null}>
            {t(p.client ? "conn.on" : "conn.off")}
          </span>
          <label className="dnd">
            {t("dnd")}
            <input type="checkbox" role="switch" checked={p.dnd} onChange={(e) => p.onDnd(e.target.checked)} />
          </label>
        </div>
      </aside>
      <div className="content" data-tab={tab}>
        <div className="content-inner">
          {tab !== "sessions" && <h1 className="page-title">{t(`tabs.${tab}`)}</h1>}
          {ov?.voice && <VoiceCard voice={ov.voice} actions={voiceActions} />}
          {p.copies && <OldCopies api={p.copies} />}
          {p.board && <BoardNotice link={p.board} />}
          {p.localAgent && p.openUrl && (
            <ConnectComputer
              ipc={p.ipc}
              openUrl={p.openUrl}
              agentStatus={() => p.localAgent!.status()}
              auto={p.client ? (p.autoPair ?? null) : null}
              signedIn={p.client !== null}
              {...(p.onPairingNeedsYou ? { onNeedsYou: p.onPairingNeedsYou } : {})}
            />
          )}
          {p.client && (
            <ApprovalPopup
              client={p.client}
              canStepUp={p.canStepUp ?? false}
              hidden={tab === "inbox"}
              {...(p.onNeedsYou ? { onNew: p.onNeedsYou } : {})}
              onOpenInbox={() => setTab("inbox")}
            />
          )}
          {/* The guide lives on the home tab so it doesn't push every other screen down. */}
          {tab === "inbox" && (
            <SetupChecklist
              client={p.client}
              ipc={p.ipc}
              {...(p.localAgent ? { agentStatus: () => p.localAgent!.status() } : {})}
              openTab={setTab}
              {...(p.startSignIn ? { startSignIn: p.startSignIn } : {})}
              {...(p.firstTaskUrl ? { firstTaskUrl: p.firstTaskUrl } : {})}
              {...(p.openUrl ? { openUrl: p.openUrl } : {})}
            />
          )}
          <main role="tabpanel">
            {tab === "inbox" && p.meetings && (
              <Meetings
                watch={p.meetings}
                {...(p.openUrl ? { openUrl: p.openUrl } : {})}
                onSession={(sid) => {
                  setCodeSid(sid);
                  setCodeRemote(p.client !== null);
                  setTab("sessions");
                }}
              />
            )}
            {tab === "inbox" &&
              (p.client ? (
                <Inbox
                  client={p.client}
                  canStepUp={p.canStepUp ?? false}
                  {...(p.rooms ? { onOpenRoom: (id: string) => void p.rooms!.open(id) } : {})}
                  {...(alerts
                    ? {
                        alerts,
                        waiting,
                        onOpenSession: (sid: string) => {
                          setCodeSid(sid);
                          setTab("sessions");
                        },
                      }
                    : {})}
                />
              ) : (
                (p.signIn ?? <p className="muted">{t("offline")}</p>)
              ))}
            {tab === "inbox" && p.ownFeed && <OwnSessions feed={p.ownFeed} ipc={p.ipc} />}
            {tab === "inbox" && <PrList ipc={p.ipc} {...(p.openUrl ? { openUrl: p.openUrl } : {})} />}
            {tab === "sessions" && (
              <NewSession
                ipc={p.ipc}
                client={p.client}
                canStepUp={p.canStepUp ?? false}
                sid={codeSid}
                remote={codeRemote}
                onSid={(sid, remote = false) => {
                  setCodeSid(sid);
                  setCodeRemote(remote);
                  setDraft(null);
                }}
                {...(draft ? { draft } : {})}
              />
            )}
            {tab === "rooms" &&
              (p.rooms ? <Rooms source={p.rooms} /> : (p.signIn ?? <p className="muted">{t("offline")}</p>))}
            {tab === "settings" && p.settingsError && <p role="alert">{t(`settingsError.${p.settingsError}`)}</p>}
            {tab === "settings" && p.settings && (
              <Settings
                values={p.settings}
                onChange={p.onSetting}
                hubPlansUrl={p.hubPlansUrl}
                phoneVerifier={p.phoneVerifier}
              />
            )}
            {tab === "settings" && p.ownFeed && (
              <OwnSessionsSettings
                feed={p.ownFeed}
                ipc={p.ipc}
                {...(p.localAgent ? { cliCommand: () => p.localAgent!.cliStatus().then((c) => c.command) } : {})}
              />
            )}
            {tab === "settings" && <PrSettings ipc={p.ipc} />}
            {tab === "settings" && ov && (
              <OfflineVoiceSettings
                value={ov.settings}
                onChange={ov.onSettings}
                askMic={ov.askMic}
                probe={ov.probe}
                hotkeyError={ov.hotkeyError}
              />
            )}
            {tab === "settings" && p.thisComputer && <ThisComputer api={p.thisComputer} ipc={p.ipc} />}
            {tab === "settings" && p.meetings && <CalendarSettings watch={p.meetings} />}
            {tab === "settings" && p.updates && <Updates updates={p.updates} />}
            {tab === "settings" && p.board && <BoardSettings link={p.board} />}
            {tab === "ai" && (
              <>
                <NativeConnections ipc={p.ipc} />
                <Apps ipc={p.ipc} />
              </>
            )}
            {tab === "ai" && p.client && <RemoteTools client={p.client} />}
            {tab === "security" && p.localAgent && <LocalAgent api={p.localAgent} />}
            {tab === "security" && p.client && <SecurityNotices client={p.client} />}
            {tab === "security" && <Security ipc={p.ipc} />}
            {tab === "voice" && <Voice ptt={p.ptt} />}
            {tab === "voice" && ov?.voice && <OfflineVoiceButton voice={ov.voice} />}
            {tab === "voice" && ov?.voice && ov.hotkeyError && (
              <p role="alert">{t("offlineVoice.settings.hotkeyTaken", { reason: ov.hotkeyError })}</p>
            )}
          </main>
        </div>
      </div>
    </div>
  );
};
