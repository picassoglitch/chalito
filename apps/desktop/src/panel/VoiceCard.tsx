import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ChalitoClient, Snapshot } from "@chalito/client";
import type { Translate } from "@chalito/ui";
import { useT } from "../lib/i18n.js";
import type { AgentIpc } from "../lib/ipc.js";
import { cardOptions, inAll, runnable, type CardOption } from "../lib/offline-voice/card.js";
import { MicSilentError, type OfflineVoice } from "../lib/offline-voice/controller.js";
import {
  EngineFailedError,
  EngineNotLocalError,
  EngineNotWhisperError,
  EngineTimeoutError,
  EngineUnreachableError,
} from "../lib/offline-voice/engine.js";
import type { OfflineVoiceSettings } from "../lib/offline-voice/settings.js";

class GoneError extends Error {}

/** What a confirmed card can do: the same calls the panel's own buttons make. */
export interface VoiceActions {
  snapshot(): Pick<Snapshot, "approvals" | "sessions">;
  canStepUp: boolean;
  decide(aid: string, allow: boolean): Promise<void>;
  openSession(sid: string): void;
  /** Where a new session would start (the Sessions tab's first app and folder), or null if nowhere. */
  sessionPlace(): Promise<{ app: string; workspace: string } | null>;
  /** Starts it exactly where the card said it would. */
  startSession(prompt: string, where: { app: string; workspace: string }): Promise<void>;
  /** The Sessions tab's form, with the dictated prompt already in it. */
  openNewSession(prompt?: string): void;
  pause(minutes: number): void;
  setDnd(on: boolean): void;
}

/** The mic's or the engine's failure in words the person can act on (also used by Settings). */
export const voiceErrorText = (t: Translate, e: unknown): string => {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return t("offlineVoice.micDenied");
  if (name === "NotFoundError" || name === "OverconstrainedError") return t("offlineVoice.micMissing");
  if (name === "NotReadableError" || name === "AbortError") return t("offlineVoice.micBusy");
  if (e instanceof MicSilentError) return t("offlineVoice.micSilent");
  if (e instanceof EngineUnreachableError || e instanceof EngineNotLocalError) return t("offlineVoice.engineDown");
  if (e instanceof EngineTimeoutError) return t("offlineVoice.engineSlow");
  if (e instanceof EngineNotWhisperError) return t("offlineVoice.notWhisper");
  if (e instanceof EngineFailedError) return t("offlineVoice.engineFailed", { status: e.status });
  return t("offlineVoice.failed");
};
const errorText = voiceErrorText;

const optionText = (t: Translate, o: CardOption, place: { app: string; workspace: string } | null): string => {
  switch (o.kind) {
    case "approve":
    case "deny": {
      const verb = t(`offlineVoice.do.${o.kind}`);
      if (!o.item) return `${verb}: ${t("offlineVoice.nothingPending")}`;
      const more = o.item.more ? ` ${t("offlineVoice.more", { n: o.item.more })}` : "";
      return `${verb}: «${o.item.summary}» (${t("inbox.risk", { risk: o.item.risk })})${more}`;
    }
    case "open":
      return o.session ? t("offlineVoice.do.open", { label: o.session.label }) : t("offlineVoice.do.openNone");
    case "newSession":
      return !o.prompt
        ? t("offlineVoice.do.newForm")
        : place
          ? t("offlineVoice.do.newSession", { prompt: o.prompt, app: place.app, workspace: place.workspace })
          : t("offlineVoice.do.newSessionForm", { prompt: o.prompt });
    case "pause":
      return t("offlineVoice.do.pause", { minutes: o.minutes });
    case "dnd":
      return t(o.on ? "offlineVoice.do.dndOn" : "offlineVoice.do.dndOff");
  }
};

