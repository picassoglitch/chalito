import { describe, expect, it } from "vitest";
import { MemoryNonceStore, TrustedClientList, fromB64url, openJson, sealJson } from "@chalito/crypto";
import { CommandBody, CommandPayload, type DecisionBody } from "@chalito/protocol";
import { ActionError, ClientActions } from "../src/actions.js";
import type { StepUpProvider } from "../src/keys.js";
import { LiveStore } from "../src/live.js";
import { FakeSupabase, newDevice, testKeys, tick, type Device } from "./helpers.js";

const OWNER = "hub-user-1";

const setup = async (opts: { stepUp?: StepUpProvider; trustAgent?: boolean } = {}) => {
  const me = await newDevice();
  const agent = await newDevice();
  const db = new FakeSupabase();
  const keys = testKeys(me, opts.trustAgent === false ? {} : { [agent.deviceId]: agent.pubBox });
  const live = new LiveStore(db, keys, OWNER);
  const stepUps: unknown[] = [];
  const actions = new ClientActions(db, keys, live, {
    stepUp: opts.stepUp ?? (async (a) => (stepUps.push(a), { method: "platform_biometric" as const, at: Date.now() })),
    retry: { baseMs: 1, attempts: 3, sleep: async () => undefined },
  });
  // The agent's own view: it trusts this client (it was paired and confirmed locally).
  const trust = new TrustedClientList(agent.deviceId);
  await trust.addConfirmed({ deviceId: me.deviceId, pubSign: me.pubSign, pubBox: me.pubBox }, Date.now());
  return { me, agent, db, live, actions, trust, stepUps };
};

const seedApproval = async (
  db: FakeSupabase,
  agent: Device,
  me: Device,
  aid: string,
  extra: Record<string, unknown> = {},
) => {
  db.seed("approvals", {
    owner: OWNER,
    aid,
    device_id: agent.deviceId,
    sid: "s1",
    request_id: `r-${aid}`,
    kind: "tool",
    risk: "MED",
    origin: "local",
    step_up_required: false,
    details_ct: await sealJson({ toolName: "Edit" }, { [me.deviceId]: await fromB64url(me.pubBox) }, `approval:${aid}`),
    status: "pending",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    ...extra,
  });
};

const seedSession = (db: FakeSupabase, agent: Device, sid = "s1") =>
  db.seed("sessions", { owner: OWNER, sid, device_id: agent.deviceId, doc: { state: "running" } });

