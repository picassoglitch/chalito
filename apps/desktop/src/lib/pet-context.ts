import type { Activity, BehaviourContext } from "@chalito/avatar";
import type { NotificationView, Snapshot } from "@chalito/client";
import type { Level } from "@chalito/protocol";
import type { SettingsValues } from "@chalito/ui";

/** What the panel (which holds the live connection) tells the pet window: the escalation context and
 * what the person's AI sessions are doing (busy, waiting, started, finished, failed, replies, alerts). */
export type PetContext = Omit<BehaviourContext, "acked"> & { activity?: Activity; panelFocused?: boolean };

const RANK: Record<Level, number> = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };
const isLevel = (l: string): l is Level => l in RANK;

/** The highest level among pending notifications, or null when nothing waits. */
export const pendingLevel = (notifications: readonly NotificationView[]): Level | null => {
  let best: Level | null = null;
  for (const n of notifications)
    if (n.state === "pending" && isLevel(n.level) && (best === null || RANK[n.level] > RANK[best])) best = n.level;
  return best;
};

const minutes = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h < 24 && mm < 60 ? h * 60 + mm : null;
};

/** Local-time quiet hours (the notifier's tri-state): `off` never, `default` and `custom` use start–end
 * (default 22:00–08:00). A window that crosses midnight wraps. */
export const inQuietHours = (q: SettingsValues["quietHours"], at: Date): boolean => {
  if (q.mode === "off") return false;
  const from = minutes(q.start);
  const to = minutes(q.end);
  if (from === null || to === null || from === to) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
};

export const petContext = (
  snap: Pick<Snapshot, "notifications">,
  settings: Pick<SettingsValues, "quietHours">,
  local: { dnd: boolean; fullscreen: boolean; lowEnergy: boolean; panelFocused?: boolean },
  at: Date,
  activity?: Activity,
): PetContext => ({
  level: pendingLevel(snap.notifications),
  quietHours: inQuietHours(settings.quietHours, at),
  ...local,
  ...(activity ? { activity } : {}),
});

/** Answers the person still owes (approvals waiting on them). */
export const pendingAnswers = (snap: Pick<Snapshot, "approvals">): number =>
  snap.approvals.filter((a) => a.status === "pending").length;

/** How long after the store goes live its first pull counts as still loading. */
export const LOAD_GRACE_MS = 5000;

/** Whether the live store is still loading: not live, or live for under LOAD_GRACE_MS. "live" comes before
 * the first pull lands, and every session's updated_at is recent, so loaded rows would look like news. */
export class LoadWatch {
  #liveSince: number | null = null;

  loading(status: Snapshot["status"] | undefined, now: number): boolean {
    if (status !== "live") {
      this.#liveSince = null;
      return true;
    }
    this.#liveSince ??= now;
    return now - this.#liveSince < LOAD_GRACE_MS;
  }
}
