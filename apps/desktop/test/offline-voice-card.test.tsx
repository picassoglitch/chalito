import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalView, ChalitoClient, SessionView, Snapshot } from "@chalito/client";
import { DEFAULT_SETTINGS } from "@chalito/ui";
import { TextProviders } from "../src/lib/i18n.js";
import { unavailableIpc, type AgentIpc } from "../src/lib/ipc.js";
import { PushToTalk, unavailableVoice } from "../src/lib/voice.js";
import { OfflineVoice, TAP_MS, type Recorder } from "../src/lib/offline-voice/controller.js";
import type { SpeechEngine } from "../src/lib/offline-voice/engine.js";
import {
  DEFAULT_OFFLINE_VOICE,
  loadOfflineVoice,
  saveOfflineVoice,
  validHotkey,
} from "../src/lib/offline-voice/settings.js";
import type { VoiceHotkey } from "../src/lib/offline-voice/native.js";
import { Panel } from "../src/panel/Panel.js";
import { OfflineVoiceButton, VoiceCard, panelVoiceActions, type OfflineVoiceWiring } from "../src/panel/VoiceCard.js";
import { useOfflineVoice } from "../src/panel/use-offline-voice.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => localStorage.clear());

/** A mic the test talks into: `say(level, ms)` hands over 16 kHz frames of that loudness. */
const fakeMic = (opts: { deny?: boolean } = {}) => {
  let onFrame: ((pcm: Float32Array, rate: number) => void) | null = null;
  const m = {
    stops: 0,
    starts: 0,
    recorder: {
      start: async (cb) => {
        m.starts++;
        if (opts.deny) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
        onFrame = cb;
        return () => {
          m.stops++;
          onFrame = null;
        };
      },
    } satisfies Recorder,
    say(level: number, ms: number) {
      for (let t = 0; t < ms; t += 20)
        onFrame?.(
          Float32Array.from({ length: 320 }, (_, i) => (i % 2 ? level : -level)),
          16_000,
        );
    },
    get open() {
      return onFrame !== null;
    },
  };
  return m;
};

const fakeEngine = (text: string) => {
  const transcribe = vi.fn<SpeechEngine["transcribe"]>(async () => ({ text, language: "es" }));
  return { transcribe, probe: async () => true } satisfies SpeechEngine;
};

/** Press, talk, let go after a real hold: the card for `text`. */
const heard = async (text: string) => {
  let now = 0;
  const mic = fakeMic();
  const engine = fakeEngine(text);
  const voice = new OfflineVoice({ recorder: mic.recorder, engine, now: () => now });
  await voice.press();
  mic.say(0.005, 300);
  mic.say(0.3, 800);
  now = 2000;
  await voice.release();
  await waitFor(() => expect(voice.state.phase).not.toBe("transcribing"));
  return { voice, mic, engine };
};

