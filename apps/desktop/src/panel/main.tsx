import { StrictMode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Snapshot } from "@chalito/client";
import type { PhoneVerifier } from "@chalito/ui";
import { TextProviders, detectLocale } from "../lib/i18n.js";
import { agentIpc, type AgentIpc } from "../lib/ipc.js";
import { petContext } from "../lib/pet-context.js";
import { PresenceReporter } from "../lib/presence.js";
import { DEFAULT_SETTINGS } from "@chalito/ui";
import { DesktopSettings } from "../lib/settings-sync.js";
import { panelOnLaunch } from "../lib/launch.js";
import { relayRevoked } from "../lib/revoked-relay.js";
import { localAgent } from "../lib/local-agent.js";
import { thisComputer } from "../lib/this-computer.js";
import { shell } from "../lib/shell.js";
import { PushToTalk, unavailableVoice } from "../lib/voice.js";
import { UpdateController, tauriUpdater } from "../lib/updates.js";
import { Panel } from "./Panel.js";
import { SignIn } from "./SignIn.js";
import { DEFAULT_SSO_START_URL, createSession, firstTaskUrl, readEnv, type Connected } from "../lib/session.js";
import type { SignInController } from "../lib/sign-in.js";

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

/**
 * The panel window owns the account connection and the agent IPC; the pet window only
 * renders. Every few seconds it recomputes the pet's context and the presence signals.
 * Until signed in (hub SSO in the system browser → chalito:// deep link → endorsement by
 * a trusted client), the panel opens at launch on the sign-in flow and settings stay on this
 * device; once connected, settings (and the pet's companion) come from the account.
 */
const App = ({ ipc }: { ipc: AgentIpc }) => {
  const sh = useMemo(shell, []);
  const [conn, setConn] = useState<Connected | null>(null);
  const [controller, setController] = useState<SignInController | null>(null);
  useEffect(() => {
    const env = readEnv();
    if (!env) {
      if (panelOnLaunch({ configured: false, connected: false })) void sh.showWindow("panel").catch(() => undefined);
      return;
    }
    let dispose: (() => void) | null = null;
    let alive = true;
    let connected = false;
    void createSession(env, (c) => {
      connected = true;
      if (alive) setConn(c);
    }).then((s) => {
      if (!alive) return s.dispose();
      dispose = s.dispose;
      setController(s.controller);
      // createSession has already tried this device's saved sign-in: not connected means setup.
      if (panelOnLaunch({ configured: true, connected })) void sh.showWindow("panel").catch(() => undefined);
    });
    return () => {
      alive = false;
      dispose?.();
    };
  }, [sh]);
  const client = conn?.client ?? null;
  const ptt = useMemo(() => new PushToTalk(conn?.voice ?? unavailableVoice), [conn]);
  // R-L14: this device was revoked. The room window drops its keys and decrypted events now.
  useEffect(() => (client ? relayRevoked(client.live, () => sh.sendDeviceRevoked()) : undefined), [client, sh]);
  const updates = useMemo(() => new UpdateController(tauriUpdater), []);
  const agentApi = useMemo(localAgent, []);
  const computerApi = useMemo(thisComputer, []);
  // One quiet check per launch; the Settings tab shows the result and offers to install.
  useEffect(() => void updates.check(), [updates]);
  // Server-backed once the desktop has a session; this device's copy until then.
  const store = useMemo(() => new DesktopSettings(conn?.settings ?? null), [conn]);
  useEffect(() => {
    void store.start();
    return () => store.dispose();
  }, [store]);
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const settings = view.values ?? DEFAULT_SETTINGS;
  const [dnd, setDnd] = useState(loadDnd);
  const live = useRef<Pick<Snapshot, "notifications">>({ notifications: [] });

  useEffect(() => {
    const reporter = new PresenceReporter((p) => ipc.reportPresence(p), { onError: () => undefined });
    const tick = async () => {
      if (client) live.current = client.live.getSnapshot();
      const ctx = petContext(live.current, settings, { dnd, fullscreen: false, lowEnergy: false }, new Date());
      await sh.sendPetContext(ctx).catch(() => undefined);
      const idle = await sh.idleMs().catch(() => 0);
      reporter.update({ active: idle < IDLE_AFTER_MS, locked: false, fullscreen: false, dnd });
    };
    void tick();
    const id = setInterval(() => void tick(), SIGNAL_POLL_MS);
    const unsub = client?.live.subscribe(() => void tick());
    const offAck = sh.onPetAck(() => void sh.showWindow("panel"));
    const touch = () => void sh.touchActivity().catch(() => undefined);
    window.addEventListener("keydown", touch);
    return () => {
      clearInterval(id);
      unsub?.();
      void offAck.then((f) => f());
      window.removeEventListener("keydown", touch);
      void reporter.stop();
    };
  }, [client, ipc, sh, settings, dnd]);

  return (
    <Panel
      client={client}
      canStepUp={conn?.canStepUp ?? false}
      signIn={<SignIn controller={controller} />}
      ipc={ipc}
      rooms={conn?.rooms ?? null}
      ptt={ptt}
      settings={view.values}
      onSetting={(k, v) => store.set(k, v)}
      settingsError={view.error}
      dnd={dnd}
      onDnd={(on) => {
        setDnd(on);
        try {
          localStorage.setItem("chalito-desktop-dnd", on ? "1" : "0");
        } catch {
          // Not persisted; still applies for this run.
        }
      }}
      hubPlansUrl={HUB_PLANS_URL}
      phoneVerifier={offlinePhoneVerifier}
      updates={updates}
      localAgent={agentApi}
      thisComputer={computerApi}
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
