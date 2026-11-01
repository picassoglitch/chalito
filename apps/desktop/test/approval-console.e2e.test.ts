// @vitest-environment node
import { expect, it } from "vitest";
import { ApprovalConsole, ClientActions, LiveStore } from "@chalito/client";
import type { Decision } from "@chalito/protocol";
import { FakeSupabase, testKeys } from "../../../packages/client/test/helpers.js";
import { OWNER, agentFor, waitFor } from "../../agent/test/rc-harness.js";

it("an LCD button becomes the same signed, request-bound decision as a phone approval on the selected PC", async () => {
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
  const console = new ApprovalConsole(live, actions);
  try {
    const frame = console.getSnapshot();
    expect(frame).toMatchObject({
      state: "pending",
      approval: { aid: pending.aid, computer: "Work PC B", canApprove: true },
    });
    expect(
      await console.handle({ v: 1, type: "decide", aid: pending.aid, ticket: frame.approval!.ticket, allow: true }),
    ).toEqual({ ok: true });
    const row = db.rows("approval_decisions")[0]!;
    expect(row.aid).toBe(pending.aid);
    const decision = row.decision as Decision;
    expect(decision.body.targetDeviceId).toBe(second.self.id);
    expect(decision.body.requestId).toBe(pending.requestId);
    expect(decision.body.detailsHash).toHaveLength(64);
    second.store.attachDecision(pending.aid, decision);
    expect(await tool).toMatchObject({ allow: true });
    expect(first.store.pendingApprovals()).toHaveLength(0);
  } finally {
    console.close();
    live.stop();
  }
});
