import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { behaviourFor } from "@chalito/avatar";
import { DEFAULT_SETTINGS } from "@chalito/ui";
import { TextProviders } from "../src/lib/i18n.js";
import { IpcUnavailableError, unavailableIpc } from "../src/lib/ipc.js";
import { PushToTalk, unavailableVoice } from "../src/lib/voice.js";
import { MeetingWatch, formatStart, meetingWarnings, withMeetingLevel } from "../src/lib/meetings.js";
import {
  invokeMeetingsIpc,
  unavailableMeetingsIpc,
  type CalendarSetResult,
  type FollowUpsView,
  type MeetingsIpc,
  type MeetingsUpcoming,
  type UpcomingMeeting,
} from "../src/lib/meetings-ipc.js";
import { Meetings } from "../src/panel/Meetings.js";
import { CalendarSettings } from "../src/panel/CalendarSettings.js";
import { Panel } from "../src/panel/Panel.js";
import type { PetContext } from "../src/lib/pet-context.js";

afterEach(cleanup);

const ms = (iso: string) => Date.parse(iso);
const START = ms("2026-10-26T16:00:00Z");
const meeting = (o: Partial<UpcomingMeeting> = {}): UpcomingMeeting => ({
  id: "m1@1",
  title: "Revisión con cliente",
  startMs: START,
  endMs: START + 30 * 60_000,
  joinUrl: "https://zoom.us/j/1",
  ...o,
});
const none = { acked: new Set<string>(), inCall: false };
const at = (minBefore: number) => START - minBefore * 60_000;

describe("meeting warnings", () => {
  it("10 minutes before is a glance (L1), 2 minutes before a wave (L2)", () => {
    expect(meetingWarnings([meeting()], at(11), none)).toEqual([]);
    expect(meetingWarnings([meeting()], at(10), none).map((w) => [w.stage, w.level, w.minutes])).toEqual([
      ["ten", "L1", 10],
    ]);
    expect(meetingWarnings([meeting()], at(2.5), none)[0]?.level).toBe("L1");
    expect(meetingWarnings([meeting()], at(2), none).map((w) => [w.stage, w.level, w.minutes])).toEqual([
      ["two", "L2", 2],
    ]);
    expect(meetingWarnings([meeting()], at(0.2), none)[0]?.minutes).toBe(1);
  });

  it("at start time and after there's nothing: no takeover", () => {
    expect(meetingWarnings([meeting()], at(0), none)).toEqual([]);
    expect(meetingWarnings([meeting()], at(-3), none)).toEqual([]);
  });

  it("no moment before a meeting asks for more than L2, and the pet never takes focus for it", () => {
    for (let s = 15 * 60; s >= -60; s -= 7) {
      const ws = meetingWarnings([meeting()], START - s * 1000, none);
      for (const w of ws) {
        const out = behaviourFor({
          level: w.level,
          fullscreen: false,
          dnd: false,
          quietHours: false,
          lowEnergy: false,
        });
        expect(out.requestFocus).toBe(false);
        expect(["glance", "wave"]).toContain(out.state);
      }
    }
  });

  it("acking the 10-minute warning still lets the 2-minute one come", () => {
    const acked = new Set(["m1@1#ten"]);
    expect(meetingWarnings([meeting()], at(5), { acked, inCall: false })).toEqual([]);
    expect(meetingWarnings([meeting()], at(1), { acked, inCall: false })[0]?.stage).toBe("two");
  });

  it("skips every warning while a call app is in a call", () => {
    expect(meetingWarnings([meeting()], at(2), { acked: new Set(), inCall: true })).toEqual([]);
  });

  it("orders by start", () => {
    const later = meeting({ id: "m2@2", startMs: START + 60_000 });
    expect(meetingWarnings([later, meeting()], at(3), none).map((w) => w.meeting.id)).toEqual(["m1@1", "m2@2"]);
  });

  it("folds into the pet's level without lowering a higher one; DND still damps it", () => {
    const ctx: PetContext = { level: null, fullscreen: false, dnd: false, quietHours: false, lowEnergy: false };
    expect(withMeetingLevel(ctx, "L2").level).toBe("L2");
    expect(withMeetingLevel({ ...ctx, level: "L3" }, "L2").level).toBe("L3");
    expect(withMeetingLevel(ctx, null)).toBe(ctx);
    expect(behaviourFor({ ...withMeetingLevel(ctx, "L2"), dnd: true }).effectiveLevel).toBe("L0");
  });

  it("shows times in the person's zone, DST-safe", () => {
    expect(formatStart(ms("2026-10-30T13:00:00Z"), { tz: "America/New_York", locale: "en-US" })).toBe("9:00 AM");
    expect(formatStart(ms("2026-11-02T14:00:00Z"), { tz: "America/New_York", locale: "en-US" })).toBe("9:00 AM");
    expect(formatStart(ms("2026-10-26T16:00:00Z"), { tz: "America/Mexico_City", locale: "es-MX" })).toMatch(/^10:00/);
  });
});

