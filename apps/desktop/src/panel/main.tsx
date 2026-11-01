import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Snapshot } from "@chalito/client";
import type { PhoneVerifier } from "@chalito/ui";
import { TextProviders, detectLocale } from "../lib/i18n.js";
import { agentIpc, type AgentIpc } from "../lib/ipc.js";
import { ActivityTracker } from "@chalito/avatar";
import { LoadWatch, pendingAnswers, petContext } from "../lib/pet-context.js";
import {
  OwnSessionsFeed,
  mergeActivity,
  maxLevel,
  ownLevel,
  ownNotices,
  ownSessionLikes,
} from "../lib/own-sessions.js";
import { PrFeed, withPrNews } from "../lib/prs.js";
import { MeetingWatch, withMeetingLevel } from "../lib/meetings.js";
import { meetingsIpc } from "../lib/meetings-ipc.js";
import { PresenceReporter } from "../lib/presence.js";
import { DEFAULT_SETTINGS } from "@chalito/ui";
import { DesktopSettings } from "../lib/settings-sync.js";
import { relayRevoked } from "../lib/revoked-relay.js";
import { localAgent } from "../lib/local-agent.js";
import { thisComputer } from "../lib/this-computer.js";
import { copiesApi } from "../lib/copies.js";
import { shell } from "../lib/shell.js";
import { PushToTalk, unavailableVoice } from "../lib/voice.js";
import { UpdateController, tauriUpdater } from "../lib/updates.js";
import { isTauri } from "@tauri-apps/api/core";
import { BoardLink } from "../lib/board/link.js";
import { tauriBoardPort } from "../lib/board/tauri-port.js";
import { idbPairStore } from "../lib/board/pairing.js";
import { attachBoardApprovals } from "../lib/board/approvals.js";
import { StateSince, boardSessions } from "../lib/board/sessions.js";
import { Panel } from "./Panel.js";
import { SignIn } from "./SignIn.js";
import { useOfflineVoice } from "./use-offline-voice.js";
import { DEFAULT_SSO_START_URL, firstTaskUrl, readEnv } from "../lib/session.js";
import { useAccountSession } from "./use-account-session.js";

const IDLE_AFTER_MS = 2 * 60 * 1000;
const SIGNAL_POLL_MS = 5_000;
const HUB_PLANS_URL = `${(import.meta.env.VITE_HUB_URL ?? "").replace(/\/+$/, "")}/planes`;
/** The hub's New Session with the ready-made first task, on the same site as the desktop sign-in. */
const FIRST_TASK_URL = firstTaskUrl(readEnv()?.ssoStartUrl ?? DEFAULT_SSO_START_URL);

/** Phone codes go through the api with the account session; the desktop has none yet. */
const offlinePhoneVerifier: PhoneVerifier = {
  start: async () => ({ ok: false, reason: "error" }),
  check: async () => ({ ok: false, reason: "error" }),
};

const loadDnd = () => {
  try {
    return localStorage.getItem("chalito-desktop-dnd") === "1";
  } catch {
    return false;
  }
};

/** Owns the account connection and agent IPC (the pet only renders); recomputes pet context and presence. Until
 * signed in (hub SSO → chalito:// link enrols this computer) it opens on sign-in and settings stay on this device. */