describe("offline voice controller", () => {
  it("hold: listens until release, then one decode and a card", async () => {
    const { voice, mic, engine } = await heard("Apruébalo");
    expect(voice.state).toEqual({ phase: "card", text: "Apruébalo", commands: [{ kind: "approve" }] });
    expect(engine.transcribe).toHaveBeenCalledTimes(1);
    expect(engine.transcribe.mock.calls[0]![0].length).toBe(16_000 * 1.1);
    expect(mic.stops).toBe(1);
    expect(mic.open).toBe(false);
  });

  it("while held, a pause mid-sentence doesn't end it", async () => {
    let now = 0;
    const mic = fakeMic();
    const voice = new OfflineVoice({ recorder: mic.recorder, engine: fakeEngine("pausa"), now: () => now });
    await voice.press();
    mic.say(0.005, 300);
    mic.say(0.3, 500);
    mic.say(0.005, 3000);
    expect(voice.state.phase).toBe("listening");
    now = 5000;
    await voice.release();
    await waitFor(() => expect(voice.state.phase).toBe("card"));
  });

  it("tap: keeps listening after a quick release and ends when the person stops talking", async () => {
    let now = 0;
    const mic = fakeMic();
    const engine = fakeEngine("Pon no molestar");
    const voice = new OfflineVoice({ recorder: mic.recorder, engine, now: () => now });
    await voice.press();
    now = TAP_MS - 1;
    await voice.release();
    expect(voice.state.phase).toBe("listening");
    mic.say(0.005, 300);
    mic.say(0.3, 600);
    expect(engine.transcribe).not.toHaveBeenCalled();
    mic.say(0.005, 1500);
    await waitFor(() => expect(voice.state.phase).toBe("card"));
    expect(mic.open).toBe(false);
  });

  it("a second tap ends it too", async () => {
    const now = 0;
    const mic = fakeMic();
    const voice = new OfflineVoice({ recorder: mic.recorder, engine: fakeEngine("siguiente"), now: () => now });
    await voice.press();
    await voice.release();
    mic.say(0.005, 300);
    mic.say(0.3, 600);
    await voice.press();
    await waitFor(() => expect(voice.state.phase).toBe("card"));
  });

  it("nobody spoke: 'nothing', and no decode", async () => {
    const mic = fakeMic();
    const engine = fakeEngine("x");
    const voice = new OfflineVoice({ recorder: mic.recorder, engine, now: () => 0 });
    await voice.press();
    await voice.release();
    mic.say(0.005, 7000);
    expect(voice.state.phase).toBe("nothing");
    expect(engine.transcribe).not.toHaveBeenCalled();
    expect(mic.open).toBe(false);
  });

  it("a mic refusal is an error, not a stuck listener", async () => {
    const voice = new OfflineVoice({ recorder: fakeMic({ deny: true }).recorder, engine: fakeEngine("x") });
    await voice.press();
    expect(voice.state.phase).toBe("error");
    await voice.release();
    expect(voice.state.phase).toBe("error");
  });

  it("a mic that opens but never sends audio ends in an error and closes, instead of listening forever", async () => {
    const mic = fakeMic();
    const voice = new OfflineVoice({ recorder: mic.recorder, engine: fakeEngine("x"), now: () => 0, noAudioMs: 30 });
    await voice.press();
    await voice.release();
    expect(voice.state.phase).toBe("listening");
    await waitFor(() => expect(voice.state.phase).toBe("error"));
    expect((voice.state as { error: Error }).error.name).toBe("MicSilentError");
    expect(mic.open).toBe(false);
  });

  it("a mic start that hangs still ends in an error, and the mic closes when it finally opens", async () => {
    let open: (stop: () => void) => void = () => undefined;
    const stop = vi.fn();
    const voice = new OfflineVoice({
      recorder: { start: () => new Promise((ok) => (open = ok)) },
      engine: fakeEngine("x"),
      now: () => 0,
      noAudioMs: 30,
    });
    void voice.press();
    void voice.release();
    await waitFor(() => expect(voice.state.phase).toBe("error"));
    open(stop);
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  it("while held, the audio cap still ends it, without a release", async () => {
    const mic = fakeMic();
    const voice = new OfflineVoice({
      recorder: mic.recorder,
      engine: fakeEngine("siguiente"),
      endpointer: { maxMs: 1000 },
    });
    await voice.press();
    mic.say(0.3, 1500);
    await waitFor(() => expect(voice.state.phase).toBe("card"));
    expect(mic.open).toBe(false);
  });

  it("a mic that stalls midway is ended by the clock cap", async () => {
    const mic = fakeMic();
    const engine = fakeEngine("siguiente");
    const voice = new OfflineVoice({ recorder: mic.recorder, engine, now: () => 0, endpointer: { maxMs: 50 } });
    await voice.press();
    await voice.release();
    mic.say(0.3, 20);
    await waitFor(() => expect(voice.state.phase).not.toBe("listening"), { timeout: 4000 });
    expect(mic.open).toBe(false);
  });

  it("less than 0.3 s of audio isn't decoded", async () => {
    let now = 0;
    const mic = fakeMic();
    const engine = fakeEngine("x");
    const voice = new OfflineVoice({ recorder: mic.recorder, engine, now: () => now });
    await voice.press();
    mic.say(0.3, 200);
    now = 1000;
    await voice.release();
    expect(voice.state.phase).toBe("nothing");
    expect(engine.transcribe).not.toHaveBeenCalled();
  });

  it("not a command: says what it heard", async () => {
    const { voice } = await heard("qué hora es");
    expect(voice.state).toEqual({ phase: "unknown", text: "qué hora es" });
  });

  it("cancel while decoding drops the late result", async () => {
    let now = 0;
    let finish: (v: { text: string; language: null }) => void = () => undefined;
    const mic = fakeMic();
    const voice = new OfflineVoice({
      recorder: mic.recorder,
      engine: { transcribe: () => new Promise((ok) => (finish = ok)), probe: async () => true },
      now: () => now,
    });
    await voice.press();
    mic.say(0.3, 800);
    now = 1000;
    void voice.release();
    expect(voice.state.phase).toBe("transcribing");
    voice.dismiss();
    finish({ text: "Apruébalo", language: null });
    await Promise.resolve();
    expect(voice.state.phase).toBe("idle");
  });
});

const approval = (o: Partial<ApprovalView> = {}): ApprovalView => ({
  aid: "a1",
  sid: "s1",
  agentDeviceId: "d1",
  requestId: "r1",
  kind: "tool",
  risk: "MED",
  origin: "claude-code",
  stepUpRequired: false,
  status: "pending",
  reason: null,
  createdAt: 0,
  expiresAt: Date.now() + 60_000,
  details: { summary: "Run npm test" },
  verified: true,
  detailsHash: "a".repeat(64),
  rev: 1,
  ...o,
});

const session = (sid: string, label: string, updatedAt: number): SessionView =>
  ({ sid, agentDeviceId: "d1", label, updatedAt, card: null, coord: null }) as SessionView;

/** A live store and actions the card's buttons go through; `snap` can change under an open card. */
const fakeClient = (snap: Pick<Snapshot, "approvals" | "sessions">) => {
  const decide = vi.fn(async (_aid: string, _allow: boolean) => undefined);
  const box = { snap };
  const client = {
    live: { getSnapshot: () => box.snap, subscribe: () => () => undefined },
    actions: { decide },
  } as unknown as Pick<ChalitoClient, "live" | "actions">;
  return { client, decide, box };
};

const renderCard = async (
  text: string,
  snap: Pick<Snapshot, "approvals" | "sessions">,
  over: { canStepUp?: boolean; ipc?: Pick<AgentIpc, "codeApps" | "codeStart"> } = {},
) => {
  const { voice } = await heard(text);
  const { client, decide, box } = fakeClient(snap);
  const spies = { openSession: vi.fn(), openNewSession: vi.fn(), pause: vi.fn(), setDnd: vi.fn() };
  const actions = panelVoiceActions({
    client,
    ipc: over.ipc ?? unavailableIpc,
    canStepUp: over.canStepUp ?? false,
    ...spies,
  });
  render(
    <TextProviders locale="es">
      <VoiceCard voice={voice} actions={actions} />
    </TextProviders>,
  );
  return { voice, decide, box, ...spies };
};

const button = (name: RegExp | string) => screen.getByRole("button", { name });

describe("the choice card: nothing runs from voice alone", () => {
  it("shows what was heard and the item, and approves only on the click", async () => {
    const { decide, voice } = await renderCard("Apruébalo", { approvals: [approval()], sessions: [] });
    expect(screen.getByText(/Oí: «Apruébalo»/)).toBeTruthy();
    expect(screen.getByText(/«Run npm test»/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(decide).not.toHaveBeenCalled();
    fireEvent.click(button("Aprobar"));
    await waitFor(() => expect(decide).toHaveBeenCalledWith("a1", true));
    await waitFor(() => expect(voice.state.phase).toBe("idle"));
  });

  it("cancel runs nothing", async () => {
    const { decide, setDnd, voice } = await renderCard("Recházalo y pon no molestar", {
      approvals: [approval()],
      sessions: [],
    });
    fireEvent.click(button("Cancelar"));
    expect(voice.state.phase).toBe("idle");
    expect(decide).not.toHaveBeenCalled();
    expect(setDnd).not.toHaveBeenCalled();
  });

  it("acts on the item the person read: if it's gone by the click, nothing is approved", async () => {
    const { decide, box } = await renderCard("approve", { approvals: [approval()], sessions: [] });
    box.snap = { approvals: [approval({ aid: "a2", details: { summary: "rm -rf build" } })], sessions: [] };
    fireEvent.click(button("Aprobar"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Eso ya no está pendiente.");
    expect(decide).not.toHaveBeenCalled();
  });

  it.each([
    [{ verified: false }, "Sin verificar: solo se puede rechazar."],
    [{ risk: "HIGH" as const }, "Apruébalo desde tu teléfono."],
    [{ details: { summary: "x", summaryTruncated: true } }, "Ábrelo completo en la bandeja antes de aprobar."],
  ])("keeps the Inbox's rules: %j can't be approved from the card", async (o, note) => {
    await renderCard("Apruébalo", { approvals: [approval(o)], sessions: [] });
    expect((button("Aprobar") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(note)).toBeTruthy();
  });

  it("with a passkey on this device, a HIGH-risk approval can be approved from the card (decide does the step-up)", async () => {
    const { decide } = await renderCard(
      "Apruébalo",
      { approvals: [approval({ risk: "HIGH" })], sessions: [] },
      { canStepUp: true },
    );
    fireEvent.click(button("Aprobar"));
    await waitFor(() => expect(decide).toHaveBeenCalledWith("a1", true));
  });

  it("'all' with a gone approval still does the rest, and says what didn't happen", async () => {
    const { decide, setDnd, box } = await renderCard("Rechaza y pon no molestar", {
      approvals: [approval()],
      sessions: [],
    });
    box.snap = { approvals: [], sessions: [] };
    fireEvent.click(button("Todo"));
    expect((await screen.findByRole("alert")).textContent).toBe("Eso ya no está pendiente.");
    expect(setDnd).toHaveBeenCalledWith(true);
    expect(decide).not.toHaveBeenCalled();
  });

  it("with nothing pending, approve and deny can't be clicked", async () => {
    await renderCard("Rechaza", { approvals: [], sessions: [] });
    expect(screen.getByText(/no hay nada pendiente/)).toBeTruthy();
    expect((button("Rechazar") as HTMLButtonElement).disabled).toBe(true);
  });

  it("'this, this or all': all runs both, one click", async () => {
    const { decide, setDnd, voice } = await renderCard("Rechaza y pon no molestar", {
      approvals: [approval()],
      sessions: [],
    });
    expect(screen.getByRole("heading").textContent).toBe("¿Esto, esto o todo?");
    fireEvent.click(button("Todo"));
    await waitFor(() => expect(voice.state.phase).toBe("idle"));
    expect(decide).toHaveBeenCalledWith("a1", false);
    expect(setDnd).toHaveBeenCalledWith(true);
  });

  it("'all' never includes an approval: it needs its own click", async () => {
    const { decide, pause, voice } = await renderCard(
      "Approve and then pause for 10 minutes and turn on do not disturb",
      {
        approvals: [approval()],
        sessions: [],
      },
    );
    fireEvent.click(button("Todo menos aprobar"));
    await waitFor(() => expect(pause).toHaveBeenCalledWith(10));
    expect(decide).not.toHaveBeenCalled();
    expect(voice.state.phase).toBe("card");
    fireEvent.click(button("Aprobar"));
    await waitFor(() => expect(decide).toHaveBeenCalledWith("a1", true));
  });

  it("opens the session named, matched without accents", async () => {
    const { openSession } = await renderCard("Abre la sesión de facturación", {
      approvals: [],
      sessions: [session("s1", "Facturación API", 1), session("s2", "Landing", 2)],
    });
    expect(screen.getByText(/Abrir la sesión «Facturación API»/)).toBeTruthy();
    fireEvent.click(button("Abrir"));
    expect(openSession).toHaveBeenCalledWith("s1");
  });

  it("'next session' is the one waiting on the person", async () => {
    const { openSession } = await renderCard("siguiente", {
      approvals: [approval({ sid: "s1" })],
      sessions: [session("s1", "Pagos", 1), session("s2", "Landing", 2)],
    });
    fireEvent.click(button("Abrir"));
    expect(openSession).toHaveBeenCalledWith("s1");
  });

  it("starts a new session with the prompt, where the Sessions tab would", async () => {
    const codeStart = vi.fn(async () => ({ sid: "new1" }));
    const ipc = { codeApps: async () => ({ apps: ["claude-code"], workspaces: ["chalito"] }), codeStart };
    const { openSession } = await renderCard(
      "Nueva sesión para revisar el CI",
      { approvals: [], sessions: [] },
      { ipc },
    );
    expect(await screen.findByText(/en claude-code · chalito: «revisar el CI»/)).toBeTruthy();
    expect(codeStart).not.toHaveBeenCalled();
    fireEvent.click(button("Empezar"));
    await waitFor(() =>
      expect(codeStart).toHaveBeenCalledWith({
        appId: "claude-code",
        workspaceLabel: "chalito",
        prompt: "revisar el CI",
        permissionMode: "default",
      }),
    );
    expect(openSession).toHaveBeenCalledWith("new1");
  });

  it("starts where the card said, even if the first app changed since", async () => {
    const codeStart = vi.fn(async () => ({ sid: "new1" }));
    let apps = ["claude-code"];
    const ipc = { codeApps: async () => ({ apps, workspaces: ["chalito"] }), codeStart };
    await renderCard("Nueva sesión para revisar el CI", { approvals: [], sessions: [] }, { ipc });
    await screen.findByText(/en claude-code · chalito/);
    apps = ["codex"];
    fireEvent.click(button("Empezar"));
    await waitFor(() => expect(codeStart).toHaveBeenCalledWith(expect.objectContaining({ appId: "claude-code" })));
  });

  it("nowhere to start it: the form opens with the dictated prompt in it", async () => {
    const ipc = { codeApps: async () => ({ apps: [], workspaces: [] }), codeStart: vi.fn() };
    const { openNewSession } = await renderCard(
      "New session to tidy the logs",
      { approvals: [], sessions: [] },
      { ipc },
    );
    await waitFor(() => expect((button("Empezar") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button("Empezar"));
    expect(openNewSession).toHaveBeenCalledWith("tidy the logs");
    expect(ipc.codeStart).not.toHaveBeenCalled();
  });

  it("a slow 'where to start' on one card doesn't lock 'all' on the next", async () => {
    let now = 0;
    let said = "Nueva sesión para revisar el CI";
    const mic = fakeMic();
    const engine = { transcribe: async () => ({ text: said, language: null }), probe: async () => true };
    const voice = new OfflineVoice({ recorder: mic.recorder, engine, now: () => now });
    const talk = async () => {
      await voice.press();
      mic.say(0.3, 800);
      now += 2000;
      await voice.release();
      await waitFor(() => expect(voice.state.phase).toBe("card"));
    };
    const { client } = fakeClient({ approvals: [approval()], sessions: [] });
    const actions = panelVoiceActions({
      client,
      ipc: { codeApps: () => new Promise(() => undefined), codeStart: vi.fn() },
      canStepUp: false,
      openSession: vi.fn(),
      openNewSession: vi.fn(),
      pause: vi.fn(),
      setDnd: vi.fn(),
    });
    render(
      <TextProviders locale="es">
        <VoiceCard voice={voice} actions={actions} />
      </TextProviders>,
    );
    await act(talk);
    act(() => voice.dismiss());
    said = "Rechaza y pon no molestar";
    await act(talk);
    expect((button("Todo") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a double click decides once", async () => {
    const { decide } = await renderCard("Recházalo", { approvals: [approval()], sessions: [] });
    decide.mockImplementation(() => new Promise(() => undefined));
    fireEvent.click(button("Rechazar"));
    await waitFor(() => expect((button("Rechazar") as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(button("Rechazar"));
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the card, and the keyboard lands on it", async () => {
    const { voice } = await renderCard("Pon no molestar", { approvals: [], sessions: [] });
    expect(document.activeElement).toBe(screen.getByRole("heading"));
    fireEvent.keyDown(screen.getByRole("heading"), { key: "Escape" });
    expect(voice.state.phase).toBe("idle");
  });

  it("an action that fails says so in words, not a raw code", async () => {
    const { decide } = await renderCard("Recházalo", { approvals: [approval()], sessions: [] });
    decide.mockRejectedValueOnce(new Error("network down"));
    fireEvent.click(button("Rechazar"));
    expect((await screen.findByRole("alert")).textContent).toBe("No se pudo hacer: network down");
  });

  it("pause and DND off go through the panel's own switches", async () => {
    const a = await renderCard("Pausa 20 minutos", { approvals: [], sessions: [] });
    fireEvent.click(button("Pausar"));
    expect(a.pause).toHaveBeenCalledWith(20);
    cleanup();
    const b = await renderCard("Quita no molestar", { approvals: [], sessions: [] });
    fireEvent.click(button("Hacerlo"));
    expect(b.setDnd).toHaveBeenCalledWith(false);
  });

  it("the on-screen button lets go even when the pointer is cancelled or released elsewhere", () => {
    const voice = new OfflineVoice({ recorder: fakeMic().recorder, engine: fakeEngine("x") });
    const press = vi.spyOn(voice, "press").mockResolvedValue();
    const release = vi.spyOn(voice, "release").mockResolvedValue();
    render(
      <TextProviders locale="es">
        <OfflineVoiceButton voice={voice} />
      </TextProviders>,
    );
    const b = button(/comando/);
    fireEvent.pointerDown(b, { pointerId: 1 });
    expect(press).toHaveBeenCalledTimes(1);
    fireEvent.pointerCancel(b, { pointerId: 1 });
    expect(release).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(b, { pointerId: 2 });
    fireEvent.lostPointerCapture(b, { pointerId: 2 });
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("a mic refusal says how to fix it", async () => {
    const voice = new OfflineVoice({ recorder: fakeMic({ deny: true }).recorder, engine: fakeEngine("x") });
    await voice.press();
    const { client } = fakeClient({ approvals: [], sessions: [] });
    const actions = panelVoiceActions({
      client,
      ipc: unavailableIpc,
      canStepUp: false,
      openSession: vi.fn(),
      openNewSession: vi.fn(),
      pause: vi.fn(),
      setDnd: vi.fn(),
    });
    render(
      <TextProviders locale="es">
        <VoiceCard voice={voice} actions={actions} />
      </TextProviders>,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/permiso para usar el micrófono/);
  });
});

describe("settings: off by default, per device", () => {
  it("defaults, and rejects what isn't local or isn't a hotkey", () => {
    expect(loadOfflineVoice()).toEqual(DEFAULT_OFFLINE_VOICE);
    expect(DEFAULT_OFFLINE_VOICE.enabled).toBe(false);
    saveOfflineVoice({ enabled: true, serverUrl: "https://cloud.example", languages: ["fr"], hotkey: "Space" });
    expect(loadOfflineVoice()).toEqual({ ...DEFAULT_OFFLINE_VOICE, enabled: true });
    localStorage.setItem("chalito-desktop-offline-voice", "{not json");
    expect(loadOfflineVoice()).toEqual(DEFAULT_OFFLINE_VOICE);
    expect(validHotkey("CommandOrControl+Shift+Space")).toBe(true);
    expect(validHotkey("Alt+F9")).toBe(true);
    expect(validHotkey("Space")).toBe(false);
    expect(validHotkey("Shift+Banana")).toBe(false);
    for (const sys of ["CommandOrControl+Space", "Alt+Tab", "Cmd+Q", "Control+C", "Super+L", "Alt+F4"])
      expect(validHotkey(sys), sys).toBe(false);
  });
});

const wiring = (o: Partial<OfflineVoiceWiring> = {}): OfflineVoiceWiring => ({
  voice: null,
  settings: DEFAULT_OFFLINE_VOICE,
  onSettings: vi.fn(),
  askMic: vi.fn(async () => undefined),
  probe: vi.fn(async () => true),
  hotkeyError: null,
  pause: vi.fn(),
  ...o,
});

const renderSettings = (ov: OfflineVoiceWiring) =>
  render(
    <TextProviders locale="es">
      <Panel
        client={null}
        ipc={unavailableIpc}
        ptt={new PushToTalk(unavailableVoice)}
        settings={DEFAULT_SETTINGS}
        onSetting={() => undefined}
        dnd={false}
        onDnd={() => undefined}
        hubPlansUrl="https://hub.example/planes"
        phoneVerifier={{ start: async () => ({ ok: true }), check: async () => ({ ok: true }) }}
        offlineVoice={ov}
        initialTab="settings"
      />
    </TextProviders>,
  );

describe("settings: 'Comandos de voz sin internet'", () => {
  it("is off, and the mic is asked for only when the person turns it on", async () => {
    const ov = wiring();
    renderSettings(ov);
    const toggle = screen.getByRole("checkbox", { name: "Comandos de voz sin internet" }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(ov.askMic).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await waitFor(() => expect(ov.onSettings).toHaveBeenCalledWith({ ...DEFAULT_OFFLINE_VOICE, enabled: true }));
    expect(ov.askMic).toHaveBeenCalledTimes(1);
  });

  it("a refused mic leaves it off and says why", async () => {
    const refused = new DOMException("denied", "NotAllowedError");
    const ov = wiring({ askMic: vi.fn(async () => Promise.reject(refused)) });
    renderSettings(ov);
    fireEvent.click(screen.getByRole("checkbox", { name: "Comandos de voz sin internet" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/permiso para usar el micrófono/);
    expect(ov.onSettings).not.toHaveBeenCalled();
  });

  it("no mic at all isn't reported as a permission problem", async () => {
    const ov = wiring({ askMic: vi.fn(async () => Promise.reject(new DOMException("none", "NotFoundError"))) });
    renderSettings(ov);
    fireEvent.click(screen.getByRole("checkbox", { name: "Comandos de voz sin internet" }));
    expect((await screen.findByRole("alert")).textContent).toBe("No encuentro un micrófono en esta computadora.");
  });

  it("only takes an address on this computer, and tests it", async () => {
    const ov = wiring({ settings: { ...DEFAULT_OFFLINE_VOICE, enabled: true } });
    renderSettings(ov);
    const url = screen.getByRole("textbox", { name: "Dirección del motor de voz local" });
    fireEvent.change(url, { target: { value: "https://whisper.example.com" } });
    fireEvent.blur(url);
    expect(screen.getByRole("alert").textContent).toMatch(/esta computadora/);
    expect(ov.onSettings).not.toHaveBeenCalled();
    fireEvent.change(url, { target: { value: "http://localhost:9000" } });
    fireEvent.blur(url);
    expect(ov.onSettings).toHaveBeenCalledWith({ ...ov.settings, serverUrl: "http://localhost:9000" });
    fireEvent.click(button("Probar"));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "El motor de voz responde.");
    expect(ov.probe).toHaveBeenCalledWith("http://localhost:9000");
  });

  it("a bad hotkey isn't saved, and the last language can't be unticked", () => {
    const ov = wiring({ settings: { ...DEFAULT_OFFLINE_VOICE, enabled: true, languages: ["es"] } });
    renderSettings(ov);
    const hotkey = screen.getByRole("textbox", { name: "Atajo para hablar" });
    fireEvent.change(hotkey, { target: { value: "Space" } });
    fireEvent.blur(hotkey);
    expect(screen.getByRole("alert").textContent).toMatch(/teclas modificadoras/);
    expect(ov.onSettings).not.toHaveBeenCalled();
    expect((screen.getByRole("checkbox", { name: "Español" }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Inglés" }) as HTMLInputElement).disabled).toBe(false);
  });

  it("in the real panel: a session that couldn't start from the card lands in the Sessions form with its prompt", async () => {
    let now = 0;
    const mic = fakeMic();
    const voice = new OfflineVoice({
      recorder: mic.recorder,
      engine: fakeEngine("New session to tidy the logs"),
      now: () => now,
    });
    const codeStart = vi.fn();
    // The agent wasn't ready when the card asked; it is by the time the Sessions tab opens.
    let calls = 0;
    const codeApps = async () =>
      calls++ ? { apps: ["claude-code"], workspaces: ["chalito"] } : { apps: [], workspaces: [] };
    const ipc = { ...unavailableIpc, codeApps, codeStart };
    render(
      <TextProviders locale="es">
        <Panel
          client={null}
          ipc={ipc}
          ptt={new PushToTalk(unavailableVoice)}
          settings={DEFAULT_SETTINGS}
          onSetting={() => undefined}
          dnd={false}
          onDnd={() => undefined}
          hubPlansUrl="https://hub.example/planes"
          phoneVerifier={{ start: async () => ({ ok: true }), check: async () => ({ ok: true }) }}
          offlineVoice={wiring({ voice, settings: { ...DEFAULT_OFFLINE_VOICE, enabled: true } })}
        />
      </TextProviders>,
    );
    await act(async () => {
      await voice.press();
      mic.say(0.3, 800);
      now = 2000;
      await voice.release();
    });
    const start = await screen.findByRole("button", { name: "Empezar" });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Sesiones");
    expect(codeStart).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByDisplayValue("tidy the logs")).toBeTruthy());
  });

  it("without the wiring (other shells) there's no section", () => {
    render(
      <TextProviders locale="es">
        <Panel
          client={null}
          ipc={unavailableIpc}
          ptt={new PushToTalk(unavailableVoice)}
          settings={DEFAULT_SETTINGS}
          onSetting={() => undefined}
          dnd={false}
          onDnd={() => undefined}
          hubPlansUrl="https://hub.example/planes"
          phoneVerifier={{ start: async () => ({ ok: true }), check: async () => ({ ok: true }) }}
          initialTab="settings"
        />
      </TextProviders>,
    );
    expect(document.querySelector("[data-offline-voice-settings]")).toBeNull();
  });
});

const fakeHotkey = () => {
  let cb: ((down: boolean) => void) | null = null;
  const set = vi.fn<VoiceHotkey["set"]>(async () => undefined);
  const hotkey: VoiceHotkey = {
    set,
    onPtt: async (f) => {
      cb = f;
      return () => (cb = null);
    },
  };
  return { hotkey, set, fire: (down: boolean) => cb?.(down) };
};

describe("panel hook: the hotkey is held only while the mode is on", () => {
  it("off: releases the hotkey; on: takes it, and its press/release drive the mic", async () => {
    const hk = fakeHotkey();
    const voice = new OfflineVoice({ recorder: fakeMic().recorder, engine: fakeEngine("x") });
    const press = vi.spyOn(voice, "press").mockResolvedValue();
    const release = vi.spyOn(voice, "release").mockResolvedValue();
    const make = () => voice;
    const { result } = renderHook(() => useOfflineVoice(vi.fn(), vi.fn(), { hotkey: hk.hotkey, voice: make }));
    expect(result.current.voice).toBeNull();
    expect(hk.set).toHaveBeenCalledWith(null);
    expect(hk.set).not.toHaveBeenCalledWith(DEFAULT_OFFLINE_VOICE.hotkey);
    act(() => result.current.onSettings({ ...DEFAULT_OFFLINE_VOICE, enabled: true }));
    expect(result.current.voice).toBe(voice);
    await waitFor(() => expect(hk.set).toHaveBeenCalledWith(DEFAULT_OFFLINE_VOICE.hotkey));
    await waitFor(() => {
      hk.fire(true);
      expect(press).toHaveBeenCalled();
    });
    hk.fire(false);
    expect(release).toHaveBeenCalled();
    expect(loadOfflineVoice().enabled).toBe(true);
  });

  it("turning it off releases the hotkey and closes a live mic; changing the hotkey swaps without a release", async () => {
    const hk = fakeHotkey();
    saveOfflineVoice({ ...DEFAULT_OFFLINE_VOICE, enabled: true });
    const mic = fakeMic();
    const voice = new OfflineVoice({ recorder: mic.recorder, engine: fakeEngine("x") });
    const { result } = renderHook(() => useOfflineVoice(vi.fn(), vi.fn(), { hotkey: hk.hotkey, voice: () => voice }));
    await waitFor(() => expect(hk.set).toHaveBeenCalledWith(DEFAULT_OFFLINE_VOICE.hotkey));
    hk.set.mockClear();
    act(() => result.current.onSettings({ ...result.current.settings, hotkey: "Alt+Shift+V" }));
    await waitFor(() => expect(hk.set).toHaveBeenCalledWith("Alt+Shift+V"));
    expect(hk.set).not.toHaveBeenCalledWith(null);
    await act(async () => {
      await voice.press();
      mic.say(0.3, 300);
    });
    expect(mic.open).toBe(true);
    act(() => result.current.onSettings({ ...result.current.settings, enabled: false }));
    expect(result.current.voice).toBeNull();
    await waitFor(() => expect(hk.set).toHaveBeenLastCalledWith(null));
    expect(mic.open).toBe(false);
    expect(voice.state.phase).toBe("idle");
    const press = vi.spyOn(voice, "press");
    hk.fire(true);
    expect(press).not.toHaveBeenCalled();
  });

  it("a hotkey the OS won't give shows up for Settings", async () => {
    const hk = fakeHotkey();
    hk.set.mockImplementation(async (a) => (a ? Promise.reject("HotKey already registered") : undefined));
    saveOfflineVoice({ ...DEFAULT_OFFLINE_VOICE, enabled: true });
    const voice = new OfflineVoice({ recorder: fakeMic().recorder, engine: fakeEngine("x") });
    const { result } = renderHook(() => useOfflineVoice(vi.fn(), vi.fn(), { hotkey: hk.hotkey, voice: () => voice }));
    await waitFor(() => expect(result.current.hotkeyError).toBe("HotKey already registered"));
  });

  it("shows the panel when there's a card to confirm", async () => {
    const hk = fakeHotkey();
    saveOfflineVoice({ ...DEFAULT_OFFLINE_VOICE, enabled: true });
    let now = 0;
    const mic = fakeMic();
    const voice = new OfflineVoice({ recorder: mic.recorder, engine: fakeEngine("siguiente"), now: () => now });
    const showPanel = vi.fn();
    renderHook(() => useOfflineVoice(vi.fn(), showPanel, { hotkey: hk.hotkey, voice: () => voice }));
    await act(async () => {
      await voice.press();
      mic.say(0.3, 600);
      now = 1000;
      await voice.release();
    });
    await waitFor(() => expect(showPanel).toHaveBeenCalled());
  });

  it("'pausa 20 minutos' is Do Not Disturb that turns itself off; touching DND cancels that", () => {
    vi.useFakeTimers();
    const setDnd = vi.fn();
    const { result } = renderHook(() => useOfflineVoice(setDnd, vi.fn(), { hotkey: fakeHotkey().hotkey }));
    act(() => result.current.pause(20));
    expect(setDnd).toHaveBeenLastCalledWith(true);
    act(() => vi.advanceTimersByTime(20 * 60_000 - 1));
    expect(setDnd).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(setDnd).toHaveBeenLastCalledWith(false);
    act(() => result.current.pause(5));
    act(() => result.current.cancelPause());
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(setDnd).toHaveBeenLastCalledWith(true);
  });

  it("a restart mid-pause still turns DND off on time; a pause that ended while closed clears at once", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const a = renderHook(() => useOfflineVoice(first, vi.fn(), { hotkey: fakeHotkey().hotkey }));
    act(() => a.result.current.pause(20));
    a.unmount();
    act(() => vi.advanceTimersByTime(5 * 60_000));
    const second = vi.fn();
    renderHook(() => useOfflineVoice(second, vi.fn(), { hotkey: fakeHotkey().hotkey }));
    act(() => vi.advanceTimersByTime(15 * 60_000 - 1));
    expect(second).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(second).toHaveBeenCalledWith(false);
    cleanup();
    localStorage.setItem("chalito-desktop-dnd-until", String(Date.now() - 1000));
    const third = vi.fn();
    renderHook(() => useOfflineVoice(third, vi.fn(), { hotkey: fakeHotkey().hotkey }));
    act(() => vi.advanceTimersByTime(0));
    expect(third).toHaveBeenCalledWith(false);
  });

  it("a hotkey listener that fails to attach is reported, not swallowed", async () => {
    const hk = fakeHotkey();
    hk.hotkey.onPtt = () => Promise.reject(new Error("no event bridge"));
    saveOfflineVoice({ ...DEFAULT_OFFLINE_VOICE, enabled: true });
    const voice = new OfflineVoice({ recorder: fakeMic().recorder, engine: fakeEngine("x") });
    const { result } = renderHook(() => useOfflineVoice(vi.fn(), vi.fn(), { hotkey: hk.hotkey, voice: () => voice }));
    await waitFor(() => expect(result.current.hotkeyError).toMatch(/no event bridge/));
  });
});
