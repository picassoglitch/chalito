import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ChalitoClient, Snapshot } from "@chalito/client";
import type { Translate } from "@chalito/ui";
import { useT } from "../lib/i18n.js";
import type { AgentIpc } from "../lib/ipc.js";
import { cardOptions, inAll, runnable, type CardOption } from "../lib/offline-voice/card.js";
import type { OfflineVoice } from "../lib/offline-voice/controller.js";
import { EngineFailedError, EngineNotLocalError, EngineUnreachableError } from "../lib/offline-voice/engine.js";
import type { OfflineVoiceSettings } from "../lib/offline-voice/settings.js";

/** What a confirmed card can do: the same calls the panel's own buttons make. */
export interface VoiceActions {
  snapshot(): Pick<Snapshot, "approvals" | "sessions">;
  canStepUp: boolean;
  decide(aid: string, allow: boolean): Promise<void>;
  openSession(sid: string): void;
  /** Where a new session would start (the Sessions tab's first app and folder), or null if nowhere. */
  sessionPlace(): Promise<{ app: string; workspace: string } | null>;
  startSession(prompt: string): Promise<void>;
  openNewSession(): void;
  pause(minutes: number): void;
  setDnd(on: boolean): void;
}

const errorText = (t: Translate, e: unknown): string => {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return t("offlineVoice.micDenied");
  if (e instanceof EngineUnreachableError || e instanceof EngineNotLocalError) return t("offlineVoice.engineDown");
  if (e instanceof EngineFailedError) return t("offlineVoice.engineFailed", { status: e.status });
  return t("offlineVoice.failed");
};

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
  useEffect(() => {
    setDone(new Set());
    setError(null);
    setPlace(null);
    if (!options.some((o) => o.kind === "newSession" && o.prompt)) return;
    let live = true;
    actions.sessionPlace().then(
      (p) => live && setPlace(p),
      () => undefined,
    );
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
      <section className="card voice-card row" data-offline-voice={state.phase} aria-live="polite">
        <span role={state.phase === "error" ? "alert" : undefined}>{line}</span>
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
        if (!still) throw new Error(t("offlineVoice.gone"));
        await actions.decide(aid, o.kind === "approve");
        break;
      }
      case "open":
        if (o.session) actions.openSession(o.session.sid);
        break;
      case "newSession":
        if (o.prompt && place) await actions.startSession(o.prompt);
        else actions.openNewSession();
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
    try {
      for (const i of picks) {
        await run(i);
        setDone((d) => new Set(d).add(i));
      }
      const left = options.filter((o, i) => runnable(o) && !done.has(i) && !picks.includes(i));
      if (!left.length) voice.dismiss();
      else setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const all = options.map((o, i) => (inAll(o) && !done.has(i) ? i : -1)).filter((i) => i >= 0);
  const blockNote = (o: CardOption) =>
    o.kind === "approve" && o.block && o.block !== "nothing" ? t(`offlineVoice.block.${o.block}`) : null;

  return (
    <section className="card voice-card stack" data-offline-voice="card" aria-labelledby="voice-card-title">
      <h2 id="voice-card-title">{options.length > 1 ? t("offlineVoice.which") : t("offlineVoice.confirm")}</h2>
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
              <button type="button" disabled={!runnable(o)} onClick={() => void click([i])}>
                {t(`offlineVoice.button.${o.kind}`)}
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="row">
        {all.length > 1 && (
          <button type="button" onClick={() => void click(all)}>
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
  openNewSession: () => void;
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
    startSession: async (prompt) => {
      const where = await place();
      if (!where) return p.openNewSession();
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
      onPointerDown={() => void voice.press()}
      onPointerUp={() => void voice.release()}
      onKeyDown={(e) => e.key === " " && !e.repeat && void voice.press()}
      onKeyUp={(e) => e.key === " " && void voice.release()}
    >
      {state.phase === "listening" ? t("offlineVoice.listening") : t("offlineVoice.hold")}
    </button>
  );
};
