/**
 * prompt_session end to end: Claude (OAuth, session:prompt) → gateway → api (RelayedCommand) →
 * the real AgentCore with Developer mode autoApproveHigh ON → a HIGH action from that MCP turn
 * still waits for a passkey-signed decision from the phone. The agent and fake Claude Code are the
 * same ones apps/agent tests with, imported by path.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "@chalito/adapters/claude-code";
import { fakeClaudeCode, type FakeStep } from "@chalito/adapters/testing";
import { loadLiabilityText } from "@chalito/config";
import {
  MemoryNonceStore,
  TrustedClientList,
  generateBoxKeyPair,
  generateSigningKeyPair,
  openJson,
  randomNonce,
  sealJson,
  signEnvelope,
  stepUpChallenge,
  toB64url,
} from "@chalito/crypto";
import type { DecisionBody } from "@chalito/protocol";
import { SoftAuthenticator } from "@chalito/client-keys/testing";
import { AgentCore } from "../../agent/src/agent-core.js";
import { DevMode, DevModeStore } from "../../agent/src/devmode.js";
import { DEFAULT_POLICY } from "../../agent/src/policy/index.js";
import { createLogger } from "../../agent/src/redact.js";
import { MemoryStore } from "../../agent/src/store.js";
import { gatewayHarness } from "./harness.js";

const WS = "/home/aldo/code/chalito";
const pushTurn: FakeStep[] = [{ tool: "Bash", input: { command: "git push origin fix-login" } }];

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const agentFor = async (owner: string, turns: FakeStep[][]) => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  const agent = { id: "dev_agent", sign, box, pubBox: await toB64url(box.publicKey) };
  const phoneSign = await generateSigningKeyPair();
  const phone = { id: "dev_phone", sign: phoneSign };
  const store = new MemoryStore();
  const trust = new TrustedClientList(agent.id);
  const phoneBox = await generateBoxKeyPair();
  const passkey = new SoftAuthenticator({ origin: "https://chalito.chalyb.com" });
  const passkeyRef = { credentialId: passkey.credentialId, publicKey: passkey.publicKey, rpId: "chalito.chalyb.com" };
  await trust.addConfirmed(
    {
      deviceId: phone.id,
      pubSign: await toB64url(phoneSign.publicKey),
      pubBox: await toB64url(phoneBox.publicKey),
      webauthn: passkeyRef,
    },
    Date.now(),
  );
  const liability = loadLiabilityText("es");
  const devMode = new DevMode({
    store: new DevModeStore(mkdtempSync(join(tmpdir(), "chalito-gw-")), sign, agent.id),
    osAuth: { verify: async () => true },
    prompter: {
      first: async () => true,
      second: async () => true,
      liability: async () => ({ checked: true, typed: liability.phrase }),
    },
    liability,
    deviceId: agent.id,
    now: Date.now,
    emit: async () => undefined,
  });
  await devMode.enableToggle("autoApproveHigh");
  const fake = fakeClaudeCode(turns);
  const policy = { ...DEFAULT_POLICY, workspaces: [{ label: "chalito", path: WS }] };
  const core = new AgentCore({
    store,
    adapters: { "claude-code": new ClaudeCodeAdapter({ apiKey: "sk-ant-test", queryFn: fake.queryFn, env: {} }) },
    policy: { get: () => policy, set: async () => undefined },
    devMode,
    trust: () => trust,
    saveTrust: async () => undefined,
    nonces: new MemoryNonceStore(),
    owner,
    self: { deviceId: agent.id, pubBox: agent.pubBox, box, sign },
    home: "/home/aldo",
    locale: () => "es",
    now: Date.now,
    log: createLogger(() => undefined),
    setTimer: () => ({ clear: () => undefined }),
  });

  /** The phone starts a session with a signed command (a trusted, client-origin turn). */
  const startSigned = async (prompt: string) => {
    const cid = "c_start_0001";
    const body = {
      v: 1,
      cid,
      uid: owner,
      targetDeviceId: agent.id,
      origin: `client:${phone.id}`,
      nonce: await randomNonce(),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      payload: {
        type: "session.start",
        adapter: "claude-code",
        workspaceLabel: "chalito",
        promptCt: await sealJson(prompt, { [agent.id]: box.publicKey }, `command:${cid}`),
        permissionMode: "default",
      },
    };
    const env = await signEnvelope("chalito.command.v1", body, phone.id, phoneSign.secretKey);
    return core.handleCommand(cid, { env, fromDeviceId: phone.id });
  };
  /** The phone signs a decision on the latest pending approval, optionally with its passkey. */
  const decide = async (allow: boolean, stepUp: boolean) => {
    const pending = store.pendingApprovals().at(-1)!;
    const body: DecisionBody = {
      v: 1,
      aid: pending.aid,
      requestId: pending.requestId,
      uid: owner,
      targetDeviceId: agent.id,
      allow,
      nonce: await randomNonce(),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      // ADR 0019: answer for exactly what the agent signed (opened from the sealed details).
      detailsHash: (
        await openJson<{ request: { body: { detailsHash: string } } }>(
          pending.detailsCt,
          phone.id,
          phoneBox,
          `approval:${pending.aid}`,
        )
      ).request.body.detailsHash,
    };
    if (stepUp) {
      const assertion = await passkey.stepUp(passkeyRef.rpId)(await stepUpChallenge(body));
      body.stepUp = { method: "webauthn", at: Date.now(), assertion };
    }
    store.attachDecision(pending.aid, await signEnvelope("chalito.decision.v1", body, phone.id, phoneSign.secretKey));
  };
  return { core, store, fake, agent, startSigned, decide };
};

