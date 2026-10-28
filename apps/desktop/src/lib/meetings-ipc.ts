import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import { IPC_UNAVAILABLE, IpcUnavailableError } from "./ipc.js";

/** One timed meeting from the person's calendar (apps/agent/src/meetings/ics.ts `Meeting`). */
export interface UpcomingMeeting {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  joinUrl: string | null;
}

export type CalendarError = "fetch_failed" | "link_rejected" | "not_calendar" | "too_large" | "local_address";

export interface MeetingsUpcoming {
  configured: boolean;
  meetings: UpcomingMeeting[];
  /** The last read failed; `meetings` are the last good copy. */
  error: CalendarError | null;
  /** Repeating meetings with a rule the agent can't expand (no warnings for them). */
  unsupported: number;
  /** A call app looks mid-call (only checked near a meeting; Zoom is the one app that tells). */
  inCall: boolean;
}

export type FollowUpType = "ticket" | "investigate" | "remind";
export interface FollowUpCard {
  ref: string;
  meeting: string;
  meetingStartMs: number;
  item: { id: string; type: FollowUpType; title: string; why: string; askedBy: string | null; owner: string | null };
  due: boolean;
}
export interface FollowUpsView {
  /** A follow-up source (Granola) is built into this agent. */
  available: boolean;
  enabled: boolean;
  cards: FollowUpCard[];
  /** The source failed this time; `cards` are what was read before. */
  error: "source_failed" | null;
}

export type CalendarSetResult = { ok: true } | { ok: false; reason: "bad_url" | "keychain" | CalendarError };

/** The agent's meeting calls (apps/agent/src/meetings/ipc.ts), kept apart from AgentIpc. */
export interface MeetingsIpc {
  upcoming(): Promise<MeetingsUpcoming>;
  setCalendar(url: string): Promise<CalendarSetResult>;
  clearCalendar(): Promise<void>;
  followUps(): Promise<FollowUpsView>;
  enableFollowUps(on: boolean): Promise<void>;
  decide(ref: string, choice: "yes" | "later" | "no"): Promise<{ ok: true; sid?: string; until?: number }>;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export const invokeMeetingsIpc = (invoke: Invoke = tauriInvoke): MeetingsIpc => {
  const call = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>("agent_ipc", { method, params: params ?? null });
    } catch (e) {
      const code = typeof e === "string" ? e : e instanceof Error ? e.message : "internal";
      throw code === IPC_UNAVAILABLE ? new IpcUnavailableError() : new Error(code);
    }
  };
  return {
    upcoming: () => call("meetingsUpcoming"),
    setCalendar: (url) => call("calendarSet", { url }),
    clearCalendar: async () => void (await call("calendarClear")),
    followUps: () => call("followUpsList"),
    enableFollowUps: async (on) => void (await call("followUpsEnable", { on })),
    decide: (ref, choice) => call("followUpsDecide", { ref, choice }),
  };
};

const unavailable = () => Promise.reject(new IpcUnavailableError());
export const unavailableMeetingsIpc: MeetingsIpc = {
  upcoming: unavailable,
  setCalendar: unavailable,
  clearCalendar: unavailable,
  followUps: unavailable,
  enableFollowUps: unavailable,
  decide: unavailable,
};

export const meetingsIpc = (): MeetingsIpc => (isTauri() ? invokeMeetingsIpc() : unavailableMeetingsIpc);
