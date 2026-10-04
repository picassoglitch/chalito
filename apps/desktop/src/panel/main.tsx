import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ChalitoClient, Snapshot } from "@chalito/client";
import type { PhoneVerifier } from "@chalito/ui";
import { TextProviders, detectLocale } from "../lib/i18n.js";
import { unavailableIpc, type AgentIpc } from "../lib/ipc.js";
import { petContext } from "../lib/pet-context.js";
import { PresenceReporter } from "../lib/presence.js";
import { loadSettings, saveSettings } from "../lib/settings-store.js";
import { shell } from "../lib/shell.js";
import { PushToTalk, unavailableVoice } from "../lib/voice.js";
import { Panel } from "./Panel.js";

const IDLE_AFTER_MS = 2 * 60 * 1000;
const SIGNAL_POLL_MS = 5_000;
const HUB_PLANS_URL = `${(import.meta.env.VITE_HUB_URL ?? "").replace(/\/+$/, "")}/planes`;

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
 * The desktop client's own enrollment (keys + session for this panel) is a follow-up: until
 * then `client` is null and the inbox says it isn't connected.
 */
const App = ({ client, ipc }: { client: ChalitoClient | null; ipc: AgentIpc }) => {
  const sh = useMemo(shell, []);
  const ptt = useMemo(() => new PushToTalk(unavailableVoice), []);
  const [settings, setSettings] = useState(loadSettings);
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
      ipc={ipc}
      ptt={ptt}
      settings={settings}
      onSettings={(v) => {
        setSettings(v);
        saveSettings(v);
      }}
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
    />
  );
};

const locale = detectLocale();
document.documentElement.lang = locale;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TextProviders locale={locale}>
      <App client={null} ipc={unavailableIpc} />
    </TextProviders>
  </StrictMode>,
);
