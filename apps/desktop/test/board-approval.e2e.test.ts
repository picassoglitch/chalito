// @vitest-environment node
import { expect, it } from "vitest";
import { ClientActions, LiveStore } from "@chalito/client";
import type { Decision } from "@chalito/protocol";
import { FakeSupabase, testKeys } from "../../../packages/client/test/helpers.js";
import { OWNER, agentFor, waitFor } from "../../agent/test/rc-harness.js";
import { BoardLink } from "../src/lib/board/link.js";
import { attachBoardApprovals } from "../src/lib/board/approvals.js";
import { FakeBoard } from "./fake-board.js";
import { memoryPairStore } from "../src/lib/board/pairing.js";

it("a paired LCD board approves with a hold: pairing, frame out, mac-signed decide back, signed decision reaches the agent", async () => {
  const first = await agentFor();
  const second = await agentFor({ phone: first.phone });
  const started = await second.core.localCommand("local", {
    type: "session.start",
    appId: "claude-code",
    workspaceLabel: "chalito",
    prompt: "install dependencies",
    permissionMode: "default",
  });
  expect(started.ok).toBe(true);
  const sid = started.sid!;
  const tool = second.adapter.tool(sid, "Bash", { command: "npm install left-pad" });
  await waitFor(() => second.store.pendingApprovals().length === 1);
  const pending = second.store.pendingApprovals()[0]!;
  const db = new FakeSupabase();
  db.seed("devices", {
    owner: OWNER,
    device_id: second.self.id,
    role: "agent",
    kind: "desktop",
    name: "Work PC B",
    last_seen_at: new Date().toISOString(),
    revoked: false,
  });
  db.seed("sessions", {
    owner: OWNER,
    sid,
    device_id: second.self.id,
    doc: { adapter: "claude-code", appId: "claude-code" },
  });
  db.seed("approvals", {
    owner: OWNER,
    aid: pending.aid,
    sid,
    device_id: second.self.id,
    request_id: pending.requestId,
    kind: pending.kind,
    risk: pending.risk,
    origin: pending.origin,
    step_up_required: pending.stepUpRequired,
    details_ct: pending.detailsCt,
    status: "pending",
    created_at: pending.createdAt,
    expires_at: pending.expiresAt,
  });
  const keys = testKeys(
    { ...first.phone, deviceId: first.phone.id },
    { [second.self.id]: second.self.pubBox },
    { [second.self.id]: second.self.pubSign },
  );
  const live = new LiveStore(db, keys, OWNER);
  const actions = new ClientActions(db, keys, live, { stepUp: async () => null });
  live.start();
  await waitFor(() => live.getSnapshot().status === "live" && live.getSnapshot().approvals[0]?.verified === true);
  const board = new FakeBoard();
  const store = memoryPairStore();
  const link = new BoardLink(board, store, { minPairMs: 0 });
  link.start();
  const detach = attachBoardApprovals(link, { live, actions });
  try {
    board.plug();
    await waitFor(() => link.found);
    // Unpaired, it sees no approvals at all.
    expect(board.sent("approval-console")).toHaveLength(0);
    board.autoConfirm = true;
    expect(await link.pair()).toBe("paired");
    await waitFor(() => board.sent("approval-console").some((f) => f.state === "pending"));
    const frame = board.sent("approval-console").findLast((f) => f.state === "pending") as {
      approval: { aid: string; ticket: string; computer: string; canApprove: boolean };
    };
    expect(frame.approval).toMatchObject({ aid: pending.aid, computer: "Work PC B", canApprove: true });
    // A wrong mac and a stale ticket are refused; the hold with the shown ticket and our mac approves.
    board.decide(pending.aid, frame.approval.ticket, true, "0".repeat(64));
    board.decide(pending.aid, "x".repeat(16), true);
    board.decide(pending.aid, frame.approval.ticket, true);
    await waitFor(() => db.rows("approval_decisions").length === 1);
    const row = db.rows("approval_decisions")[0]!;
    expect(row.aid).toBe(pending.aid);
    const decision = row.decision as Decision;
    expect(decision.body.targetDeviceId).toBe(second.self.id);
    expect(decision.body.requestId).toBe(pending.requestId);
    second.store.attachDecision(pending.aid, decision);
    expect(await tool).toMatchObject({ allow: true });
    expect(first.store.pendingApprovals()).toHaveLength(0);
    expect(link.getSnapshot().rejected).toBe(1);
    // A replay of the valid decide: the one-use ticket refuses it.
    board.decide(pending.aid, frame.approval.ticket, true);
    await new Promise((r) => setTimeout(r, 200));
    expect(db.rows("approval_decisions")).toHaveLength(1);
  } finally {
    detach();
    link.stop();
    live.stop();
  }
});
