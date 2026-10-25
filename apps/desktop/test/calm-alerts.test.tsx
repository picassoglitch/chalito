import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityTracker, type Activity } from "@chalito/avatar";
import {
  AlertActionsUnavailable,
  type ChalitoClient,
  type EventView,
  type NotificationView,
  type SessionView,
  type Snapshot,
} from "@chalito/client";
import type { Locale } from "@chalito/protocol";
import { DEFAULT_SETTINGS } from "@chalito/ui";
import { TextProviders } from "../src/lib/i18n.js";
import { WaitingOn, alertReason, noticeSid } from "../src/lib/alert-notice.js";
import { unavailableIpc } from "../src/lib/ipc.js";
import { PushToTalk, unavailableVoice } from "../src/lib/voice.js";
import { CREDITS_URL } from "../src/panel/Credits.js";
import { Panel, type PanelProps } from "../src/panel/Panel.js";
import { petReaction } from "../src/pet/reactions.js";

// Stuck/stall alerts and calmer alerts in the panel and pet (from Alux, by Omar).
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const TURN = 1_761_400_000_000;
const notice = (over: Partial<NotificationView> = {}): NotificationView => ({
  nid: `al_s1_${TURN}`,
  level: "L2",
  source: "agent_alert",
  urgency: "normal",
  counts: {},
  deepLink: "/s/s1",
  state: "pending",
  createdAt: TURN + 1000,
  rev: 1,
  ...over,
});
const alertEvent = (meta: Record<string, unknown>, content: unknown = null, eid = "e1"): EventView => ({
  sid: "s1",
  eid,
  seq: 1,
  t: TURN + 1000,
  type: "agent.alert",
  urgency: "normal",
  meta: { turn: TURN, ...meta },
  content,
  rev: 1,
});
const session = (state = "running"): SessionView =>
  ({
    sid: "s1",
    agentDeviceId: "dev_a",
    label: "arregla el login",
    state,
    updatedAt: TURN,
    card: null,
    coord: null,
    rev: 1,
  }) as SessionView;

describe("why an alert fired", () => {
  it("reads the stuck command from that turn's sealed event; stuck beats stalled", () => {
    const events = {
      s1: [
        alertEvent({ kind: "stalled" }, null, "e0"),
        alertEvent({ kind: "stuck", count: 5 }, { cmd: "pnpm test" }),
        alertEvent({ kind: "stuck", count: 9, turn: 1 }, { cmd: "otra vuelta" }, "e2"),
      ],
    };
    expect(alertReason(notice(), events)).toEqual({ kind: "stuck", cmd: "pnpm test", count: 5 });
    expect(alertReason(notice(), { s1: [alertEvent({ kind: "stalled" })] })).toEqual({ kind: "stalled" });
    expect(alertReason(notice(), {})).toBeNull();
    expect(alertReason(notice({ source: "session_question" }), events)).toBeNull();
    expect(noticeSid({ deepLink: "/en/s/abc" })).toBe("abc");
    expect(noticeSid({ deepLink: "/a/x" })).toBeNull();
  });

  it("a waiting mark lasts until the session changes, and survives a reload", () => {
    const w = new WaitingOn(localStorage);
    w.mark("s1", "waiting_input");
    expect(new WaitingOn(localStorage).current([session("waiting_input")])).toEqual([
      { sid: "s1", state: "waiting_input" },
    ]);
    expect(w.current([])).toEqual([{ sid: "s1", state: "waiting_input" }]);
    expect(w.current([session("running")])).toEqual([]);
    expect(new WaitingOn(localStorage).current([session("waiting_input")])).toEqual([]);
    localStorage.setItem("chalito-waiting-on", "{not json");
    expect(new WaitingOn(localStorage).current([])).toEqual([]);
  });
});