describe("ClientActions.decide", () => {
  it("inserts a signed Decision that the agent's local trusted list verifies", async () => {
    const { me, agent, db, live, actions, trust } = await setup();
    await seedApproval(db, agent, me, "a1");
    await live.resync();
    await actions.decide("a1", true);
    const row = db.rows("approval_decisions")[0]!;
    expect(row).toMatchObject({ owner: OWNER, aid: "a1", signer_device_id: me.deviceId });
    const decision = row.decision as Parameters<TrustedClientList["verifyDecision"]>[0];
    const check = await trust.verifyDecision(
      decision,
      { aid: "a1", requestId: "r-a1" },
      Date.now(),
      new MemoryNonceStore(),
    );
    expect(check).toEqual({ ok: true, signerDeviceId: me.deviceId });
    expect((decision.body as DecisionBody).allow).toBe(true);
    expect((decision.body as DecisionBody).targetDeviceId).toBe(agent.deviceId);
  });

  it("HIGH/CRITICAL (or step_up_required) asks for step-up first; cancelling sends nothing", async () => {
    const cancel = await setup({ stepUp: async () => null });
    await seedApproval(cancel.db, cancel.agent, cancel.me, "h1", { risk: "HIGH", step_up_required: true });
    await cancel.live.resync();
    await expect(cancel.actions.decide("h1", true)).rejects.toMatchObject({ code: "step_up_cancelled" });
    expect(cancel.db.rows("approval_decisions")).toHaveLength(0);

    const ok = await setup();
    await seedApproval(ok.db, ok.agent, ok.me, "h2", { risk: "CRITICAL", step_up_required: true });
    await ok.live.resync();
    await ok.actions.decide("h2", true);
    expect(ok.stepUps).toEqual([{ aid: "h2", risk: "CRITICAL", agentDeviceId: ok.agent.deviceId }]);
    const body = (ok.db.rows("approval_decisions")[0]!.decision as { body: DecisionBody }).body;
    expect(body.stepUp).toMatchObject({ method: "platform_biometric" });
  });

  it("denying needs no step-up", async () => {
    const { me, agent, db, live, actions, stepUps } = await setup();
    await seedApproval(db, agent, me, "h3", { risk: "HIGH", step_up_required: true });
    await live.resync();
    await actions.decide("h3", false);
    expect(stepUps).toHaveLength(0);
    expect((db.rows("approval_decisions")[0]!.decision as { body: DecisionBody }).body.allow).toBe(false);
  });

  it("refuses unknown, resolved and expired approvals; a decision never outlives its approval", async () => {
    const { me, agent, db, live, actions } = await setup();
    await expect(actions.decide("nope", true)).rejects.toMatchObject({ code: "unknown_approval" });
    await seedApproval(db, agent, me, "done", { status: "approved" });
    await seedApproval(db, agent, me, "old", { expires_at: new Date(Date.now() - 1).toISOString() });
    await seedApproval(db, agent, me, "soon", { expires_at: new Date(Date.now() + 30_000).toISOString() });
    await live.resync();
    await expect(actions.decide("done", true)).rejects.toMatchObject({ code: "not_pending" });
    await expect(actions.decide("old", true)).rejects.toMatchObject({ code: "expired" });
    await actions.decide("soon", true);
    const body = (db.rows("approval_decisions")[0]!.decision as { body: DecisionBody }).body;
    expect(body.expiresAt).toBe(live.approval("soon")!.expiresAt);
  });
});

