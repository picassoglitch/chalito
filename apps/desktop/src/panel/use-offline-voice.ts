import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OfflineVoice } from "../lib/offline-voice/controller.js";
import { whisperServerEngine } from "../lib/offline-voice/engine.js";
import { askMicPermission, micRecorder, voiceHotkey, type VoiceHotkey } from "../lib/offline-voice/native.js";
import { loadOfflineVoice, saveOfflineVoice, type OfflineVoiceSettings } from "../lib/offline-voice/settings.js";
import type { OfflineVoiceWiring } from "./VoiceCard.js";

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
      void hotkey.set(null).catch(() => undefined);
      return;
    }
    let alive = true;
    // The native side swaps the old hotkey for the new one, so no release in the cleanup.
    hotkey.set(settings.hotkey).then(
      () => alive && setHotkeyError(null),
      (e: unknown) => alive && setHotkeyError(String(e)),
    );
    const off = hotkey.onPtt((down) => void (down ? voice.press() : voice.release()));
    const unsub = voice.subscribe(() => {
      if (["card", "unknown", "error"].includes(voice.state.phase)) showPanel();
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
  }, []);
  // "Pausa a Chalito 20 minutos": Do Not Disturb that turns itself off (Alux's "quiet 20").
  const pause = useCallback(
    (minutes: number) => {
      cancelPause();
      setDnd(true);
      timer.current = setTimeout(() => {
        timer.current = null;
        setDnd(false);
      }, minutes * 60_000);
    },
    [cancelPause, setDnd],
  );
  useEffect(() => cancelPause, [cancelPause]);

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