const App = ({ ipc }: { ipc: AgentIpc }) => {
  const sh = useMemo(shell, []);
  const showPanel = useCallback(() => void sh.showWindow("panel").catch(() => undefined), [sh]);
  const { conn, setup } = useAccountSession(showPanel);
  const controller = setup.state === "ready" && !setup.restoring ? setup.controller : null;
  const client = conn?.client ?? null;
  const ptt = useMemo(() => new PushToTalk(conn?.voice ?? unavailableVoice), [conn]);
  const updates = useMemo(() => new UpdateController(tauriUpdater), []);
  const agentApi = useMemo(localAgent, []);
  const computerApi = useMemo(thisComputer, []);
  const copies = useMemo(copiesApi, []);
  const meetings = useMemo(() => new MeetingWatch(meetingsIpc()), []);
  useEffect(() => meetings.start(), [meetings]);
  // BOARD_LINK: the LCD's approvals screen decides through this window's ClientActions.
  const board = useMemo(() => (isTauri() ? new BoardLink(tauriBoardPort, idbPairStore()) : null), []);
  useEffect(() => {
    board?.start();
    return () => board?.stop();
  }, [board]);
  useEffect(() => (board && client ? attachBoardApprovals(board, client) : undefined), [board, client]);
  // One quiet check per launch; the Settings tab shows the result and offers to install.
  useEffect(() => void updates.check(), [updates]);
  // Server-backed once the desktop has a session; this device's copy until then.
  const store = useMemo(() => new DesktopSettings(conn?.settings ?? null), [conn]);
  useEffect(() => {
    void store.start();
    return () => store.dispose();
  }, [store]);
  // R-L14: this device was revoked. The room window drops its keys and decrypted events now,
  // and the account's companion leaves the device copy.
  useEffect(
    () =>
      client
        ? relayRevoked(client.live, async () => {
            store.forgetAccount();
            await sh.sendDeviceRevoked();
          })
        : undefined,
    [client, sh, store],
  );
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const settings = view.values ?? DEFAULT_SETTINGS;
  const [dnd, setDnd] = useState(loadDnd);
  // ADR 0032 — something only the person can answer brings the panel forward; "No molestar" holds it.
  const needsYou = useCallback(() => {
    if (!dnd) showPanel();
  }, [showPanel, dnd]);
  // A pairing check only the person can answer comes forward even under DND: they just started it.
  const pairingNeedsYou = showPanel;
  const applyDnd = useCallback((on: boolean) => {
    setDnd(on);
    try {
      localStorage.setItem("chalito-desktop-dnd", on ? "1" : "0");
    } catch {
      // Not persisted; still applies for this run.
    }
  }, []);
  const offlineVoice = useOfflineVoice(applyDnd, showPanel);
  const live = useRef<Pick<Snapshot, "notifications" | "approvals" | "sessions" | "events" | "devices">>({
    notifications: [],
    approvals: [],
    sessions: [],
    events: {},
    devices: [],
  });
  // One per connection, priming once its data has loaded: what happened before isn't news.
  const activity = useMemo(() => ({ tracker: new ActivityTracker(), load: new LoadWatch() }), [client]);
  // PR news counts once per panel run; read on its own clock so the tick never waits on the agent.
  const prFeed = useMemo(() => new PrFeed(() => ipc.prWatch()), [ipc]);
  useEffect(() => {
    void prFeed.refresh();
    const id = setInterval(() => void prFeed.refresh(), SIGNAL_POLL_MS);
    return () => clearInterval(id);
  }, [prFeed]);
  // Sessions the person started outside Chalito: their own clock and tracker, like the PR feed.
  const ownFeed = useMemo(() => new OwnSessionsFeed(ipc), [ipc]);
  const ownTracker = useMemo(() => new ActivityTracker(), [ownFeed]);
  const sessionSince = useMemo(() => new StateSince(), []);
  useEffect(() => {
    void ownFeed.refresh();
    const id = setInterval(() => void ownFeed.refresh(), SIGNAL_POLL_MS);
    return () => clearInterval(id);
  }, [ownFeed]);

  useEffect(() => {
    const reporter = new PresenceReporter((p) => ipc.reportPresence(p), { onError: () => undefined });
    const tick = async () => {
      const snap = client?.live.getSnapshot();
      if (snap) live.current = snap;
      const { sessions, events, notifications } = live.current;
      const learning = activity.load.loading(snap?.status, Date.now());
      const own = ownFeed.getSnapshot();
      // BOARD_LINK: the LCD lists these on its double-click screen when nothing waits on the person.
      try {
        board?.sessions(boardSessions(live.current, own.sessions, undefined, sessionSince));
      } catch {
        // Never let the board's overview stop the pet context or presence below.
      }
      const ownAct = ownTracker.update(ownSessionLikes(own.sessions), 0, {
        notifications: ownNotices(own.sessions, ownFeed.seen),
      });
      const act = mergeActivity(
        withPrNews(
          activity.tracker.update(sessions, pendingAnswers(live.current), { events, notifications, learning }),
          prFeed.counts(Date.now()),
        ),
        ownAct,
      );
      // The person reading the panel already sees replies: the pet doesn't perk at them (owner, 2026-10-25).
      const panelFocused = document.hasFocus() && document.visibilityState === "visible";
      const local = { dnd, fullscreen: false, lowEnergy: false, panelFocused };
      const base = petContext(live.current, settings, local, new Date(), act);
      const withOwn = { ...base, level: maxLevel(base.level, ownLevel(own.sessions, ownFeed.seen)) };
      const ctx = withMeetingLevel(withOwn, meetings.level());
      await sh.sendPetContext(ctx).catch(() => undefined);
      const idle = await sh.idleMs().catch(() => 0);
      reporter.update({ active: idle < IDLE_AFTER_MS, locked: false, fullscreen: false, dnd });
    };
    void tick();
    const id = setInterval(() => void tick(), SIGNAL_POLL_MS);
    const unsub = client?.live.subscribe(() => void tick());
    const unsubMeetings = meetings.subscribe(() => void tick());
    const offAck = sh.onPetAck(() => void sh.showWindow("panel"));
    const touch = () => void sh.touchActivity().catch(() => undefined);
    window.addEventListener("keydown", touch);
    return () => {
      clearInterval(id);
      unsub?.();
      unsubMeetings();
      void offAck.then((f) => f());
      window.removeEventListener("keydown", touch);
      void reporter.stop();
    };
  }, [client, ipc, sh, settings, dnd, activity, prFeed, ownFeed, ownTracker, meetings, board, sessionSince]);

  return (
    <Panel
      client={client}
      canStepUp={conn?.canStepUp ?? false}
      signIn={<SignIn setup={setup} />}
      autoPair={conn?.autoPair ?? null}
      onNeedsYou={needsYou}
      onPairingNeedsYou={pairingNeedsYou}
      {...(controller ? { startSignIn: () => void controller.start() } : {})}
      ipc={ipc}
      ownFeed={ownFeed}
      rooms={conn?.rooms ?? null}
      ptt={ptt}
      settings={view.values}
      onSetting={(k, v) => store.set(k, v)}
      settingsError={view.error}
      dnd={dnd}
      onDnd={(on) => {
        offlineVoice.cancelPause();
        applyDnd(on);
      }}
      offlineVoice={offlineVoice}
      hubPlansUrl={HUB_PLANS_URL}
      phoneVerifier={offlinePhoneVerifier}
      updates={updates}
      localAgent={agentApi}
      thisComputer={computerApi}
      copies={copies}
      meetings={meetings}
      board={board}
      openUrl={(url) => openUrl(url)}
      {...(FIRST_TASK_URL ? { firstTaskUrl: FIRST_TASK_URL } : {})}
    />
  );
};

const locale = detectLocale();
document.documentElement.lang = locale;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TextProviders locale={locale}>
      <App ipc={agentIpc()} />
    </TextProviders>
  </StrictMode>,
);