describe("prompt_session → HIGH tool → only a signed phone decision releases it", () => {
  it("even with Developer mode autoApproveHigh on", async () => {
    const g = await gatewayHarness();
    const a = await agentFor(g.o, [pushTurn, pushTurn]);

    // A client-origin turn: autoApproveHigh lets the HIGH push run without asking.
    expect(await a.startSigned("arregla el login")).toEqual({ ok: true });
    await waitFor(() => a.fake.run.ran.length === 1);
    expect(a.store.pendingApprovals()).toHaveLength(0);
    const sid = [...a.core.sessions.keys()][0]!;

    // The session as the gateway and api see it.
    g.data.agents.set(sid, { deviceId: a.agent.id, pubBox: a.agent.pubBox });
    g.mcp.sessions.set(`${g.o}/${sid}`, a.agent.id);
    g.mcp.devices.add(`${g.o}/${a.agent.id}`);

    const t = await g.connect(["mcp:read", "session:prompt"]);
    const c = await g.mcpClient(t.access_token);
    const sent = g.result(await c.callTool({ name: "prompt_session", arguments: { sid, prompt: "push otra vez" } }));
    expect(sent.value).toMatchObject({ sent: true });

    // What the api queued for the agent: an unsigned RelayedCommand, origin mcp:claude, sealed prompt.
    const queued = g.mcp.commands[0]!;
    expect(queued.targetDeviceId).toBe(a.agent.id);
    expect(queued.env).toMatchObject({ relayedBy: "mcp-gateway", body: { origin: "mcp:claude" } });
    expect(JSON.stringify(queued.env)).not.toContain("push otra vez");

    // Delivered to the agent: the MCP turn's HIGH push waits.
    expect(await a.core.handleCommand(queued.id, { env: queued.env, fromDeviceId: "mcp-gateway" })).toEqual({
      ok: true,
    });
    await waitFor(() => a.store.pendingApprovals().length === 1);
    expect(a.store.pendingApprovals()[0]).toMatchObject({ origin: "mcp:claude", risk: "HIGH", stepUpRequired: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(a.fake.run.ran).toHaveLength(1);

    // A signed allow WITHOUT the passkey step-up does not release a HIGH action.
    await a.decide(true, false);
    await new Promise((r) => setTimeout(r, 50));
    expect(a.fake.run.ran).toHaveLength(1);

    // The signed decision with the phone's passkey does.
    if (a.store.pendingApprovals().length === 0) throw new Error("approval vanished without a valid decision");
    await a.decide(true, true);
    await waitFor(() => a.fake.run.ran.length === 2);
    expect(a.fake.run.ran[1]!.tool).toBe("Bash");
  });

  it("a replayed relayed prompt is rejected", async () => {
    const g = await gatewayHarness();
    const a = await agentFor(g.o, [pushTurn, pushTurn]);
    await a.startSigned("hola");
    await waitFor(() => a.fake.run.ran.length === 1);
    const sid = [...a.core.sessions.keys()][0]!;
    g.data.agents.set(sid, { deviceId: a.agent.id, pubBox: a.agent.pubBox });
    g.mcp.sessions.set(`${g.o}/${sid}`, a.agent.id);
    g.mcp.devices.add(`${g.o}/${a.agent.id}`);
    const c = await g.mcpClient((await g.connect(["session:prompt"])).access_token);
    await c.callTool({ name: "prompt_session", arguments: { sid, prompt: "otra" } });
    const q = g.mcp.commands[0]!;
    expect((await a.core.handleCommand(q.id, { env: q.env, fromDeviceId: "mcp-gateway" })).ok).toBe(true);
    expect((await a.core.handleCommand(q.id, { env: q.env, fromDeviceId: "mcp-gateway" })).ok).toBe(false);
  });
});
