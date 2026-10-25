import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OfflineVoice } from "../lib/offline-voice/controller.js";
import { whisperServerEngine } from "../lib/offline-voice/engine.js";
import { askMicPermission, micRecorder, voiceHotkey, type VoiceHotkey } from "../lib/offline-voice/native.js";
import { loadOfflineVoice, saveOfflineVoice, type OfflineVoiceSettings } from "../lib/offline-voice/settings.js";
import type { OfflineVoiceWiring } from "./VoiceCard.js";

const PAUSE_KEY = "chalito-desktop-dnd-until";
const stored = (): number | null => {
  try {
    const v = Number(localStorage.getItem(PAUSE_KEY));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
};
const store = (until: number | null) => {
  try {
    if (until === null) localStorage.removeItem(PAUSE_KEY);
    else localStorage.setItem(PAUSE_KEY, String(until));
  } catch (e) {
    console.warn("offline-voice: pause not saved", e);
  }
};

/** Offline voice for the panel: the controller while the mode is on, the hotkey only then, and timed pauses. */
export const useOfflineVoice = (
  setDnd: (on: boolean) => void,
  showPanel: () => void,
  deps: { hotkey?: VoiceHotkey; voice?: (s: OfflineVoiceSettings) => OfflineVoice } = {},
): OfflineVoiceWiring & { cancelPause: () => void } => {
  const [settings, setSettings] = useState(loadOfflineVoice);
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const hotkey = useMemo(() => deps.hotkey ?? voiceHotkey(), [deps.hotkey]);
  const make = deps.voice;
  const langs = settings.languages.join(",");
  const voice = useMemo(
    () =>
      !settings.enabled
        ? null
        : make
          ? make(settings)
          : new OfflineVoice({
              recorder: micRecorder(),
              engine: whisperServerEngine({ url: settings.serverUrl, languages: langs.split(",") }),
            }),
    [settings.enabled, settings.serverUrl, langs, make],
  );

  useEffect(() => {
    if (!voice) {
      void hotkey.set(null).catch((e: unknown) => console.warn("offline-voice: hotkey release", e));
      return;
    }
    let alive = true;
    const failed = (e: unknown) => {
      console.warn("offline-voice: hotkey", e);
      if (alive) setHotkeyError(String(e));
    };
    // The native side swaps the old hotkey for the new one, so no release in the cleanup.
    hotkey.set(settings.hotkey).then(() => alive && setHotkeyError(null), failed);
    const off = hotkey
      .onPtt((down) => void (down ? voice.press() : voice.release()))
      .catch((e: unknown) => {
        failed(e);
        return () => undefined;
      });
    const unsub = voice.subscribe(() => {
      if (["card", "unknown", "nothing", "error"].includes(voice.state.phase)) showPanel();
    });
    return () => {
      alive = false;
      unsub();
      void off.then((f) => f());
    };
  }, [voice, hotkey, settings.hotkey, showPanel]);
  useEffect(() => () => voice?.dismiss(), [voice]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPause = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    store(null);
  }, []);
  const arm = useCallback(
    (until: number) => {
      if (timer.current) clearTimeout(timer.current);
      store(until);
      timer.current = setTimeout(
        () => {
          timer.current = null;
          store(null);
          setDnd(false);
        },
        Math.max(0, until - Date.now()),
      );
    },
    [setDnd],
  );
  // "Pausa a Chalito 20 minutos": Do Not Disturb that turns itself off (Alux's "quiet 20").
  const pause = useCallback(
    (minutes: number) => {
      setDnd(true);
      arm(Date.now() + minutes * 60_000);
    },
    [arm, setDnd],
  );
  // The end is saved, so a restart mid-pause still turns DND off on time.
  useEffect(() => {
    const until = stored();
    if (until !== null) arm(until);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [arm]);

  return {
    voice,
    settings,
    onSettings: (v) => {
      saveOfflineVoice(v);
      setSettings(v);
    },
    askMic: () => askMicPermission(),
    probe: (url) => whisperServerEngine({ url, languages: [] }).probe(),
    hotkeyError,
    pause,
    cancelPause,
  };
};
