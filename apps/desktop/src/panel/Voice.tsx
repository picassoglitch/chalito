import { useSyncExternalStore } from "react";
import { useT } from "../lib/i18n.js";
import { VoiceUnavailableError, type PushToTalk } from "../lib/voice.js";

export const Voice = ({ ptt }: { ptt: PushToTalk }) => {
  const t = useT();
  const state = useSyncExternalStore(ptt.subscribe, () => ptt.state);
  const label =
    state === "connecting" ? t("voice.connecting") : state === "listening" ? t("voice.listening") : t("voice.hold");
  return (
    <div className="stack">
      <button
        className={`ptt ptt-${state}`}
        aria-pressed={state === "listening"}
        onPointerDown={() => void ptt.press()}
        onPointerUp={() => void ptt.release()}
        onPointerLeave={() => void ptt.release()}
        onKeyDown={(e) => e.key === " " && !e.repeat && void ptt.press()}
        onKeyUp={(e) => e.key === " " && void ptt.release()}
      >
        {label}
      </button>
      {state === "error" && (
        <p role="alert">{ptt.error instanceof VoiceUnavailableError ? t("voice.unavailable") : String(ptt.error)}</p>
      )}
    </div>
  );
};
