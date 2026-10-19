import { TrustedClientList, fromB64url, openJson, sealJson } from "@chalito/crypto";
import { CommandBody, SignedCommand, type CoordPlanState } from "@chalito/protocol";
import { describe, expect, it } from "vitest";
import { ActionError, ClientActions } from "../src/actions.js";
import type { StepUpProvider } from "../src/keys.js";
import { LiveStore } from "../src/live.js";
import { FakeSupabase, newDevice, testKeys, tick } from "./helpers.js";

const OWNER = "hub-user-1";

const setup = async (stepUp?: StepUpProvider) => {
  const me = await newDevice();
  const agent = await newDevice();
  const db = new FakeSupabase();
  const keys = testKeys(me, { [agent.deviceId]: agent.pubBox }, { [agent.deviceId]: agent.pubSign });
  const live = new LiveStore(db, keys, OWNER);
  const asked: unknown[] = [];
  const actions = new ClientActions(db, keys, live, {
    stepUp: stepUp ?? (async (a) => (asked.push(a), { method: "platform_biometric" as const, at: Date.now() })),
    retry: { baseMs: 1, attempts: 3, sleep: async () => undefined },
  });
  const trust = new TrustedClientList(agent.deviceId);
  await trust.addConfirmed({ deviceId: me.deviceId, pubSign: me.pubSign, pubBox: me.pubBox }, Date.now());
  /** The command row as the agent reads it: signed by this device, parsed like the agent parses it. */
  const sent = async () => {
    const row = db.rows("commands").at(-1)!;
    const env = SignedCommand.parse(row.env);
    expect((await trust.verifySigned(env, "chalito.command.v1")).ok).toBe(true);
    return env.body;
  };
  return { me, agent, db, live, actions, asked, sent };
};

describe("coordinator commands from the phone (ADR 0025 §6)", () => {
  it("start: the goal is sealed to the agent and no limit is filled in that the owner didn't set", async () => {
    const h = await setup();
    await h.actions.coordStart({ agentDeviceId: h.agent.deviceId, workspaceLabel: "taquito", goal: "add billing" });
    const body = await h.sent();
    expect(body.payload).toMatchObject({ type: "coord.start", workspaceLabel: "taquito" });
    expect(body.payload).not.toHaveProperty("maxAgents");
    expect(body.payload).not.toHaveProperty("maxMinutes");
    // Parsing again (as the agent does) changes nothing the signature covers.
    expect(CommandBody.parse(body)).toEqual(body);
    const goal = await openJson<string>(
      (body.payload as unknown as { goalCt: never }).goalCt,
      h.agent.deviceId,
      h.agent.box,
      `command:${body.cid}`,
    );
    expect(goal).toBe("add billing");
    await h.actions.coordStart({
      agentDeviceId: h.agent.deviceId,
      workspaceLabel: "taquito",
      goal: "x",
      maxAgents: 2,
      maxMinutes: 30,
      base: "develop",
    });
    expect((await h.sent()).payload).toMatchObject({ maxAgents: 2, maxMinutes: 30, base: "develop" });
    expect(h.asked).toHaveLength(0);
  });

  it("approve and merge carry this device's passkey over the command; stop doesn't ask", async () => {
    const h = await setup();
    await h.actions.coordApprove(h.agent.deviceId, "pabcdefgh");
    expect((await h.sent()).stepUp).toMatchObject({ method: "platform_biometric" });
    await h.actions.coordMerge(h.agent.deviceId, "pabcdefgh");
    expect((await h.sent()).stepUp).toMatchObject({ method: "platform_biometric" });
    expect(h.asked).toEqual([
      { aid: "coord-approve:pabcdefgh", risk: "HIGH", agentDeviceId: h.agent.deviceId },
      { aid: "coord-merge:pabcdefgh", risk: "HIGH", agentDeviceId: h.agent.deviceId },
    ]);
    await h.actions.coordStop(h.agent.deviceId, "pabcdefgh");
    expect((await h.sent()).stepUp).toBeUndefined();
    expect(h.asked).toHaveLength(2);
  });

  it("without the passkey, approve and merge send nothing", async () => {
    const h = await setup(async () => null);
    await expect(h.actions.coordApprove(h.agent.deviceId, "pabcdefgh")).rejects.toEqual(
      new ActionError("passkey_required"),
    );
    await expect(h.actions.coordMerge(h.agent.deviceId, "pabcdefgh")).rejects.toBeInstanceOf(ActionError);
    expect(h.db.rows("commands")).toHaveLength(0);
  });
});

describe("the plan on the session (sealed by the agent)", () => {
  const plan = (planId: string): CoordPlanState => ({
    v: 1,
    planId,
    goal: "add billing",
    workspaceLabel: "taquito",
    base: "main",
    status: "awaiting_approval",
    maxAgents: 3,
    maxMinutes: 120,
    startedAt: null,
    tasks: [
      {
        id: "api",
        title: "API",
        acceptance: ["works"],
        dependsOn: [],
        status: "pending",
        branch: `coord/${planId}/api`,
        sid: null,
        note: null,
        reviewRounds: 0,
      },
    ],
    integration: { branch: `coord/${planId}/integration`, sid: null, note: null },
    note: null,
    updatedAt: 1,
  });

  it("opens the plan and the workspace label; refuses a plan whose id doesn't match its row", async () => {
    const h = await setup();
    const key = await fromB64url(h.me.pubBox);
    const sealFor = (sid: string, p: unknown) => sealJson(p, { [h.me.deviceId]: key }, `coord:${sid}`);
    h.db.seed("sessions", {
      owner: OWNER,
      sid: "s1",
      device_id: h.agent.deviceId,
      doc: { cwdLabel: "taquito", coord: { planId: "pabcdefgh", ct: await sealFor("s1", plan("pabcdefgh")) } },
    });
    h.db.seed("sessions", {
      owner: OWNER,
      sid: "s2",
      device_id: h.agent.deviceId,
      doc: { coord: { planId: "pother000", ct: await sealFor("s2", plan("pabcdefgh")) } },
    });
    h.db.seed("sessions", {
      owner: OWNER,
      sid: "s3",
      device_id: h.agent.deviceId,
      doc: { coord: { planId: "pabcdefgh", ct: await sealFor("s1", plan("pabcdefgh")) } },
    });
    h.live.start();
    await tick(30);
    const byId = new Map(h.live.getSnapshot().sessions.map((s) => [s.sid, s]));
    expect(byId.get("s1")).toMatchObject({
      workspaceLabel: "taquito",
      coord: { planId: "pabcdefgh", status: "awaiting_approval" },
    });
    expect(byId.get("s2")!.coord).toBeNull();
    // Sealed for another session: doesn't open here.
    expect(byId.get("s3")!.coord).toBeNull();
  });
});