const fakeIpc = (o: { up?: Partial<MeetingsUpcoming>; fu?: FollowUpsView } = {}) => {
  const ipc = {
    upcoming: vi.fn(async (): Promise<MeetingsUpcoming> => ({
      configured: true,
      meetings: [meeting()],
      error: null,
      unsupported: 0,
      inCall: false,
      ...o.up,
    })),
    setCalendar: vi.fn(async (url: string): Promise<CalendarSetResult> =>
      url.startsWith("https") ? { ok: true } : { ok: false, reason: "bad_url" },
    ),
    clearCalendar: vi.fn(async () => undefined),
    followUps: vi.fn(
      async (): Promise<FollowUpsView> => o.fu ?? { available: false, enabled: false, cards: [], error: null },
    ),
    enableFollowUps: vi.fn(async () => undefined),
    decide: vi.fn(async (_ref: string, choice: string) =>
      choice === "yes" ? { ok: true as const, sid: "s-7" } : { ok: true as const },
    ),
  } satisfies MeetingsIpc;
  return ipc;
};

describe("MeetingWatch", () => {
  it("polls the agent and exposes warnings and the level", async () => {
    let now = at(5);
    const w = new MeetingWatch(fakeIpc(), () => now);
    await w.poll();
    expect(w.getSnapshot().warnings.map((x) => x.stage)).toEqual(["ten"]);
    expect(w.level()).toBe("L1");
    now = at(1);
    w.recompute();
    expect(w.level()).toBe("L2");
    w.ack("m1@1#two");
    expect(w.level()).toBeNull();
  });

  it("in a call: no warnings at all", async () => {
    const w = new MeetingWatch(fakeIpc({ up: { inCall: true } }), () => at(1));
    await w.poll();
    expect(w.getSnapshot().warnings).toEqual([]);
    expect(w.level()).toBeNull();
  });

  it("without the agent it stays quiet and unknown", async () => {
    const w = new MeetingWatch(unavailableMeetingsIpc, () => at(1));
    await w.poll();
    expect(w.getSnapshot()).toMatchObject({
      configured: null,
      warnings: [],
      followUps: null,
      pollError: "unavailable",
    });
  });

  it("one failed poll keeps the live warning and the dismissals, and says the agent failed", async () => {
    const ipc = fakeIpc({ fu: CARDS });
    let now = at(5);
    const w = new MeetingWatch(ipc, () => now);
    await w.poll();
    w.ack("m1@1#ten");
    now = at(1.5);
    ipc.upcoming.mockRejectedValueOnce(new IpcUnavailableError());
    ipc.followUps.mockRejectedValueOnce(new Error("internal"));
    await w.poll();
    expect(w.getSnapshot().warnings.map((x) => x.stage)).toEqual(["two"]);
    expect(w.getSnapshot()).toMatchObject({ pollError: "unavailable", configured: true });
    expect(w.getSnapshot().followUps?.cards).toHaveLength(2);
    ipc.upcoming.mockRejectedValueOnce(new Error("internal"));
    await w.poll();
    expect(w.getSnapshot().pollError).toBe("internal");
    now = at(5);
    await w.poll();
    expect(w.getSnapshot().pollError).toBeNull();
    expect(w.getSnapshot().warnings).toEqual([]); // the 10-minute one stays dismissed
  });

  it("after a failed poll the old in-call reading no longer silences warnings", async () => {
    const ipc = fakeIpc({ up: { inCall: true } });
    const w = new MeetingWatch(ipc, () => at(1));
    await w.poll();
    expect(w.level()).toBeNull();
    ipc.upcoming.mockRejectedValueOnce(new Error("internal"));
    await w.poll();
    expect(w.level()).toBe("L2");
  });

  it("the IPC calls use the agent's method names and keep the error code", async () => {
    const invoke = vi.fn(async (_cmd: string, args?: Record<string, unknown>) => {
      if (args?.method === "followUpsDecide") throw "no_workspace";
      return { ok: true };
    });
    const ipc = invokeMeetingsIpc(invoke as never);
    await ipc.setCalendar("https://x/a.ics");
    expect(invoke).toHaveBeenLastCalledWith("agent_ipc", { method: "calendarSet", params: { url: "https://x/a.ics" } });
    await expect(ipc.decide("a:b", "yes")).rejects.toThrow("no_workspace");
    await ipc.upcoming();
    expect(invoke).toHaveBeenLastCalledWith("agent_ipc", { method: "meetingsUpcoming", params: null });
  });
});

