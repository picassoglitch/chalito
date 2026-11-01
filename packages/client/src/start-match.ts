import type { Snapshot } from "./live.js";

/**
 * The session a remote start opened. A new agent tags `session.started` with the start's command id;
 * released agents don't, so an untagged new session on that computer still counts (the old rule).
 */
export const startedSessionFor = (
  live: Pick<Snapshot, "sessions" | "events">,
  start: {
    cid: string;
    deviceId: string;
    before: ReadonlySet<string>;
    /** The computer reports `presence.tools`, so it is a new agent that tags its starts. */
    tagged?: boolean;
  },
): string | null => {
  const startedOf = (sid: string) => live.events[sid]?.find((e) => e.type === "session.started");
  // A row without its start event yet, or a native approvals session, is never a remote start.
  const fresh = live.sessions.filter(
    (s) =>
      s.agentDeviceId === start.deviceId &&
      !start.before.has(s.sid) &&
      s.control !== "approvals" &&
      startedOf(s.sid) !== undefined,
  );
  const tagOf = (sid: string): unknown => startedOf(sid)?.meta.commandId;
  const exact = fresh.find((s) => tagOf(s.sid) === start.cid);
  if (exact) return exact.sid;
  if (start.tagged) return null;
  // Another start's tagged session is never ours.
  return fresh.find((s) => tagOf(s.sid) === undefined)?.sid ?? null;
};
