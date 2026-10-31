import type { EventView, NotificationView, SessionView } from "@chalito/client";

/** Calmer alerts in the panel (from Alux, by Omar (homiomar)): why an alert fired, and "Esperando a alguien". */

/** The coding session a notice is about ("/s/<sid>" links), or null. */
export const noticeSid = (n: Pick<NotificationView, "deepLink">): string | null =>
  /^\/(?:en\/)?s\/([A-Za-z0-9_-]{1,128})$/.exec(n.deepLink)?.[1] ?? null;

export type AlertReason = { kind: "stuck"; cmd: string | null; count: number | null } | { kind: "stalled" };

/** Why an `agent_alert` fired, from that turn's `agent.alert` events (nid `al_<sid>_<turn>`); stuck beats stalled. */
export const alertReason = (
  n: Pick<NotificationView, "nid" | "source" | "deepLink">,
  events: Readonly<Record<string, readonly EventView[]>>,
): AlertReason | null => {
  const sid = noticeSid(n);
  if (n.source !== "agent_alert" || !sid) return null;
  const turn = Number(n.nid.slice(`al_${sid}_`.length));
  const mine = (events[sid] ?? []).filter((e) => e.type === "agent.alert" && e.meta.turn === turn);
  const stuck = mine.find((e) => e.meta.kind === "stuck");
  if (stuck) {
    const cmd = (stuck.content as { cmd?: unknown } | null)?.cmd;
    const count = typeof stuck.meta.count === "number" && stuck.meta.count > 0 ? stuck.meta.count : null;
    return { kind: "stuck", cmd: typeof cmd === "string" ? cmd : null, count };
  }
  return mine.length ? { kind: "stalled" } : null;
};

export interface WaitingMark {
  sid: string;
  /** The session's state when parked: any other state means it changed, and the mark goes. */
  state: string | undefined;
}

const KEY = "chalito-waiting-on";

/** Sessions parked with "Esperando a alguien" on this device (the engine holds the real state; this is the list). */
export class WaitingOn {
  #marks: WaitingMark[];

  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem"> | null) {
    this.#marks = this.#load();
  }

  mark(sid: string, state: string | undefined): void {
    this.#marks = [...this.#marks.filter((m) => m.sid !== sid), { sid, state }];
    this.#save();
  }

  unmark(sid: string): void {
    this.#marks = this.#marks.filter((m) => m.sid !== sid);
    this.#save();
  }

  /** The marks still standing: a session that moved on or is gone drops out (all kept while nothing has loaded). */
  current(sessions: readonly Pick<SessionView, "sid" | "state">[]): WaitingMark[] {
    if (!sessions.length) return this.#marks;
    const kept = this.#marks.filter((m) =>
      sessions.some((s) => s.sid === m.sid && (m.state === undefined || s.state === m.state)),
    );
    if (kept.length !== this.#marks.length) {
      this.#marks = kept;
      this.#save();
    }
    return kept;
  }

  #load(): WaitingMark[] {
    try {
      const v: unknown = JSON.parse(this.storage?.getItem(KEY) ?? "[]");
      return Array.isArray(v) ? v.filter((m): m is WaitingMark => typeof m?.sid === "string") : [];
    } catch {
      return [];
    }
  }

  #save(): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.#marks));
    } catch {
      // Not persisted; the list still works for this run.
    }
  }
}
