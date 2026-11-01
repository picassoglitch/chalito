import { expect, it } from "vitest";
import type { EventView, SessionView } from "../src/live.js";
import { startedSessionFor } from "../src/start-match.js";

const session = (sid: string, agentDeviceId = "pc-a") =>
  ({ sid, agentDeviceId, updatedAt: 1, card: null, coord: null, rev: 1 }) as SessionView;
const started = (sid: string, commandId?: string) =>
  ({
    sid,
    eid: `${sid}-1`,
    seq: 1,
    t: 1,
    type: "session.started",
    urgency: "low",
    meta: commandId ? { commandId } : {},
    content: null,
    rev: 1,
  }) as EventView;

it("opens the session tagged with this start's command, even when another start finished first", () => {
  const live = {
    sessions: [session("other"), session("mine")],
    events: { other: [started("other", "cmd-2")], mine: [started("mine", "cmd-1")] },
  };
  expect(startedSessionFor(live, { cid: "cmd-1", deviceId: "pc-a", before: new Set() })).toBe("mine");
});

it("never takes another start's tagged session, an old session, or another computer's", () => {
  const live = {
    sessions: [session("old"), session("theirs"), session("elsewhere", "pc-b")],
    events: { theirs: [started("theirs", "cmd-2")], elsewhere: [started("elsewhere")] },
  };
  expect(startedSessionFor(live, { cid: "cmd-1", deviceId: "pc-a", before: new Set(["old"]) })).toBeNull();
});

it("a released agent doesn't tag its start: a new untagged session on that computer counts", () => {
  const live = { sessions: [session("old"), session("new")], events: { new: [started("new")] } };
  expect(startedSessionFor(live, { cid: "cmd-1", deviceId: "pc-a", before: new Set(["old"]) })).toBe("new");
});
