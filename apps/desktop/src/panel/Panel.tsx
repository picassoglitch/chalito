import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertActionsUnavailable } from "@chalito/client";
import type { ChalitoClient } from "@chalito/client";
import type { PhoneVerifier, SettingContext, SettingsValues } from "@chalito/ui";
import { useT } from "../lib/i18n.js";
import { WaitingOn } from "../lib/alert-notice.js";
import type { AgentIpc } from "../lib/ipc.js";
import type { PushToTalk } from "../lib/voice.js";
import type { LocalAgentApi } from "../lib/local-agent.js";
import type { ThisComputerApi } from "../lib/this-computer.js";
import type { UpdateController } from "../lib/updates.js";
import type { RoomsSource } from "../lib/rooms-source.js";
import type { CopiesApi } from "../lib/copies.js";
import type { OwnSessionsFeed } from "../lib/own-sessions.js";
import { OwnSessions, OwnSessionsSettings } from "./OwnSessions.js";
import type { MeetingWatch } from "../lib/meetings.js";
import { CalendarSettings } from "./CalendarSettings.js";
import { Meetings } from "./Meetings.js";
import { Credits } from "./Credits.js";
import { Inbox } from "./Inbox.js";
import { NewSession } from "./NewSession.js";
import { OldCopies } from "./OldCopies.js";
import { PrList, PrSettings } from "./Prs.js";
import { Rooms } from "./Rooms.js";
import { ConnectComputer, type AutoPair } from "./ConnectComputer.js";
import { LocalAgent } from "./LocalAgent.js";
import { Apps } from "./Apps.js";
import { Security } from "./Security.js";
import { SecurityNotices } from "./SecurityNotices.js";
import { SetupChecklist } from "./SetupChecklist.js";
import { Settings } from "./Settings.js";
import { ThisComputer } from "./ThisComputer.js";
import { Updates } from "./Updates.js";
import { Voice } from "./Voice.js";
import { OfflineVoiceButton, VoiceCard, panelVoiceActions, type OfflineVoiceWiring } from "./VoiceCard.js";
import { OfflineVoiceSettings } from "./OfflineVoiceSettings.js";

const TABS = ["inbox", "sessions", "rooms", "settings", "ai", "security", "voice"] as const;
export type Tab = (typeof TABS)[number];

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
  const [codeSid, setCodeSid] = useState<string | null>(null);
  const ov = p.offlineVoice;
  // A fresh object per dictation, so saying the same prompt twice still fills the form.
  const [draft, setDraft] = useState<{ prompt: string } | null>(null);
  const voiceActions = panelVoiceActions({
    client: p.client,
    ipc: p.ipc,
    canStepUp: p.canStepUp ?? false,
    openSession: (sid) => {
      setCodeSid(sid);
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
      <header className="row">
        <nav role="tablist">
          {TABS.map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {t(`tabs.${k}`)}
            </button>
          ))}
        </nav>
        <label className="dnd">
          <input type="checkbox" checked={p.dnd} onChange={(e) => p.onDnd(e.target.checked)} /> {t("dnd")}
        </label>
      </header>
      {ov?.voice && <VoiceCard voice={ov.voice} actions={voiceActions} />}
      {p.copies && <OldCopies api={p.copies} />}
      {p.localAgent && p.openUrl && (
        <ConnectComputer
          ipc={p.ipc}
          openUrl={p.openUrl}
          agentStatus={() => p.localAgent!.status()}
          auto={p.client ? (p.autoPair ?? null) : null}
          signedIn={p.client !== null}
        />
      )}
      <SetupChecklist
        client={p.client}
        ipc={p.ipc}
        {...(p.localAgent ? { agentStatus: () => p.localAgent!.status() } : {})}
        openTab={setTab}
        {...(p.startSignIn ? { startSignIn: p.startSignIn } : {})}
        {...(p.firstTaskUrl ? { firstTaskUrl: p.firstTaskUrl } : {})}
        {...(p.openUrl ? { openUrl: p.openUrl } : {})}
      />
      <main role="tabpanel">
        {tab === "inbox" && p.meetings && (
          <Meetings
            watch={p.meetings}
            {...(p.openUrl ? { openUrl: p.openUrl } : {})}
            onSession={(sid) => {
              setCodeSid(sid);
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
            onSid={(sid) => {
              setCodeSid(sid);
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
        {tab === "settings" && <Credits {...(p.openUrl ? { openUrl: p.openUrl } : {})} />}
        {tab === "ai" && <Apps ipc={p.ipc} />}
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
  );
};
