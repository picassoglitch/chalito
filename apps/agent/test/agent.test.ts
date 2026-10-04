import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, fakeClaudeCode, type FakeStep } from "@chalito/adapters/claude-code";
import { loadLiabilityText } from "@chalito/config";
import {
  MemoryNonceStore,
  TrustedClientList,
  generateBoxKeyPair,
  generateSigningKeyPair,
  randomNonce,
  sealJson,
  signEnvelope,
  toB64url,
  type BoxKeyPair,
  type SigningKeyPair,
} from "@chalito/crypto";
import type { CommandPayload, DecisionBody } from "@chalito/protocol";
import { AgentCore, type PolicyHolder } from "../src/agent-core.js";
import { DevMode, DevModeStore } from "../src/devmode.js";
import { DEFAULT_POLICY, policyHash, type Policy } from "../src/policy/index.js";
import { createLogger } from "../src/redact.js";
import { MemoryStore } from "../src/store.js";

const OWNER = "hub-user-1";
const HOME = "/home/aldo";
const WS = "/home/aldo/code/chalito";
const CALL = `call:CA${"a".repeat(32)}`;

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
};

interface Device {
  id: string;
  sign: SigningKeyPair;
  box: BoxKeyPair;
  pubSign: string;
  pubBox: string;
}
const device = async (id: string): Promise<Device> => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  return { id, sign, box, pubSign: await toB64url(sign.publicKey), pubBox: await toB64url(box.publicKey) };
};

