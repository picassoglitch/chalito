import type { Snapshot } from "./live.js";

/**
 * The session a remote start opened. A new agent tags `session.started` with the start's command id;
 * released agents don't, so an untagged new session on that computer still counts (the old rule).
 */
export const startedSessionFor = (
  live: Pick<Snapshot, "sessions" | "events">,
  start: { cid: string; deviceId: string; before: ReadonlySet<string> },
): string | null => {
  const fresh = live.sessions.filter((s) => s.agentDeviceId === start.deviceId && !start.before.has(s.sid));
  const tagOf = (sid: string): unknown =>
    live.events[sid]?.find((e) => e.type === "session.started" && e.meta.commandId !== undefined)?.meta.commandId;
  const exact = fresh.find((s) => tagOf(s.sid) === start.cid);
  if (exact) return exact.sid;
  // Another start's tagged session is never ours.
  return fresh.find((s) => tagOf(s.sid) === undefined)?.sid ?? null;
};
