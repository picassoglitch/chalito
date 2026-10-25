import { useState } from "react";
import { useT } from "../lib/i18n.js";
import { loopbackUrl } from "../lib/offline-voice/engine.js";
import { LANGUAGES, validHotkey, type OfflineVoiceSettings as Values } from "../lib/offline-voice/settings.js";

/** "Comandos de voz sin internet": off until the person turns it on, which is the only time the mic is asked for. */
export const OfflineVoiceSettings = ({
  value,
  onChange,
  askMic,
  probe,
  hotkeyError,
}: {
  value: Values;
  onChange: (v: Values) => void;
  askMic: () => Promise<void>;
  probe: (url: string) => Promise<boolean>;
  /** The OS refused the hotkey (another app holds it). */
  hotkeyError?: string | null;
}) => {
  const t = useT();
  const [micError, setMicError] = useState(false);
  const [url, setUrl] = useState(value.serverUrl);
  const [hotkey, setHotkey] = useState(value.hotkey);
  const [probed, setProbed] = useState<"ok" | "down" | null>(null);
  const urlOk = loopbackUrl(url) !== null;
  const hotkeyOk = validHotkey(hotkey);

  const toggle = async (on: boolean) => {
    setMicError(false);
    if (!on) return onChange({ ...value, enabled: false });
    try {
      await askMic();
      onChange({ ...value, enabled: true });
    } catch {
      setMicError(true);
    }
  };

  return (
    <section aria-labelledby="offline-voice" className="stack" data-offline-voice-settings>
      <h2 id="offline-voice">{t("offlineVoice.settings.title")}</h2>
      <label>
        <input type="checkbox" checked={value.enabled} onChange={(e) => void toggle(e.target.checked)} />{" "}
        {t("offlineVoice.settings.toggle")}
      </label>
      <p className="muted">{t("offlineVoice.settings.privacy")}</p>
      {micError && <p role="alert">{t("offlineVoice.micDenied")}</p>}
      {value.enabled && (
        <>
          <p className="muted">{t("offlineVoice.settings.engineNote")}</p>
          <label>
            {t("offlineVoice.settings.server")}
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => urlOk && onChange({ ...value, serverUrl: url.trim() })}
              aria-invalid={!urlOk}
            />
          </label>
          {!urlOk && <p role="alert">{t("offlineVoice.settings.notLocal")}</p>}
          <div className="row">
            <button
              type="button"
              disabled={!urlOk}
              onClick={() => void probe(url.trim()).then((ok) => setProbed(ok ? "ok" : "down"))}
            >
              {t("offlineVoice.settings.probe")}
            </button>
            {probed && (
              <span role="status">
                {t(probed === "ok" ? "offlineVoice.settings.probeOk" : "offlineVoice.engineDown")}
              </span>
            )}
          </div>
          <fieldset>
            <legend>{t("offlineVoice.settings.languages")}</legend>
            {LANGUAGES.map((l) => (
              <label key={l}>
                <input
                  type="checkbox"
                  checked={value.languages.includes(l)}
                  disabled={value.languages.length === 1 && value.languages.includes(l)}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      languages: e.target.checked ? [...value.languages, l] : value.languages.filter((x) => x !== l),
                    })
                  }
                />{" "}
                {t(`offlineVoice.settings.lang.${l}`)}
              </label>
            ))}
          </fieldset>
          <label>
            {t("offlineVoice.settings.hotkey")}
            <input
              value={hotkey}
              onChange={(e) => setHotkey(e.target.value)}
              onBlur={() => hotkeyOk && onChange({ ...value, hotkey: hotkey.trim() })}
              aria-invalid={!hotkeyOk}
            />
          </label>
          <p className="muted">{t("offlineVoice.settings.hotkeyHelp")}</p>
          {!hotkeyOk && <p role="alert">{t("offlineVoice.settings.badHotkey")}</p>}
          {hotkeyError && <p role="alert">{t("offlineVoice.settings.hotkeyTaken", { reason: hotkeyError })}</p>}
        </>
      )}
    </section>
  );
};
