import {
  TrustedClientList,
  canonicalize,
  fromB64url,
  openJson,
  sealJson,
  sha256,
  signEnvelope,
  utf8,
} from "@chalito/crypto";
import { CommandBody, SignedCommand, planDigestInput, type CoordPlanState } from "@chalito/protocol";
import { describe, expect, it } from "vitest";
import { ActionError, ClientActions, coordDigest } from "../src/actions.js";
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
  integration: { branch: `coord/${planId}/integration`, sid: null, note: null, head: null },
  note: null,
  updatedAt: 1,
});

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

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

  it("approve and merge carry this device's passkey and the digest of the plan shown; stop doesn't ask", async () => {
    const h = await setup();
    const p = plan("pabcdefgh");
    await h.actions.coordApprove(h.agent.deviceId, p);
    const approve = await h.sent();
    const expected = await coordDigest(p, "approve");
    expect(approve.payload).toEqual({ type: "coord.approve", planId: "pabcdefgh", digest: expected });
    expect(approve.stepUp).toMatchObject({ method: "platform_biometric" });
    // The digest is what the agent computes: SHA-256(JCS(planDigestInput)).
    expect(expected).toBe(hex(await sha256(utf8(canonicalize(planDigestInput(p, "approve"))))));
    const ready = { ...p, status: "ready_to_merge" as const, integration: { ...p.integration, head: "c".repeat(40) } };
    await h.actions.coordMerge(h.agent.deviceId, ready);
    const merge = await h.sent();
    expect((merge.payload as { digest: string }).digest).toBe(await coordDigest(ready, "merge"));
    expect(await coordDigest(ready, "merge")).not.toBe(
      await coordDigest({ ...ready, integration: { ...ready.integration, head: "d".repeat(40) } }, "merge"),
    );
    expect(h.asked).toEqual([
      { aid: `coord-approve:pabcdefgh:${expected.slice(0, 16)}`, risk: "HIGH", agentDeviceId: h.agent.deviceId },
      {
        aid: `coord-merge:pabcdefgh:${(await coordDigest(ready, "merge")).slice(0, 16)}`,
        risk: "HIGH",
        agentDeviceId: h.agent.deviceId,
      },
    ]);
    await h.actions.coordStop(h.agent.deviceId, "pabcdefgh");
    expect((await h.sent()).stepUp).toBeUndefined();
    expect(h.asked).toHaveLength(2);
  });

  it("without the passkey, approve and merge send nothing", async () => {
    const h = await setup(async () => null);
    await expect(h.actions.coordApprove(h.agent.deviceId, plan("pabcdefgh"))).rejects.toEqual(
      new ActionError("passkey_required"),
    );
    await expect(h.actions.coordMerge(h.agent.deviceId, plan("pabcdefgh"))).rejects.toBeInstanceOf(ActionError);
    expect(h.db.rows("commands")).toHaveLength(0);
  });
});

describe("the plan on the session (sealed by the agent)", () => {
  it("shows a plan only when the agent that wrote the row signed it with a key this device trusts", async () => {
    const h = await setup();
    const stranger = await newDevice();
    const key = await fromB64url(h.me.pubBox);
    const seal = (sid: string, v: unknown) => sealJson(v, { [h.me.deviceId]: key }, `coord:${sid}`);
    const signed = (p: CoordPlanState, by = h.agent) =>
      signEnvelope("chalito.coordplan.v1", p, by.deviceId, by.sign.secretKey);
    const row = async (sid: string, planId: string, content: unknown) =>
      h.db.seed("sessions", {
        owner: OWNER,
        sid,
        device_id: h.agent.deviceId,
        doc: { cwdLabel: "anything", coord: { planId, ct: await seal(sid, content) } },
      });
    await row("ok", "pabcdefgh", await signed(plan("pabcdefgh")));
    await row("unsigned", "pabcdefgh", plan("pabcdefgh"));
    await row("stranger", "pabcdefgh", await signed(plan("pabcdefgh"), stranger));
    const forged = await signed(plan("pabcdefgh"));
    await row("tampered", "pabcdefgh", { ...forged, body: { ...forged.body, goal: "something else" } });
    await row("otherid", "pother000", await signed(plan("pabcdefgh")));
    h.live.start();
    await tick(40);
    const byId = new Map(h.live.getSnapshot().sessions.map((x) => [x.sid, x]));
    expect(byId.get("ok")!.coord).toMatchObject({ planId: "pabcdefgh", status: "awaiting_approval" });
    for (const sid of ["unsigned", "stranger", "tampered", "otherid"]) expect(byId.get(sid)!.coord, sid).toBeNull();
    // The plaintext column is never offered as the workspace label.
    expect(byId.get("ok")).not.toHaveProperty("workspaceLabel");
  });
});
