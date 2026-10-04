import { useSyncExternalStore } from "react";
import { useT } from "../lib/i18n.js";
import { VoiceRefusedError } from "../lib/webrtc-voice.js";
import { VoiceEndedError, VoiceUnavailableError, type PushToTalk } from "../lib/voice.js";
import type { Translate } from "@chalito/ui";

/** The server's reason, in words: a hang-up is the monthly minutes running out. */
const errorText = (t: Translate, e: unknown): string => {
  if (e instanceof VoiceUnavailableError) return t("voice.unavailable");
  const reason = e instanceof VoiceEndedError ? e.reason : e instanceof VoiceRefusedError ? e.code : null;
  switch (reason) {
    case "cap":
    case "hangup":
    case "voice_cap_reached":
      return t("voice.capReached");
    case "max":
      return t("voice.maxReached");
    case "stopped":
    case "voice_not_admitted":
      return t("voice.noCredits");
    case "ended":
      return t("voice.ended");
    default:
      return t("voice.failed");
  }
};

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
      {state === "error" && <p role="alert">{errorText(t, ptt.error)}</p>}
    </div>
  );
};