const fakeClient = (snap: Partial<Snapshot>) => {
  const full: Snapshot = {
    status: "live",
    approvals: [],
    sessions: [],
    events: {},
    drafts: {},
    notifications: [],
    devices: [],
    devModeActive: false,
    ...snap,
  };
  const listeners = new Set<() => void>();
  const alerts = {
    seen: vi.fn(async () => undefined),
    waiting: vi.fn(async () => undefined),
    snooze: vi.fn(async () => undefined),
    available: true,
    subscribe: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
    emit: () => listeners.forEach((fn) => fn()),
  };
  const client = {
    live: { subscribe: () => () => undefined, getSnapshot: () => full },
    actions: { decide: vi.fn(), ackNotification: vi.fn(async () => undefined) },
    alerts,
  } as unknown as Pick<ChalitoClient, "live" | "actions" | "alerts">;
  return { client, alerts };
};

const renderPanel = (p: Partial<PanelProps>, locale: Locale = "es") =>
  render(
    <TextProviders locale={locale}>
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
        {...p}
      />
    </TextProviders>,
  );

describe("panel: calmer alerts", () => {
  const stuck = () =>
    fakeClient({
      notifications: [notice()],
      sessions: [session("running")],
      events: { s1: [alertEvent({ kind: "stuck", count: 5 }, { cmd: "pnpm test" })] },
    });

  it("says why: Parece atorado: `pnpm test` falló 5 veces", () => {
    const f = stuck();
    renderPanel({ client: f.client });
    expect(screen.getByText("Parece atorado: `pnpm test` falló 5 veces")).toBeTruthy();
  });

  it("in English too, and the stall line", () => {
    const f = fakeClient({ notifications: [notice()], events: { s1: [alertEvent({ kind: "stalled" })] } });
    renderPanel({ client: f.client }, "en");
    expect(screen.getByText("Looks stalled: nothing new for a while")).toBeTruthy();
  });

  it("Posponer 30 min snoozes that one alert", async () => {
    const f = stuck();
    renderPanel({ client: f.client });
    fireEvent.click(screen.getByText("Posponer 30 min"));
    await waitFor(() => expect(f.alerts.snooze).toHaveBeenCalledWith(`al_s1_${TURN}`));
  });

  it("Esperando a alguien parks the session, lists it, and Ya no undoes it", async () => {
    const f = stuck();
    const { container } = renderPanel({ client: f.client });
    fireEvent.click(screen.getByText("Esperando a alguien", { selector: "button" }));
    await waitFor(() => expect(f.alerts.waiting).toHaveBeenCalledWith("s1", true));
    expect(container.querySelector('[data-waiting-sid="s1"]')?.textContent).toContain("arregla el login");
    fireEvent.click(screen.getByText("Ya no"));
    await waitFor(() => expect(f.alerts.waiting).toHaveBeenCalledWith("s1", false));
    expect(container.querySelector('[data-waiting-sid="s1"]')).toBeNull();
  });

  it("a park the server refused is not listed, and the error shows", async () => {
    const f = stuck();
    f.alerts.waiting.mockRejectedValueOnce(new Error("chalito: not allowed"));
    const { container } = renderPanel({ client: f.client });
    fireEvent.click(screen.getByText("Esperando a alguien", { selector: "button" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("not allowed"));
    expect(container.querySelector('[data-waiting-sid="s1"]')).toBeNull();
    expect(new WaitingOn(localStorage).current([session("running")])).toEqual([]);
  });

  it("an undo the server refused keeps the session listed", async () => {
    const f = stuck();
    f.alerts.waiting.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("sin red"));
    const { container } = renderPanel({ client: f.client });
    fireEvent.click(screen.getByText("Esperando a alguien", { selector: "button" }));
    await waitFor(() => expect(container.querySelector('[data-waiting-sid="s1"]')).not.toBeNull());
    fireEvent.click(screen.getByText("Ya no"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("sin red"));
    expect(container.querySelector('[data-waiting-sid="s1"]')).not.toBeNull();
  });

  it("a database without the actions: a plain next step in Spanish, and Posponer / Esperando go away", async () => {
    const f = stuck();
    f.alerts.snooze.mockImplementationOnce(async () => {
      f.alerts.available = false;
      throw new AlertActionsUnavailable();
    });
    renderPanel({ client: f.client });
    fireEvent.click(screen.getByText("Posponer 30 min"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Esto necesita una versión más nueva. Actualiza o reinicia Chalito.",
      ),
    );
    expect(screen.queryByText("Posponer 30 min")).toBeNull();
    expect(screen.queryByText("Esperando a alguien", { selector: "button" })).toBeNull();
    expect(screen.getByText("Visto")).toBeTruthy();
    // A later retry goes through: the buttons come back without anything else redrawing the panel.
    act(() => {
      f.alerts.available = true;
      f.alerts.emit();
    });
    expect(await screen.findByText("Posponer 30 min")).toBeTruthy();
  });

  it("a stuck alert whose command this device can't open still says it's stuck", () => {
    const f = fakeClient({ notifications: [notice()], events: { s1: [alertEvent({ kind: "stuck" })] } });
    renderPanel({ client: f.client });
    expect(screen.getByText("Parece atorado: un comando sigue fallando")).toBeTruthy();
  });

  it("without the alert actions (older client) the rows keep only Visto", () => {
    const f = stuck();
    const { client } = f;
    const bare = { live: client.live, actions: client.actions } as Pick<ChalitoClient, "live" | "actions">;
    renderPanel({ client: bare });
    expect(screen.queryByText("Posponer 30 min")).toBeNull();
    expect(screen.getByText("Visto")).toBeTruthy();
  });
});

describe("panel: opening a session counts as seen", () => {
  it("Abrir sesión opens it in Sesiones and reports it seen, once", async () => {
    const f = fakeClient({ notifications: [notice()], sessions: [session("running")] });
    const { container } = renderPanel({ client: f.client });
    fireEvent.click(screen.getByText("Abrir sesión"));
    await waitFor(() => expect(f.alerts.seen).toHaveBeenCalledWith("s1"));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Sesiones");
    expect(f.alerts.seen).toHaveBeenCalledTimes(1);
  });

  it("an inbox without a session open reports nothing", () => {
    const f = fakeClient({ notifications: [notice()] });
    renderPanel({ client: f.client });
    expect(f.alerts.seen).not.toHaveBeenCalled();
  });
});

describe("panel: credits", () => {
  it("Ajustes shows Omar's credit and opens CREDITS.md in the browser", () => {
    const openUrl = vi.fn(async () => undefined);
    renderPanel({ initialTab: "settings", openUrl });
    expect(screen.getByText("Partes de Chalyb vienen de Alux, de Omar (homiomar). ¡Gracias, Omar!")).toBeTruthy();
    fireEvent.click(screen.getByText("Ver créditos"));
    expect(openUrl).toHaveBeenCalledWith(CREDITS_URL);
    expect(CREDITS_URL).toBe("https://github.com/picassoglitch/chalito/blob/main/CREDITS.md");
  });

  it("in English", () => {
    renderPanel({ initialTab: "settings" }, "en");
    expect(screen.getByText("Credits")).toBeTruthy();
    expect((screen.getByText("See credits") as HTMLAnchorElement).href).toBe(CREDITS_URL);
  });
});

describe("pet: an agent alert is a new pending notice, so the pet glances", () => {
  it("the tracker counts it and the reaction is the existing glance", () => {
    const tracker = new ActivityTracker();
    const sessions = [{ sid: "s1", state: "running", updatedAt: 1 }];
    const before: Activity = tracker.update(sessions, 0, { notifications: [], now: 1000 });
    const now = tracker.update(sessions, 0, {
      notifications: [{ nid: notice().nid, state: "pending", createdAt: 2000 }],
      now: 2000,
    });
    expect(now.alerts).toBe(before.alerts + 1);
    expect(petReaction({ before, now, behaviour: "idle", quiet: false, playing: null })?.action).toBe("glance");
    // Do Not Disturb / quiet hours mute it, like every attention move.
    expect(petReaction({ before, now, behaviour: "idle", quiet: true, playing: null })).toBeNull();
  });
});