/** Status while listening, then the card. Nothing heard runs anything until its button is clicked. */
export const VoiceCard = ({ voice, actions }: { voice: OfflineVoice; actions: VoiceActions }) => {
  const t = useT();
  const state = useSyncExternalStore(voice.subscribe, () => voice.state);
  const commands = state.phase === "card" ? state.commands : null;
  // Bound once per card: a click acts on the item the person read, not on whatever is first by then.
  const options = useMemo(
    () => (commands ? cardOptions(commands, actions.snapshot(), actions.canStepUp) : []),
    [commands],
  );
  const [done, setDone] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [place, setPlace] = useState<{ app: string; workspace: string } | null>(null);
  const [placing, setPlacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  // The hotkey brings the card up from anywhere: put the keyboard on it.
  useEffect(() => heading.current?.focus(), [options]);
  useEffect(() => {
    setDone(new Set());
    setError(null);
    setPlace(null);
    setPlacing(false);
    if (!options.some((o) => o.kind === "newSession" && o.prompt)) return;
    let live = true;
    setPlacing(true);
    actions
      .sessionPlace()
      .then(
        (p) => live && setPlace(p),
        // Without the agent the option says it found nowhere to start, and opens Sessions instead.
        (e: unknown) => console.warn("offline-voice: where to start a session", e),
      )
      .finally(() => live && setPlacing(false));
    return () => void (live = false);
  }, [options]);

  if (state.phase === "idle") return null;
  if (state.phase !== "card") {
    const line =
      state.phase === "listening"
        ? t("offlineVoice.listening")
        : state.phase === "transcribing"
          ? t("offlineVoice.transcribing")
          : state.phase === "nothing"
            ? t("offlineVoice.heardNothing")
            : state.phase === "unknown"
              ? t("offlineVoice.unknown", { text: state.text })
              : errorText(t, state.error);
    const settled = state.phase !== "listening" && state.phase !== "transcribing";
    return (
      <section className="card voice-card row" data-offline-voice={state.phase}>
        {state.phase === "error" ? <span role="alert">{line}</span> : <span aria-live="polite">{line}</span>}
        <button type="button" onClick={() => voice.dismiss()}>
          {settled ? t("offlineVoice.close") : t("offlineVoice.cancel")}
        </button>
      </section>
    );
  }

  const run = async (i: number): Promise<void> => {
    const o = options[i]!;
    switch (o.kind) {
      case "approve":
      case "deny": {
        const aid = o.item?.aid;
        const still = aid && actions.snapshot().approvals.some((a) => a.aid === aid && a.status === "pending");
        if (!still) throw new GoneError();
        await actions.decide(aid, o.kind === "approve");
        break;
      }
      case "open":
        if (o.session) actions.openSession(o.session.sid);
        break;
      case "newSession":
        if (o.prompt && place) await actions.startSession(o.prompt, place);
        else actions.openNewSession(o.prompt);
        break;
      case "pause":
        actions.pause(o.minutes);
        break;
      case "dnd":
        actions.setDnd(o.on);
        break;
    }
  };
  const click = async (picks: number[]) => {
    setBusy(true);
    const finished = new Set(done);
    let failure: unknown = null;
    // One item failing ("all" with a gone approval) doesn't stop the others.
    for (const i of picks) {
      try {
        await run(i);
        finished.add(i);
        setDone(new Set(finished));
      } catch (e) {
        console.warn("offline-voice: card action", e);
        failure ??= e;
      }
    }
    setBusy(false);
    if (failure)
      return setError(
        failure instanceof GoneError
          ? t("offlineVoice.gone")
          : t("offlineVoice.actionFailed", { reason: String((failure as Error)?.message ?? failure) }),
      );
    const left = options.filter((o, i) => runnable(o) && !finished.has(i));
    if (!left.length) voice.dismiss();
    else setError(null);
  };
  const all = options.map((o, i) => (inAll(o) && !done.has(i) ? i : -1)).filter((i) => i >= 0);
  const blockNote = (o: CardOption) =>
    o.kind === "approve" && o.block && o.block !== "nothing" ? t(`offlineVoice.block.${o.block}`) : null;

  return (
    <section
      className="card voice-card stack"
      data-offline-voice="card"
      aria-labelledby="voice-card-title"
      onKeyDown={(e) => e.key === "Escape" && voice.dismiss()}
    >
      <h2 id="voice-card-title" tabIndex={-1} ref={heading}>
        {options.length > 1 ? t("offlineVoice.which") : t("offlineVoice.confirm")}
      </h2>
      <p className="muted">{t("offlineVoice.heard", { text: state.text })}</p>
      {error && <p role="alert">{error}</p>}
      <ul className="list">
        {options.map((o, i) => (
          <li key={i} className="row" data-voice-option={o.kind}>
            <span className="grow">{optionText(t, o, place)}</span>
            {blockNote(o) && <span className="muted">{blockNote(o)}</span>}
            {done.has(i) ? (
              <span className="pill">{t("offlineVoice.done")}</span>
            ) : (
              <button
                type="button"
                disabled={busy || !runnable(o) || (o.kind === "newSession" && placing)}
                onClick={() => void click([i])}
              >
                {t(`offlineVoice.button.${o.kind}`)}
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="row">
        {all.length > 1 && (
          <button type="button" disabled={busy || placing} onClick={() => void click(all)}>
            {options.some((o) => o.kind === "approve") ? t("offlineVoice.allButApprove") : t("offlineVoice.all")}
          </button>
        )}
        <button type="button" onClick={() => voice.dismiss()}>
          {t("offlineVoice.cancel")}
        </button>
      </div>
    </section>
  );
};

const EMPTY: Pick<Snapshot, "approvals" | "sessions"> = { approvals: [], sessions: [] };

/** The panel's own calls behind a card: Inbox's decide, the Sessions tab's start, the DND switch. */
export const panelVoiceActions = (p: {
  client: Pick<ChalitoClient, "live" | "actions"> | null;
  ipc: Pick<AgentIpc, "codeApps" | "codeStart">;
  canStepUp: boolean;
  openSession: (sid: string) => void;
  openNewSession: (prompt?: string) => void;
  pause: (minutes: number) => void;
  setDnd: (on: boolean) => void;
}): VoiceActions => {
  const place = async () => {
    const s = await p.ipc.codeApps();
    return s.apps[0] && s.workspaces[0] ? { app: s.apps[0], workspace: s.workspaces[0] } : null;
  };
  return {
    snapshot: () => p.client?.live.getSnapshot() ?? EMPTY,
    canStepUp: p.canStepUp,
    decide: (aid, allow) => (p.client ? p.client.actions.decide(aid, allow) : Promise.reject(new Error("offline"))),
    openSession: p.openSession,
    sessionPlace: place,
    startSession: async (prompt, where) => {
      const r = await p.ipc.codeStart({
        appId: where.app,
        workspaceLabel: where.workspace,
        prompt,
        permissionMode: "default",
      });
      p.openSession(r.sid);
    },
    openNewSession: p.openNewSession,
    pause: p.pause,
    setDnd: p.setDnd,
  };
};

/** What the panel needs for offline voice: the card, the Settings section and the Voice tab button. */
export interface OfflineVoiceWiring {
  /** null while the mode is off. */
  voice: OfflineVoice | null;
  settings: OfflineVoiceSettings;
  onSettings: (v: OfflineVoiceSettings) => void;
  askMic: () => Promise<void>;
  probe: (url: string) => Promise<boolean>;
  hotkeyError: string | null;
  pause: (minutes: number) => void;
}

/** The Voice tab's on-screen push-to-talk for commands, for when the hotkey isn't handy. */
export const OfflineVoiceButton = ({ voice }: { voice: OfflineVoice }) => {
  const t = useT();
  const state = useSyncExternalStore(voice.subscribe, () => voice.state);
  return (
    <button
      type="button"
      className={`ptt ptt-${state.phase}`}
      data-offline-voice-ptt
      aria-pressed={state.phase === "listening"}
      onPointerDown={(e) => {
        // Captured, so letting go off the button still ends the hold.
        e.currentTarget.setPointerCapture?.(e.pointerId);
        void voice.press();
      }}
      onPointerUp={() => void voice.release()}
      onPointerCancel={() => void voice.release()}
      onLostPointerCapture={() => void voice.release()}
      onBlur={() => void voice.release()}
      onKeyDown={(e) => e.key === " " && !e.repeat && void voice.press()}
      onKeyUp={(e) => e.key === " " && void voice.release()}
    >
      {state.phase === "listening" ? t("offlineVoice.listening") : t("offlineVoice.hold")}
    </button>
  );
};