const harness = async (
  opts: {
    turns?: FakeStep[][];
    policy?: Partial<Policy>;
    devToggles?: ("allowSudo" | "autoApproveHigh" | "autoApproveCritical")[];
  } = {},
) => {
  const agent = await device("dev_agent");
  const phone = await device("dev_phone");
  const store = new MemoryStore();
  const trust = new TrustedClientList(agent.id);
  await trust.addConfirmed({ deviceId: phone.id, pubSign: phone.pubSign, pubBox: phone.pubBox }, Date.now());

  let policy: Policy = { ...DEFAULT_POLICY, workspaces: [{ label: "chalito", path: WS }], ...opts.policy };
  const policyChanges: string[] = [];
  const holder: PolicyHolder = {
    get: () => policy,
    set: async (p, via) => {
      policy = p;
      policyChanges.push(via);
      await store.updateDevice({ policyHash: policyHash(p) });
    },
  };

  const dmStore = new DevModeStore(mkdtempSync(join(tmpdir(), "chalito-agent-")));
  const liability = loadLiabilityText("es");
  const devMode = new DevMode({
    store: dmStore,
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
  for (const t of opts.devToggles ?? []) await devMode.enableToggle(t);

  const timers: (() => void)[] = [];
  const logs: string[] = [];
  const fake = fakeClaudeCode(opts.turns ?? []);
  const core = new AgentCore({
    store,
    adapters: { "claude-code": new ClaudeCodeAdapter({ apiKey: "sk-ant-test", queryFn: fake.queryFn, env: {} }) },
    policy: holder,
    devMode,
    trust: () => trust,
    saveTrust: async () => undefined,
    nonces: new MemoryNonceStore(),
    owner: OWNER,
    self: { deviceId: agent.id, pubBox: agent.pubBox, box: agent.box },
    home: HOME,
    locale: () => "es",
    now: Date.now,
    log: createLogger((l) => logs.push(l)),
    setTimer: (fn) => {
      timers.push(fn);
      return { clear: () => undefined };
    },
  });

  let n = 0;
  const command = async (
    payload: unknown,
    o: {
      origin?: string;
      signer?: Device;
      relayed?: "mcp-gateway" | "notifier";
      target?: string;
      expiresAt?: number;
    } = {},
  ) => {
    const cid = `c${++n}`;
    const body = {
      v: 1,
      cid,
      uid: OWNER,
      targetDeviceId: o.target ?? agent.id,
      origin: o.origin ?? `client:${(o.signer ?? phone).id}`,
      nonce: await randomNonce(),
      issuedAt: Date.now(),
      expiresAt: o.expiresAt ?? Date.now() + 60_000,
      payload,
    };
    const env = o.relayed
      ? { relayedBy: o.relayed, body }
      : await signEnvelope("chalito.command.v1", body, (o.signer ?? phone).id, (o.signer ?? phone).sign.secretKey);
    return core.handleCommand(cid, { env, fromDeviceId: phone.id });
  };
  const sealed = async (cidNext: number, value: unknown) =>
    sealJson(value, { [agent.id]: agent.box.publicKey }, `command:c${cidNext}`);
  const startSession = async (prompt = "arregla el login", origin?: string, relayed?: "mcp-gateway") => {
    const payload: CommandPayload = {
      type: "session.start",
      adapter: "claude-code",
      workspaceLabel: "chalito",
      promptCt: await sealed(n + 1, prompt),
      permissionMode: "default",
    };
    if (relayed) return command({ type: "session.prompt", sid: "x", promptCt: payload.promptCt }, { origin, relayed });
    return command(payload, origin ? { origin } : {});
  };
  const decide = async (
    allow: boolean,
    o: { stepUp?: boolean; signer?: Device; aid?: string; requestId?: string; nonce?: string } = {},
  ) => {
    const pending = store.pendingApprovals().at(-1)!;
    const body: DecisionBody = {
      v: 1,
      aid: o.aid ?? pending.aid,
      requestId: o.requestId ?? pending.requestId,
      uid: OWNER,
      targetDeviceId: agent.id,
      allow,
      nonce: o.nonce ?? (await randomNonce()),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      ...(o.stepUp ? { stepUp: { method: "platform_biometric" as const, at: Date.now() } } : {}),
    };
    const signer = o.signer ?? phone;
    const env = await signEnvelope("chalito.decision.v1", body, signer.id, signer.sign.secretKey);
    store.attachDecision(pending.aid, env);
    return env;
  };
  return {
    core,
    store,
    fake,
    phone,
    agent,
    trust,
    command,
    startSession,
    decide,
    timers,
    logs,
    devMode,
    policyChanges,
    sealed,
    getPolicy: () => policy,
  };
};

const editTurn: FakeStep[][] = [
  [{ tool: "Edit", input: { file_path: `${WS}/src/login.ts`, old_string: "a", new_string: "b" } }, { say: "listo" }],
];
const pushTurn: FakeStep[][] = [[{ tool: "Bash", input: { command: "git push origin fix-login" } }]];

describe("signed approvals end to end (fake Claude Code)", () => {
  it("a MED edit waits for the phone; a signed allow releases it", async () => {
    const h = await harness({ turns: editTurn });
    expect(await h.startSession()).toEqual({ ok: true });
    await waitFor(() => h.store.pendingApprovals().length === 1);
    expect(h.fake.run.ran).toHaveLength(0);
    await h.decide(true);
    await waitFor(() => h.fake.run.ran.length === 1);
    expect(h.fake.run.ran[0]!.tool).toBe("Edit");
    await waitFor(() => [...h.store.approvals.values()][0]!.status === "approved");
    expect(h.store.events.some((e) => e.type === "approval.resolved" && e.allow)).toBe(true);
  });

  it("a signed deny refuses the tool", async () => {
    const h = await harness({ turns: editTurn });
    await h.startSession();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    await h.decide(false);
    await waitFor(() => h.fake.run.refused.length === 1);
    expect(h.fake.run.ran).toHaveLength(0);
  });

  it("an unanswered approval is denied when it expires (10 min)", async () => {
    const h = await harness({ turns: editTurn });
    await h.startSession();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    expect([...h.store.approvals.values()][0]!.expiresAt - [...h.store.approvals.values()][0]!.createdAt).toBe(600_000);
    h.timers.forEach((fire) => fire());
    await waitFor(() => h.fake.run.refused.length === 1);
    await waitFor(() => [...h.store.approvals.values()][0]!.status === "expired");
  });

  it("replayed, untrusted, wrong-request and unsigned decisions are rejected and logged", async () => {
    const h = await harness({ turns: [[...editTurn[0]!, { tool: "Edit", input: { file_path: `${WS}/b.ts` } }]] });
    await h.startSession();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    const first = await h.decide(true);
    await waitFor(() => h.store.pendingApprovals().length === 1 && h.fake.run.ran.length === 1);

    const pending = h.store.pendingApprovals()[0]!;
    h.store.attachDecision(pending.aid, first); // replay of the previous decision (other aid)
    const stranger = await device("dev_stranger");
    await h.decide(true, { signer: stranger }); // a key the server might list, never trusted locally
    await h.decide(true, { nonce: first.body.nonce }); // reused nonce
    h.store.attachDecision(pending.aid, { allow: true }); // unsigned
    await new Promise((r) => setTimeout(r, 50));
    expect(h.fake.run.ran).toHaveLength(1);
    expect(h.logs.filter((l) => l.includes("approval.decision_rejected")).length).toBeGreaterThanOrEqual(4);

    await h.decide(true);
    await waitFor(() => h.fake.run.ran.length === 2);
  });

  it("HIGH needs step-up; an allow without it is rejected", async () => {
    const h = await harness({ turns: pushTurn });
    await h.startSession();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    expect(h.store.pendingApprovals()[0]!.stepUpRequired).toBe(true);
    await h.decide(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.fake.run.ran).toHaveLength(0);
    await h.decide(true, { stepUp: true });
    await waitFor(() => h.fake.run.ran.length === 1);
  });

  it("a revoked phone's decision is rejected even when the server still delivers it", async () => {
    const h = await harness({ turns: editTurn });
    await h.startSession();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    h.trust.remove(h.phone.id);
    await h.decide(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.fake.run.ran).toHaveLength(0);
  });
});

describe("the remote side can never widen the device", () => {
  it("bypassPermissions, dontAsk and auto are rejected (and logged as remote-enable attempts)", async () => {
    const h = await harness({ turns: editTurn });
    for (const mode of ["bypassPermissions", "dontAsk", "auto"]) {
      const res = await h.command({
        type: "session.start",
        adapter: "claude-code",
        workspaceLabel: "chalito",
        promptCt: await h.sealed(99, "x"),
        permissionMode: mode,
      });
      expect(res.ok).toBe(false);
    }
    expect(h.store.deviceEvents.filter((e) => e.type === "remote_enable.rejected")).toHaveLength(3);
    expect(h.core.sessions.size).toBe(0);
  });

  it("a mode above the local ceiling is rejected", async () => {
    const h = await harness({
      turns: editTurn,
      policy: { remote: { maxPermissionMode: "default", maxCodexSandbox: "read-only" } },
    });
    const res = await h.command({
      type: "session.start",
      adapter: "claude-code",
      workspaceLabel: "chalito",
      promptCt: await h.sealed(1, "x"),
      permissionMode: "acceptEdits",
    });
    expect(res).toEqual({ ok: false, reason: "permission_mode_above_ceiling" });
  });

  it("enabling Developer mode or a toggle remotely is rejected, even with a valid signature or from MCP/call", async () => {
    const h = await harness();
    expect((await h.command({ type: "devmode.on" })).reason).toBe("remote_enable_rejected");
    expect((await h.command({ type: "devmode.toggleOn", toggle: "allowSudo" })).reason).toBe("remote_enable_rejected");
    expect((await h.command({ type: "devmode.on" }, { origin: "mcp:chatgpt", relayed: "mcp-gateway" })).reason).toBe(
      "remote_enable_rejected",
    );
    expect((await h.command({ type: "policy.loosen" }, { origin: CALL, relayed: "notifier" })).reason).toBe(
      "remote_enable_rejected",
    );
    expect(h.devMode.state.on).toBe(false);
    expect(h.store.deviceEvents.filter((e) => e.type === "remote_enable.rejected")).toHaveLength(4);
  });

  it("a signed remote turn-off applies immediately", async () => {
    const h = await harness({ devToggles: ["allowSudo", "autoApproveHigh"] });
    expect(h.devMode.state.toggles).toEqual(["allowSudo", "autoApproveHigh"]);
    expect(await h.command({ type: "devmode.toggleOff", toggle: "allowSudo" })).toEqual({ ok: true });
    expect(h.devMode.state.toggles).toEqual(["autoApproveHigh"]);
    expect(await h.command({ type: "devmode.off" })).toEqual({ ok: true });
    expect(h.devMode.state.on).toBe(false);
  });

  it("unsigned relayed commands can only prompt or answer; commands from untrusted keys, for other devices or expired are rejected", async () => {
    const h = await harness();
    expect((await h.command({ type: "devmode.off" }, { origin: "mcp:claude", relayed: "mcp-gateway" })).ok).toBe(false);
    const stranger = await device("dev_x");
    expect((await h.command({ type: "devmode.off" }, { signer: stranger })).reason).toBe("untrusted_signer");
    expect((await h.command({ type: "devmode.off" }, { origin: "client:someone_else" })).reason).toBe(
      "origin_mismatch",
    );
    expect((await h.command({ type: "devmode.off" }, { target: "dev_other" })).reason).toBe("wrong_device");
    expect((await h.command({ type: "devmode.off" }, { expiresAt: Date.now() - 1 })).reason).toBe("expired");
  });

  it("disabled origins are refused", async () => {
    const h = await harness({ policy: { origins: { local: true, client: true, mcp: false, call: true } } });
    expect(
      (
        await h.command(
          { type: "session.prompt", sid: "s", promptCt: await h.sealed(1, "x") },
          { origin: "mcp:chatgpt", relayed: "mcp-gateway" },
        )
      ).reason,
    ).toBe("origin_disabled");
  });
});

describe("Developer mode never reaches unsigned turns or the hard floor", () => {
  it("with autoApproveHigh on, a HIGH action from a client turn runs, but from an MCP or call turn it still waits", async () => {
    const h = await harness({ turns: [pushTurn[0]!, pushTurn[0]!, pushTurn[0]!], devToggles: ["autoApproveHigh"] });
    await h.startSession();
    await waitFor(() => h.fake.run.ran.length === 1);
    expect(h.store.pendingApprovals()).toHaveLength(0);

    const sid = [...h.core.sessions.keys()][0]!;
    await h.command(
      { type: "session.prompt", sid, promptCt: await h.sealed(2, "push otra vez") },
      { origin: "mcp:chatgpt", relayed: "mcp-gateway" },
    );
    await waitFor(() => h.store.pendingApprovals().length === 1);
    expect(h.fake.run.ran).toHaveLength(1);
    await h.decide(true, { stepUp: true });
    await waitFor(() => h.fake.run.ran.length === 2);

    await h.command(
      { type: "session.prompt", sid, promptCt: await h.sealed(3, "y otra") },
      { origin: CALL, relayed: "notifier" },
    );
    await waitFor(() => h.store.pendingApprovals().length === 1);
    expect(h.fake.run.ran).toHaveLength(2);
  });

  it("editing ~/.chalito is blocked even with every toggle on", async () => {
    const h = await harness({
      turns: [[{ tool: "Edit", input: { file_path: `${HOME}/.chalito/policy.yaml` } }]],
      devToggles: ["allowSudo", "autoApproveHigh", "autoApproveCritical"],
    });
    await h.startSession();
    await waitFor(() => h.fake.run.refused.length === 1);
    expect(h.store.pendingApprovals()).toHaveLength(0);
  });
});

describe("local policy changes", () => {
  it("a remote tighten applies and updates policyHash; a remote loosen is rejected", async () => {
    const h = await harness();
    const before = policyHash(h.getPolicy());
    expect(
      await h.command({ type: "policy.tighten", patchCt: await h.sealed(1, { origins: { mcp: false } }) }),
    ).toEqual({ ok: true });
    expect(h.getPolicy().origins.mcp).toBe(false);
    expect(h.store.device.policyHash).not.toBe(before);
    expect(await h.command({ type: "policy.tighten", patchCt: await h.sealed(2, { origins: { mcp: true } }) })).toEqual(
      { ok: false, reason: "would_loosen" },
    );
  });

  it("a cloud preset is only a proposal until accepted on the device", async () => {
    const h = await harness({ policy: { origins: { local: true, client: true, mcp: false, call: false } } });
    expect(await h.command({ type: "policy.proposePreset", preset: "relajado" })).toEqual({ ok: true });
    expect(h.getPolicy().origins.mcp).toBe(false);
    expect(await h.core.acceptPendingPreset()).toBe(true);
    expect(h.getPolicy().origins.mcp).toBe(true);
    expect(h.policyChanges).toEqual(["preset_accepted"]);
  });
});

describe("call lines", () => {
  it("are published only when the user enabled call briefing and local policy allows it", async () => {
    const h = await harness({ turns: editTurn });
    h.store.briefingEnabled = false;
    await h.startSession();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.store.callLines.size).toBe(0);

    const h2 = await harness({ turns: editTurn, policy: { egress: { callLines: false, mcpCards: false } } });
    await h2.startSession();
    await waitFor(() => h2.store.pendingApprovals().length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(h2.store.callLines.size).toBe(0);

    const h3 = await harness({ turns: editTurn });
    await h3.startSession();
    await waitFor(() => h3.store.callLines.size === 1);
    const [line] = [...h3.store.callLines.values()];
    expect(line!.line).toBe("El agente de chalito necesita tu respuesta.");
    expect(line!.line).not.toMatch(/\/|login\.ts|git/);
  });
});

describe("events and cards", () => {
  it("content in events is sealed; metadata stays plaintext; the card stays small", async () => {
    const h = await harness({ turns: [[{ say: "voy a revisar src/login.ts" }]] });
    await h.startSession("arregla el login, mi token es sk-ant-api03-SECRETSECRETSECRET");
    await waitFor(() => h.store.events.some((e) => e.type === "message.assistant"));
    const msg = h.store.events.find((e) => e.type === "message.assistant")!;
    expect(JSON.stringify(msg)).not.toContain("login.ts");
    const session = [...h.store.sessions.values()][0]!;
    expect(JSON.stringify(session)).not.toContain("SECRET");
  });
});