const CARDS: FollowUpsView = {
  available: true,
  enabled: true,
  cards: [
    {
      ref: "m9:aa",
      meeting: "Planeación",
      meetingStartMs: START,
      item: {
        id: "aa",
        type: "ticket",
        title: "Arreglar el login",
        why: "falla con SSO",
        askedBy: "Ana",
        owner: "Beto",
      },
      due: false,
    },
    {
      ref: "m9:bb",
      meeting: "Planeación",
      meetingStartMs: START,
      item: { id: "bb", type: "remind", title: "Preguntarle a Sam", why: "", askedBy: null, owner: null },
      due: true,
    },
  ],
  error: null,
};

const wrap = (ui: React.ReactNode) => render(<TextProviders locale="es">{ui}</TextProviders>);

describe("meeting cards", () => {
  it("a warning card in Spanish: Unirme opens the link, Entendido dismisses", async () => {
    const w = new MeetingWatch(fakeIpc(), () => at(9));
    await w.poll();
    const openUrl = vi.fn(async () => undefined);
    wrap(<Meetings watch={w} openUrl={openUrl} />);
    expect(screen.getByText("Revisión con cliente")).toBeTruthy();
    expect(screen.getByText(/^Empieza en 9 min/)).toBeTruthy();
    fireEvent.click(screen.getByText("Unirme"));
    expect(openUrl).toHaveBeenCalledWith("https://zoom.us/j/1");
    await waitFor(() => expect(screen.queryByText("Revisión con cliente")).toBeNull());
  });

  it("the time follows the app's language, not the OS's", async () => {
    const w = new MeetingWatch(fakeIpc(), () => at(9));
    await w.poll();
    wrap(<Meetings watch={w} />);
    const time = formatStart(START, { locale: "es-MX" });
    expect(screen.getByText(`Empieza en 9 min (${time})`)).toBeTruthy();
  });

  it("a link that won't open keeps the warning and says so", async () => {
    const w = new MeetingWatch(fakeIpc(), () => at(9));
    await w.poll();
    wrap(<Meetings watch={w} openUrl={async () => Promise.reject(new Error("blocked"))} />);
    fireEvent.click(screen.getByText("Unirme"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/No pude abrir el enlace/);
    expect(screen.getByText("Revisión con cliente")).toBeTruthy();
  });

  it("a calendar that stopped reading shows a notice in the inbox even with no warning due", async () => {
    const w = new MeetingWatch(fakeIpc({ up: { meetings: [], error: "link_rejected" } }), () => at(60));
    await w.poll();
    wrap(<Meetings watch={w} />);
    expect(screen.getByRole("status").textContent).toMatch(/última copia/);
  });

  it("follow-up cards: Sí opens the drafting session, Luego and No only record the choice", async () => {
    const ipc = fakeIpc({ up: { meetings: [] }, fu: CARDS });
    const w = new MeetingWatch(ipc, () => at(60));
    await w.poll();
    const onSession = vi.fn();
    const { container } = wrap(<Meetings watch={w} onSession={onSession} />);
    expect(screen.getByText("Pendientes de tus reuniones")).toBeTruthy();
    expect(container.querySelector('[data-followup="ticket"]')?.textContent).toContain("Ticket");
    expect(screen.getByText(/lo dejaste para luego/)).toBeTruthy();
    fireEvent.click(screen.getAllByText("Sí")[0]!);
    await waitFor(() => expect(onSession).toHaveBeenCalledWith("s-7"));
    expect(ipc.decide).toHaveBeenCalledWith("m9:aa", "yes");
    fireEvent.click(screen.getAllByText("Luego")[1]!);
    await waitFor(() => expect(ipc.decide).toHaveBeenCalledWith("m9:bb", "later"));
    fireEvent.click(screen.getAllByText("No")[0]!);
    await waitFor(() => expect(ipc.decide).toHaveBeenCalledWith("m9:aa", "no"));
    expect(onSession).toHaveBeenCalledTimes(1);
  });

  it("a refused Sí says what to fix", async () => {
    const ipc = fakeIpc({ up: { meetings: [] }, fu: CARDS });
    ipc.decide.mockRejectedValueOnce(new Error("no_workspace"));
    const w = new MeetingWatch(ipc, () => at(60));
    await w.poll();
    wrap(<Meetings watch={w} />);
    fireEvent.click(screen.getAllByText("Sí")[0]!);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Agrega una carpeta/);
  });

  it("follow-ups stay hidden until the person opts in", async () => {
    const w = new MeetingWatch(fakeIpc({ up: { meetings: [] }, fu: { ...CARDS, enabled: false } }), () => at(60));
    await w.poll();
    const { container } = wrap(<Meetings watch={w} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("calendar settings", () => {
  it("pasting a link saves it through the agent; a bad one shows why", async () => {
    const ipc = fakeIpc({ up: { configured: false, meetings: [] } });
    const w = new MeetingWatch(ipc, () => at(60));
    await w.poll();
    const { container } = wrap(<CalendarSettings watch={w} />);
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "webcal-nope" } });
    fireEvent.click(screen.getByText("Guardar"));
    expect((await screen.findByRole("status")).textContent).toMatch(/Ese enlace no sirve/);
    fireEvent.change(input, { target: { value: "https://calendar.example.com/x.ics" } });
    fireEvent.click(screen.getByText("Guardar"));
    await waitFor(() => expect(ipc.setCalendar).toHaveBeenLastCalledWith("https://calendar.example.com/x.ics"));
    expect(screen.getByText(/Granola leerá|leerá tus notas de Granola/)).toBeTruthy();
  });

  it("connected: offers to remove it, and shows the Granola opt-in when a source exists", async () => {
    const ipc = fakeIpc({ fu: { available: true, enabled: false, cards: [], error: null } });
    const w = new MeetingWatch(ipc, () => at(60));
    await w.poll();
    wrap(<CalendarSettings watch={w} />);
    fireEvent.click(screen.getByText("Quitar calendario"));
    await waitFor(() => expect(ipc.clearCalendar).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(ipc.enableFollowUps).toHaveBeenCalledWith(true));
  });

  it("shows read errors, unreadable repeat rules, and a keychain refusal in Spanish", async () => {
    const ipc = fakeIpc({ up: { error: "fetch_failed", unsupported: 2 } });
    const w = new MeetingWatch(ipc, () => at(60));
    await w.poll();
    const { container, unmount } = wrap(<CalendarSettings watch={w} />);
    expect(container.textContent).toMatch(/No pude leer el calendario/);
    expect(container.textContent).toMatch(
      /Reuniones repetidas que no puedo leer todavía \(y no te avisaré de ellas\): 2\./,
    );
    unmount();
    const fresh = fakeIpc({ up: { configured: false, meetings: [] } });
    fresh.setCalendar.mockResolvedValueOnce({ ok: false, reason: "keychain" });
    const w2 = new MeetingWatch(fresh, () => at(60));
    await w2.poll();
    const s = wrap(<CalendarSettings watch={w2} />);
    fireEvent.change(s.container.querySelector('input[type="password"]')!, { target: { value: "https://x/a.ics" } });
    fireEvent.click(screen.getByText("Guardar"));
    expect((await screen.findByRole("status")).textContent).toMatch(/llavero/);
  });

  it("a link to the local network is refused with its own Spanish reason", async () => {
    const ipc = fakeIpc({ up: { configured: false, meetings: [] } });
    ipc.setCalendar.mockResolvedValueOnce({ ok: false, reason: "local_address" });
    const w = new MeetingWatch(ipc, () => at(60));
    await w.poll();
    const s = wrap(<CalendarSettings watch={w} />);
    fireEvent.change(s.container.querySelector('input[type="password"]')!, {
      target: { value: "https://192.168.1.20/cal.ics" },
    });
    fireEvent.click(screen.getByText("Guardar"));
    expect((await screen.findByRole("status")).textContent).toMatch(/No se permiten direcciones locales/);
  });

  it("an agent that errors reads differently from one that's gone", async () => {
    const ipc = fakeIpc();
    const w = new MeetingWatch(ipc, () => at(60));
    await w.poll();
    ipc.upcoming.mockRejectedValueOnce(new Error("internal"));
    await w.poll();
    const { container } = wrap(<CalendarSettings watch={w} />);
    expect(container.querySelector("[data-poll-error]")?.textContent).toMatch(/Algo falló en el agente/);
    expect(container.textContent).toMatch(/Calendario conectado/);
  });
});

describe("panel wiring", () => {
  it("the inbox shows warnings even signed out, and Sí moves to the session", async () => {
    const w = new MeetingWatch(fakeIpc({ fu: CARDS }), () => at(9));
    await w.poll();
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
          meetings={w}
        />
      </TextProviders>,
    );
    expect(screen.getByText("Revisión con cliente")).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getAllByText("Sí")[0]!));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Sesiones" }).getAttribute("aria-selected")).toBe("true"),
    );
  });
});