describe("ClientActions commands", () => {
  const commandOf = (db: FakeSupabase) => {
    const row = db.rows("commands").at(-1)!;
    return {
      row,
      env: row.env as { ctx: "chalito.command.v1"; body: CommandBody; signerDeviceId: string; sig: string },
    };
  };

  it("session.start: a signed command the agent verifies, prompt sealed to the agent (AAD command:<cid>)", async () => {
    const { me, agent, db, actions, trust } = await setup();
    const cid = await actions.startSession({
      agentDeviceId: agent.deviceId,
      adapter: "claude-code",
      workspaceLabel: "chalito",
      prompt: "arregla el login",
    });
    const { row, env } = commandOf(db);
    expect(row).toMatchObject({ owner: OWNER, target_device_id: agent.deviceId, id: cid, from_device_id: me.deviceId });
    expect(await trust.verifySigned(env, "chalito.command.v1")).toEqual({ ok: true, signerDeviceId: me.deviceId });
    expect(CommandBody.safeParse(env.body).success).toBe(true);
    expect(env.body).toMatchObject({
      cid,
      uid: OWNER,
      targetDeviceId: agent.deviceId,
      origin: `client:${me.deviceId}`,
    });
    expect(env.body.expiresAt - env.body.issuedAt).toBeLessThanOrEqual(10 * 60_000);
    const p = env.body.payload as Extract<CommandPayload, { type: "session.start" }>;
    expect(await openJson(p.promptCt, agent.deviceId, agent.box, `command:${cid}`)).toBe("arregla el login");
    await expect(openJson(p.promptCt, agent.deviceId, agent.box, "command:other")).rejects.toThrow();
    // This device can read its own prompt back too.
    expect(Object.keys(p.promptCt.keys).sort()).toEqual([agent.deviceId, me.deviceId].sort());
  });

  it("prompt/interrupt/resume/setPermissionMode/answer target the session's agent", async () => {
    const { agent, db, live, actions } = await setup();
    seedSession(db, agent);
    await live.resync();
    await actions.prompt("s1", "y ahora los tests");
    await actions.interrupt("s1");
    await actions.resume("s1");
    await actions.setPermissionMode("s1", "acceptEdits");
    const cid = await actions.answer("s1", "q1", { "¿Cuál?": "La segunda" });
    const types = db.rows("commands").map((r) => (r.env as { body: CommandBody }).body.payload.type);
    expect(types).toEqual([
      "session.prompt",
      "session.interrupt",
      "session.resume",
      "session.setPermissionMode",
      "session.answer",
    ]);
    for (const r of db.rows("commands")) expect(r.target_device_id).toBe(agent.deviceId);
    const answer = (commandOf(db).env.body.payload as Extract<CommandPayload, { type: "session.answer" }>).answerCt;
    expect(await openJson(answer, agent.deviceId, agent.box, `command:${cid}`)).toEqual({ "¿Cuál?": "La segunda" });
    await expect(actions.prompt("nope", "x")).rejects.toMatchObject({ code: "unknown_session" });
  });

  it("never seals to, or commands, an agent this device hasn't verified locally", async () => {
    const { agent, db, live, actions } = await setup({ trustAgent: false });
    seedSession(db, agent);
    await live.resync();
    await expect(
      actions.startSession({ agentDeviceId: agent.deviceId, adapter: "claude-code", workspaceLabel: "w", prompt: "x" }),
    ).rejects.toBeInstanceOf(ActionError);
    await expect(actions.interrupt("s1")).rejects.toMatchObject({ code: "untrusted_agent" });
    expect(db.rows("commands")).toHaveLength(0);
  });

  it("Developer mode: off and toggle-off only, plus revoking a client", async () => {
    const { agent, db, actions } = await setup();
    await actions.devmodeOff(agent.deviceId);
    await actions.devmodeToggleOff(agent.deviceId, "autoApproveHigh");
    await actions.revokeClient(agent.deviceId, "dev_lostphone");
    expect(db.rows("commands").map((r) => (r.env as { body: CommandBody }).body.payload)).toEqual([
      { type: "devmode.off" },
      { type: "devmode.toggleOff", toggle: "autoApproveHigh" },
      { type: "device.revokeClient", clientDeviceId: "dev_lostphone" },
    ]);
  });

  it("there is NO way to turn Developer mode (or a toggle) on, or to loosen policy, from a client", () => {
    const methods = Object.getOwnPropertyNames(ClientActions.prototype);
    expect(methods.filter((m) => /enable|turnon|devmodeon|toggleon|loosen|bypass/i.test(m))).toEqual([]);
    for (const t of ["devmode.on", "devmode.enable", "devmode.toggleOn", "policy.loosen", "policy.set"])
      expect(CommandPayload.safeParse({ type: t }).success).toBe(false);
  });

  it("rate-limited inserts (PT429) are retried, then surfaced", async () => {
    const { agent, db, actions } = await setup();
    db.failNext("chalito: rate limit", "PT429", 2);
    await actions.devmodeOff(agent.deviceId);
    expect(db.rows("commands")).toHaveLength(1);
    db.failNext("chalito: rate limit", "PT429", 10);
    await expect(actions.devmodeOff(agent.deviceId)).rejects.toMatchObject({ code: "PT429" });
  });
});

describe("ClientActions.ackNotification", () => {
  it("updates only state, acked_at and acked_via", async () => {
    const { db, actions } = await setup();
    db.seed("notifications", { owner: OWNER, nid: "n1", state: "pending" });
    await actions.ackNotification("n1");
    const op = db.ops.at(-1)!;
    expect(Object.keys(op.body as object).sort()).toEqual(["acked_at", "acked_via", "state"]);
    expect(db.rows("notifications")[0]).toMatchObject({ state: "acked", acked_via: "app" });
    await tick();
  });
});
