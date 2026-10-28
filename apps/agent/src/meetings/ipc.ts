import { z } from "zod";
import { AppId } from "@chalito/protocol";
import { IpcError, type IpcHandlers } from "../ipc-server.js";
import type { SecretStore } from "../secrets.js";
import type { CodeService } from "../code/service.js";
import { CalendarService } from "./calendar.js";
import { FollowUpEngine, type FollowUpSource } from "./followups.js";
import { inCall, listProcesses, type ListProcesses } from "./in-call.js";

/** Opt-in flag for Granola follow-ups; in the keychain with its tokens so there's no new settings file. */
export const FOLLOWUPS_ON_SECRET = "granola-followups-on";

/** Only look for a live call when a warning is close; `ps` every poll would be waste. */
const CALL_CHECK_AHEAD_MS = 11 * 60_000;

export interface MeetingsFeature {
  calendar: CalendarService;
  followUps: FollowUpEngine;
  secrets: SecretStore;
  processes: ListProcesses;
  now: () => number;
  warn: (event: string, meta: Record<string, unknown>) => void;
}

export const meetingsFeature = (d: {
  secrets: SecretStore;
  code: Pick<CodeService, "start" | "apps">;
  locale: () => "es" | "en";
  /** Granola's connector, once it exists; null hides the follow-ups. */
  source?: FollowUpSource | null;
  fetch?: typeof fetch;
  processes?: ListProcesses;
  now?: () => number;
  tz?: () => string;
  warn?: (event: string, meta: Record<string, unknown>) => void;
}): MeetingsFeature => {
  const now = d.now ?? Date.now;
  const opt = { now, ...(d.tz ? { tz: d.tz } : {}) };
  return {
    calendar: new CalendarService({
      secrets: d.secrets,
      ...(d.fetch ? { fetch: d.fetch } : {}),
      ...(d.warn ? { warn: d.warn } : {}),
      ...opt,
    }),
    followUps: new FollowUpEngine({ source: d.source ?? null, code: d.code, locale: d.locale, ...opt }),
    secrets: d.secrets,
    processes: d.processes ?? listProcesses(),
    now,
    warn: d.warn ?? (() => undefined),
  };
};

const SetUrl = z.object({ url: z.string().min(1).max(4096) }).strict();
const Enable = z.object({ on: z.boolean() }).strict();
const Decide = z
  .object({
    ref: z.string().regex(/^[\w@.:-]{1,300}$/),
    choice: z.enum(["yes", "later", "no"]),
    appId: AppId.optional(),
    workspaceLabel: z.string().min(1).max(80).optional(),
  })
  .strict();

const parse = <T>(schema: z.ZodType<T>, params: unknown): T => {
  const r = schema.safeParse(params);
  if (!r.success) throw new IpcError("bad_params");
  return r.data;
};

/** The panel's meeting calls (apps/desktop/src/lib/ipc.ts). Read-only on the calendar; "Sí" only starts a session. */
export const meetingHandlers = (f: MeetingsFeature | undefined): IpcHandlers => {
  const of = (): MeetingsFeature => {
    if (!f) throw new IpcError("unavailable");
    return f;
  };
  const enabled = async (m: MeetingsFeature) => (await m.secrets.get(FOLLOWUPS_ON_SECRET)) === "1";
  return {
    meetingsUpcoming: async () => {
      const m = of();
      const up = await m.calendar.upcoming();
      const now = m.now();
      const soon = up.meetings.some((x) => x.startMs - now <= CALL_CHECK_AHEAD_MS && x.startMs >= now - 60_000);
      return { ...up, inCall: soon ? await inCall(m.processes) : false };
    },
    calendarSet: async (params) => of().calendar.setUrl(parse(SetUrl, params).url),
    calendarClear: async () => {
      await of().calendar.clear();
      return { ok: true };
    },
    followUpsList: async () => {
      const m = of();
      const on = await enabled(m);
      // A source outage keeps the cards already read and says so, instead of failing the whole list.
      const error =
        on && m.followUps.available
          ? await m.followUps.refresh().then(
              () => null,
              (err: unknown) => {
                m.warn("followups.source_failed", { error: err instanceof Error ? err.message : "error" });
                return "source_failed" as const;
              },
            )
          : null;
      return { available: m.followUps.available, enabled: on, cards: on ? m.followUps.cards() : [], error };
    },
    followUpsEnable: async (params) => {
      const m = of();
      const { on } = parse(Enable, params);
      if (on) await m.secrets.set(FOLLOWUPS_ON_SECRET, "1");
      else await m.secrets.delete(FOLLOWUPS_ON_SECRET);
      return { ok: true };
    },
    followUpsDecide: async (params) => {
      const m = of();
      if (!(await enabled(m))) throw new IpcError("followups_off");
      const { ref, choice, appId, workspaceLabel } = parse(Decide, params);
      const r = await m.followUps.decide(ref, choice, {
        ...(appId ? { appId } : {}),
        ...(workspaceLabel ? { workspaceLabel } : {}),
      });
      if (!r.ok) throw new IpcError(r.reason);
      return r;
    },
  };
};
