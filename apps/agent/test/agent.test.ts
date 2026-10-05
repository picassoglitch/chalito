import { createHash } from "node:crypto";
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
  canonicalize,
  generateSigningKeyPair,
  openJson,
  randomNonce,
  revokeAllServerEntry,
  revokeBundleChallenge,
  sealJson,
  signEnvelope,
  stepUpBodyHash,
  stepUpChallenge,
  toB64url,
  verifyEnvelope,
  type BoxKeyPair,
  type SigningKeyPair,
} from "@chalito/crypto";
import { CommandAcceptedMeta, CommandRejectedMeta } from "@chalito/protocol";
import type { CommandPayload, DecisionBody, SealedEnvelope } from "@chalito/protocol";
import { SoftAuthenticator } from "@chalito/client-keys/testing";
import { AgentCore, type PolicyHolder } from "../src/agent-core.js";
import { publicReason } from "../src/command-result.js";
import { DevMode, DevModeStore } from "../src/devmode.js";
import { DEFAULT_POLICY, policyHash, type Policy } from "../src/policy/index.js";
import { createLogger } from "../src/redact.js";
import { MemoryStore } from "../src/store.js";
import { syncEndorsements } from "../src/endorsement-sync.js";

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
    classifyExtras?: () => { agentBinaries: string[]; protectedPaths: string[]; pathDirs: string[] };
  } = {},
) => {
  const agent = await device("dev_agent");
  const phone = await device("dev_phone");
  const store = new MemoryStore();
  const trust = new TrustedClientList(agent.id);
  // The phone's passkey, recorded at the local reverse check (D-019): HIGH allows need its assertion.
  const passkey = new SoftAuthenticator({ origin: "https://chalito.chalyb.com" });
  const passkeyRef = { credentialId: passkey.credentialId, publicKey: passkey.publicKey, rpId: "chalito.chalyb.com" };
  await trust.addConfirmed(
    { deviceId: phone.id, pubSign: phone.pubSign, pubBox: phone.pubBox, webauthn: passkeyRef },
    Date.now(),
  );

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

  const dmStore = new DevModeStore(mkdtempSync(join(tmpdir(), "chalito-agent-")), agent.sign, agent.id);
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
    self: { deviceId: agent.id, pubBox: agent.pubBox, box: agent.box, sign: agent.sign },
    home: HOME,
    locale: () => "es",
    now: Date.now,
    log: createLogger((l) => logs.push(l)),
    ...(opts.classifyExtras ? { classifyExtras: opts.classifyExtras } : {}),
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
    o: {
      stepUp?: boolean;
      /** Replaces the passkey step-up (negative tests). */
      customStepUp?: (body: DecisionBody) => Promise<DecisionBody["stepUp"]>;
      signer?: Device;
      aid?: string;
      requestId?: string;
      nonce?: string;
      /** ADR 0019: override the hash (null = omit it) for negative tests. */
      detailsHash?: string | null;
    } = {},
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
      // ADR 0019: the phone answers for exactly what the agent signed (opened from detailsCt).
      detailsHash:
        o.detailsHash === undefined
          ? (
              await openJson<{ request: { body: { detailsHash: string } } }>(
                pending.detailsCt,
                phone.id,
                phone.box,
                `approval:${pending.aid}`,
              )
            ).request.body.detailsHash
          : (o.detailsHash ?? undefined),
    };
    if (body.detailsHash === undefined) delete body.detailsHash;
    if (o.customStepUp) body.stepUp = await o.customStepUp(body);
    else if (o.stepUp) {
      const assertion = await passkey.stepUp(passkeyRef.rpId)(await stepUpChallenge(body));
      body.stepUp = { method: "webauthn", at: Date.now(), assertion };
    }
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
    passkey,
    passkeyRef,
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
    expect(await h.startSession()).toEqual({ ok: true, sid: expect.any(String) });
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

  it("HIGH step-up must be a passkey assertion this agent can verify (D-019)", async () => {
    const h = await harness({ turns: pushTurn });
    await h.startSession();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    // Self-asserted method: no longer enough.
    await h.decide(true, { customStepUp: async () => ({ method: "platform_biometric", at: Date.now() }) });
    // An assertion made for a different decision (here: the opposite verdict).
    await h.decide(true, {
      customStepUp: async (b) => ({
        method: "webauthn",
        at: Date.now(),
        assertion: await h.passkey.stepUp(h.passkeyRef.rpId)(await stepUpChallenge({ ...b, allow: false })),
      }),
    });
    // A different authenticator claiming the recorded credential id.
    const rogue = new SoftAuthenticator({ origin: "https://chalito.chalyb.com" });
    await h.decide(true, {
      customStepUp: async (b) => ({
        method: "webauthn",
        at: Date.now(),
        assertion: {
          ...(await rogue.stepUp("chalito.chalyb.com")(await stepUpChallenge(b))),
          credentialId: h.passkeyRef.credentialId,
        },
      }),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.fake.run.ran).toHaveLength(0);
    const rejected = h.logs.filter((l) => l.includes("missing_step_up"));
    expect(rejected.some((l) => l.includes("no_webauthn_assertion"))).toBe(true);
    expect(rejected.some((l) => l.includes("assertion_wrong_challenge"))).toBe(true);
    expect(rejected.some((l) => l.includes("assertion_bad_signature"))).toBe(true);
    await h.decide(true, { stepUp: true });
    await waitFor(() => h.fake.run.ran.length === 1);
  });

  it("a trusted client without a recorded passkey can't approve HIGH", async () => {
    const h = await harness({ turns: pushTurn });
    const second = await device("dev_tablet");
    await h.trust.addConfirmed({ deviceId: second.id, pubSign: second.pubSign, pubBox: second.pubBox }, Date.now());
    await h.startSession();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    await h.decide(true, { signer: second, stepUp: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.fake.run.ran).toHaveLength(0);
    expect(h.logs.some((l) => l.includes("no_passkey_recorded"))).toBe(true);
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

describe("host hard floor (classifyExtras)", () => {
  const UNIT = `${HOME}/.config/systemd/user/chalito-agent.service`;

  it("an Edit of a protected service file is refused even with every Developer-mode toggle on", async () => {
    const h = await harness({
      turns: [[{ tool: "Edit", input: { file_path: UNIT, old_string: "a", new_string: "b" } }]],
      devToggles: ["allowSudo", "autoApproveHigh", "autoApproveCritical"],
      classifyExtras: () => ({ agentBinaries: [], protectedPaths: [UNIT], pathDirs: [] }),
    });
    await h.startSession();
    await waitFor(() => h.fake.run.refused.length === 1);
    expect(h.fake.run.ran).toHaveLength(0);
    expect(h.store.pendingApprovals()).toHaveLength(0);
    await waitFor(() => h.store.events.some((e) => e.type === "tool.started"));
    expect(h.store.events.find((e) => e.type === "tool.started")).toMatchObject({ risk: "CRITICAL" });
  });

  it("without the extras the same file isn't on the floor (so the wiring is what blocks it)", async () => {
    const h = await harness({
      turns: [[{ tool: "Edit", input: { file_path: UNIT, old_string: "a", new_string: "b" } }]],
      devToggles: ["allowSudo", "autoApproveHigh", "autoApproveCritical"],
    });
    await h.startSession();
    await waitFor(() => h.fake.run.ran.length + h.fake.run.refused.length + h.store.pendingApprovals().length > 0);
    expect(h.fake.run.refused).toHaveLength(0);
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

describe("revoking another client takes a passkey step-up (review R-L1)", () => {
  const setup = async (o: { phonePasskey?: boolean } = {}) => {
    const h = await harness();
    const tablet = await device("dev_tablet");
    await h.trust.addConfirmed({ deviceId: tablet.id, pubSign: tablet.pubSign, pubBox: tablet.pubBox }, Date.now());
    if (o.phonePasskey === false) {
      // A setup where no trusted client has a passkey yet.
      h.trust.remove(h.phone.id);
      await h.trust.addConfirmed(
        { deviceId: h.phone.id, pubSign: h.phone.pubSign, pubBox: h.phone.pubBox },
        Date.now(),
      );
    }
    let n = 0;
    const revoke = async (signer: Device, target: string, stepUp?: "valid" | "other_body") => {
      const cid = `rv${++n}`;
      const body: Record<string, unknown> = {
        v: 1,
        cid,
        uid: OWNER,
        targetDeviceId: h.agent.id,
        origin: `client:${signer.id}`,
        nonce: await randomNonce(),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        payload: { type: "device.revokeClient", clientDeviceId: target },
      };
      if (stepUp) {
        const challengeBody =
          stepUp === "valid"
            ? body
            : { ...body, payload: { type: "device.revokeClient", clientDeviceId: "dev_other" } };
        const assertion = await h.passkey.stepUp(h.passkeyRef.rpId)(await stepUpChallenge(challengeBody as never));
        body.stepUp = { method: "webauthn", at: Date.now(), assertion };
      }
      const env = await signEnvelope("chalito.command.v1", body, signer.id, signer.sign.secretKey);
      return h.core.handleCommand(cid, { env, fromDeviceId: signer.id });
    };
    return { h, tablet, revoke };
  };

  it("without a step-up it's refused and the client stays trusted", async () => {
    const { h, tablet, revoke } = await setup();
    expect(await revoke(h.phone, tablet.id)).toEqual({ ok: false, reason: "step_up_required" });
    expect(h.trust.has(tablet.id)).toBe(true);
  });

  it("with the signer's passkey over this very command it goes through", async () => {
    const { h, tablet, revoke } = await setup();
    expect(await revoke(h.phone, tablet.id, "valid")).toEqual({ ok: true });
    expect(h.trust.has(tablet.id)).toBe(false);
  });

  it("an assertion made for a different command doesn't count", async () => {
    const { h, tablet, revoke } = await setup();
    const r = await revoke(h.phone, tablet.id, "other_body");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^step_up_/);
    expect(h.trust.has(tablet.id)).toBe(true);
  });

  it("a client without a passkey (e.g. a stolen tablet) can't remove the last passkey-bearing phone", async () => {
    const { h, tablet, revoke } = await setup();
    expect(await revoke(tablet, h.phone.id)).toEqual({ ok: false, reason: "step_up_required" });
    expect(h.trust.has(h.phone.id)).toBe(true);
  });

  it("revoking oneself never needs a step-up", async () => {
    const { tablet, revoke, h } = await setup();
    expect(await revoke(tablet, tablet.id)).toEqual({ ok: true });
    expect(h.trust.has(tablet.id)).toBe(false);
  });

  it("while no trusted client has a passkey, a plain revoke still works", async () => {
    const { h, tablet, revoke } = await setup({ phonePasskey: false });
    expect(await revoke(h.phone, tablet.id)).toEqual({ ok: true });
  });
});

describe("revoke-all: one passkey assertion over a bundle of commands (ADR 0020)", () => {
  const setup = async () => {
    const h = await harness();
    const others = [await device("dev_tablet"), await device("dev_laptop"), await device("dev_tv")];
    for (const d of others)
      await h.trust.addConfirmed({ deviceId: d.id, pubSign: d.pubSign, pubBox: d.pubBox }, Date.now());
    let n = 0;
    const unsigned = async (target: string): Promise<Record<string, unknown>> => ({
      v: 1,
      cid: `rb${++n}`,
      uid: OWNER,
      targetDeviceId: h.agent.id,
      origin: `client:${h.phone.id}`,
      nonce: await randomNonce(),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      payload: { type: "device.revokeClient", clientDeviceId: target },
    });
    /** The client's side: hashes, the server entry, ONE assertion, the bundle on every body. */
    const bundle = async (bodies: Record<string, unknown>[], extra: string[] = []) => {
      const server = await revokeAllServerEntry({ uid: OWNER, deviceId: h.phone.id, challenge: "srv-challenge" });
      const L = [...(await Promise.all(bodies.map((b) => stepUpBodyHash(b)))), ...extra, server];
      const assertion = await h.passkey.stepUp(h.passkeyRef.rpId)(await revokeBundleChallenge(L));
      for (const b of bodies) b.stepUp = { method: "webauthn", at: Date.now(), assertion, bundle: L };
      return L;
    };
    const send = async (body: Record<string, unknown>) => {
      const env = await signEnvelope("chalito.command.v1", body, h.phone.id, h.phone.sign.secretKey);
      return h.core.handleCommand(String(body.cid), { env, fromDeviceId: h.phone.id });
    };
    return { h, others, unsigned, bundle, send };
  };

  it("one assertion covers every command of the bundle", async () => {
    const { h, others, unsigned, bundle, send } = await setup();
    const bodies = await Promise.all(others.map((d) => unsigned(d.id)));
    await bundle(bodies);
    for (const b of bodies) expect(await send(b)).toEqual({ ok: true });
    for (const d of others) expect(h.trust.has(d.id)).toBe(false);
  });

  it("a command that isn't in the bundle is refused, even carrying the bundle's assertion", async () => {
    const { h, others, unsigned, bundle, send } = await setup();
    const [inside, outside] = [await unsigned(others[0]!.id), await unsigned(others[1]!.id)];
    await bundle([inside]);
    outside.stepUp = inside.stepUp;
    expect(await send(outside)).toEqual({ ok: false, reason: "step_up_not_in_bundle" });
    expect(h.trust.has(others[1]!.id)).toBe(true);
    expect(await send(inside)).toEqual({ ok: true });
  });

  it("a bundle whose hashes were changed after the ceremony fails the assertion", async () => {
    const { h, others, unsigned, bundle, send } = await setup();
    const b = await unsigned(others[0]!.id);
    const L = await bundle([b]);
    const forged = await unsigned(others[1]!.id);
    forged.stepUp = { ...(b.stepUp as object), bundle: [...L, await stepUpBodyHash(forged)] };
    expect(await send(forged)).toEqual({ ok: false, reason: "step_up_wrong_challenge" });
    expect(h.trust.has(others[1]!.id)).toBe(true);
  });

  it("a withheld command from an old bundle is refused once the passkey signed something newer", async () => {
    const { h, others, unsigned, bundle, send } = await setup();
    const [first, withheld] = [await unsigned(others[0]!.id), await unsigned(others[1]!.id)];
    await bundle([first, withheld]);
    expect(await send(first)).toEqual({ ok: true });
    // A newer revoke-all (the counter moves forward on this computer).
    const newer = await unsigned(others[2]!.id);
    await bundle([newer]);
    expect(await send(newer)).toEqual({ ok: true });
    expect(await send(withheld)).toEqual({ ok: false, reason: "step_up_replayed" });
    expect(h.trust.has(others[1]!.id)).toBe(true);
  });

  it("only device.revokeClient can carry a bundle", async () => {
    const { unsigned, bundle } = await setup();
    const b = await unsigned("dev_tablet");
    await bundle([b]);
    const { CommandBody } = await import("@chalito/protocol");
    expect(CommandBody.safeParse(b).success).toBe(true);
    expect(CommandBody.safeParse({ ...b, payload: { type: "devmode.off" } }).success).toBe(false);
  });
});

describe("MCP card sharing (opt-in)", () => {
  const twoTurns: FakeStep[][] = [[{ say: "voy a revisar src/login.ts" }], [{ say: "listo" }]];
  const sidOf = (h: Awaited<ReturnType<typeof harness>>) => [...h.core.sessions.keys()][0]!;

  it("off by default: no plaintext card is written", async () => {
    const h = await harness({ turns: twoTurns });
    await h.startSession("arregla el login");
    await waitFor(() => h.store.events.some((e) => e.type === "message.assistant"));
    expect(h.store.sharedCards.size).toBe(0);
  });

  it("on: the same redacted card as the sealed one; off: it stops being written", async () => {
    const h = await harness({ turns: twoTurns });
    await h.startSession("arregla el login, mi token es sk-ant-api03-SECRETSECRETSECRET");
    const sid = sidOf(h);
    h.store.sharing.add(sid);
    await h.command({ type: "session.prompt", sid, promptCt: await h.sealed(2, "sigue") });
    await waitFor(() => h.store.sharedCards.has(sid));
    const shared = h.store.sharedCards.get(sid)!;
    expect(JSON.stringify(shared)).not.toContain("SECRET");
    const sealed = h.store.sessions.get(sid)!.card as { ct: SealedEnvelope };
    expect(await openJson(sealed.ct, h.phone.id, h.phone.box, `card:${sid}`)).toEqual(shared);

    // Turning it off deletes the copy (database trigger) and the agent stops writing it.
    h.store.sharing.delete(sid);
    h.store.sharedCards.delete(sid);
    await h.command({ type: "session.prompt", sid, promptCt: await h.sealed(3, "otra") });
    await waitFor(() => h.store.events.filter((e) => e.type === "message.assistant").length >= 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.store.sharedCards.size).toBe(0);
  });

  it("device-wide sharing covers every session; a failed write never breaks the session", async () => {
    const h = await harness({ turns: twoTurns });
    h.store.sharing.add("device");
    h.store.writeSharedCard = async () => {
      throw new Error("rls");
    };
    await h.startSession("arregla el login");
    await waitFor(() => h.store.events.some((e) => e.type === "message.assistant"));
    expect(h.logs.some((l) => l.includes("card.share_failed"))).toBe(true);
  });
});

describe("turn origin follows the least trusted voice in the turn (review #10)", () => {
  const askThenPush: FakeStep[][] = [
    [
      { tool: "AskUserQuestion", input: { questions: [{ question: "¿Hago push?", options: [{ label: "Sí" }] }] } },
      pushTurn[0]![0]!,
    ],
  ];
  const answer = async (h: Awaited<ReturnType<typeof harness>>, o: { origin?: string; relayed?: "mcp-gateway" }) => {
    await waitFor(() => h.store.events.some((e) => e.type === "question.asked"));
    const q = h.store.events.find((e) => e.type === "question.asked") as { questionId: string; sid: string };
    return h.command(
      {
        type: "session.answer",
        sid: q.sid,
        questionId: q.questionId,
        answerCt: await h.sealed(2, { "¿Hago push?": "Sí" }),
      },
      o,
    );
  };

  it("a signed answer keeps Developer-mode auto-approve for the client turn", async () => {
    const h = await harness({ turns: askThenPush, devToggles: ["autoApproveHigh"] });
    await h.startSession();
    expect(await answer(h, {})).toEqual({ ok: true, sid: expect.any(String) });
    await waitFor(() => h.fake.run.ran.length === 2);
    expect(h.store.pendingApprovals()).toHaveLength(0);
  });

  it("a relayed answer is refused (relays only prompt, review R-L2); the question waits for a signed one", async () => {
    const h = await harness({ turns: askThenPush, devToggles: ["autoApproveHigh"] });
    await h.startSession();
    expect(await answer(h, { origin: "mcp:chatgpt", relayed: "mcp-gateway" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(h.fake.run.ran.map((r) => r.tool)).toEqual([]);
  });
});

describe("the Codex sandbox ceiling is enforced remotely", () => {
  it("session.start and setPermissionMode above maxCodexSandbox are rejected", async () => {
    const h = await harness({
      turns: [[{ say: "hola" }]],
      policy: { remote: { maxPermissionMode: "acceptEdits", maxCodexSandbox: "read-only" } },
    });
    const res = await h.command({
      type: "session.start",
      adapter: "claude-code",
      workspaceLabel: "chalito",
      promptCt: await h.sealed(1, "x"),
      permissionMode: "default",
      codexSandbox: "workspace-write",
    });
    expect(res).toEqual({ ok: false, reason: "codex_sandbox_above_ceiling" });

    expect(await h.startSession()).toEqual({ ok: true, sid: expect.any(String) });
    const sid = [...h.core.sessions.keys()][0]!;
    const set = await h.command({
      type: "session.setPermissionMode",
      sid,
      permissionMode: "default",
      codexSandbox: "workspace-write",
    });
    expect(set).toEqual({ ok: false, reason: "codex_sandbox_above_ceiling" });
    expect(
      await h.command({ type: "session.setPermissionMode", sid, permissionMode: "default", codexSandbox: "read-only" }),
    ).toEqual({ ok: true, sid: expect.any(String) });
  });
});

describe("durable audit trail", () => {
  it("routes agent audits and device events to store.audit, redacted", async () => {
    const h = await harness();
    await h.command({ type: "devmode.on" });
    await waitFor(() => h.store.audits.filter((a) => a.type === "remote_enable.rejected").length === 2);
    const sources = h.store.audits.filter((a) => a.type === "remote_enable.rejected").map((a) => a.source);
    expect(sources.sort()).toEqual(["agent", "deviceEvent"]);
    await h.command({ type: "session.prompt", sid: "nope", promptCt: await h.sealed(2, "x") });
    await waitFor(() => h.store.audits.some((a) => a.type === "command.rejected"));
  });

  it("a failing audit write is logged, never thrown", async () => {
    const h = await harness();
    h.store.audit = async () => {
      throw new Error("offline");
    };
    expect((await h.command({ type: "session.interrupt", sid: "nope" })).reason).toBe("unknown_session");
    await waitFor(() => h.logs.some((l) => l.includes("command.result_publish_failed")));
  });

  it("audit meta is redacted before it reaches the store", async () => {
    const h = await harness();
    const secret = "sk-ant-abcdefghijklmnop";
    await h.command({
      type: "session.start",
      adapter: "claude-code",
      workspaceLabel: "chalito",
      promptCt: await h.sealed(1, "x"),
      permissionMode: `bypass ${secret}`,
    });
    await waitFor(() => h.store.audits.some((a) => a.source === "agent" && a.type === "remote_enable.rejected"));
    const entry = h.store.audits.find((a) => a.source === "agent" && a.type === "remote_enable.rejected")!;
    expect(String(entry.meta.attempted)).toContain("bypass");
    expect(JSON.stringify(entry)).not.toContain(secret);
    expect(JSON.stringify(h.store.deviceEvents)).not.toContain(secret);
  });
});

describe("R-L13: an endorsement can't smuggle in a passkey (ADR 0018)", () => {
  const RP = "chalito.chalyb.com";
  /** An attacker device with its own passkey and a binding signed by its own key. */
  const attackerWithPasskey = async () => {
    const attacker = await device("dev_attacker");
    const auth = new SoftAuthenticator({ origin: `https://${RP}` });
    const binding = await signEnvelope(
      "chalito.webauthn-binding.v1",
      {
        v: 1,
        deviceId: attacker.id,
        credentialId: auth.credentialId,
        publicKey: auth.publicKey,
        rpId: RP,
        issuedAt: Date.now(),
      },
      attacker.id,
      attacker.sign.secretKey,
    );
    return { attacker, auth, binding };
  };
  const endorsement = (signer: Device, subject: Device) =>
    signEnvelope(
      "chalito.endorsement.v1",
      {
        v: 1,
        uid: OWNER,
        newDeviceId: subject.id,
        pubSign: subject.pubSign,
        pubBox: subject.pubBox,
        issuedAt: Date.now(),
      },
      signer.id,
      signer.sign.secretKey,
    );
  const sync = (h: Awaited<ReturnType<typeof harness>>, refused: [string, string][]) =>
    syncEndorsements({
      store: h.store,
      trust: () => h.trust,
      saveTrust: async () => undefined,
      now: Date.now,
      onAdded: () => undefined,
      onRefused: (id, _by, reason) => refused.push([id, reason]),
      reported: new Set(),
    });

  it("a stolen phone WITHOUT its passkey can't get an attacker's device trusted; the refusal is reported", async () => {
    const h = await harness();
    const { attacker, binding } = await attackerWithPasskey();
    // The thief holds the phone's device key, not its passkey: no endorser step-up.
    h.store.endorsements.push({
      deviceId: attacker.id,
      endorsement: await endorsement(h.phone, attacker),
      revoked: false,
      webauthnBinding: binding,
    });
    const refused: [string, string][] = [];
    expect(await sync(h, refused)).toEqual([]);
    expect(h.trust.has(attacker.id)).toBe(false);
    expect(refused).toEqual([[attacker.id, "missing_step_up"]]);
  });

  it("an endorser with no passkey here: the client is accepted but its own passkey never passes HIGH", async () => {
    const h = await harness({ turns: pushTurn });
    // A second trusted client confirmed WITHOUT a passkey (e.g. a browser before enrolling one).
    const tablet = await device("dev_tablet");
    await h.trust.addConfirmed({ deviceId: tablet.id, pubSign: tablet.pubSign, pubBox: tablet.pubBox }, Date.now());
    const { attacker, auth, binding } = await attackerWithPasskey();
    h.store.endorsements.push({
      deviceId: attacker.id,
      endorsement: await endorsement(tablet, attacker),
      revoked: false,
      webauthnBinding: binding,
    });
    expect(await sync(h, [])).toEqual([attacker.id]);
    expect(h.trust.webauthnFor(attacker.id)).toBeUndefined();

    // A HIGH approval: the attacker's allow with ITS OWN valid passkey assertion is refused.
    await h.startSession();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    await h.decide(true, {
      signer: attacker,
      customStepUp: async (b) => ({
        method: "webauthn",
        at: Date.now(),
        assertion: await auth.stepUp(RP)(await stepUpChallenge(b)),
      }),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.fake.run.ran).toHaveLength(0);
    // The phone (passkey recorded at the reverse check) still can.
    await h.decide(true, { stepUp: true });
    await waitFor(() => h.fake.run.ran.length === 1);
  });
});

describe("R-H1: a decision is bound to what the agent signed (ADR 0019)", () => {
  const medEdit: FakeStep[][] = [
    [{ tool: "Edit", input: { file_path: `${WS}/src/app.ts`, old_string: "a", new_string: "b" } }],
  ];
  const opened = async (h: Awaited<ReturnType<typeof harness>>) => {
    const p = h.store.pendingApprovals().at(-1)!;
    return {
      row: p,
      payload: await openJson<{
        details: Record<string, unknown>;
        request: Parameters<typeof verifyEnvelope>[0] & { body: Record<string, unknown> };
      }>(p.detailsCt, h.phone.id, h.phone.box, `approval:${p.aid}`),
    };
  };

  it("the sealed payload carries the agent's signature over the row and the exact details", async () => {
    const h = await harness({ turns: medEdit });
    await h.startSession();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    const { row, payload } = await opened(h);
    const sig = await verifyEnvelope(
      payload.request,
      "chalito.approval.v1",
      new Map([[h.agent.id, h.agent.sign.publicKey]]),
    );
    expect(sig.ok).toBe(true);
    expect(payload.request.body).toMatchObject({
      aid: row.aid,
      requestId: row.requestId,
      deviceId: h.agent.id,
      risk: row.risk,
      stepUpRequired: row.stepUpRequired,
      detailsHash: createHash("sha256").update(canonicalize(payload.details)).digest("hex"),
    });
  });

  it("an allow without the hash, or for other details, never runs; a deny needs no hash", async () => {
    const h = await harness({ turns: medEdit });
    await h.startSession();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    await h.decide(true, { detailsHash: null });
    await h.decide(true, { detailsHash: "0".repeat(64) });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.fake.run.ran).toHaveLength(0);
    expect(h.logs.join("\n")).toMatch(/details_mismatch/);
    await h.decide(false, { detailsHash: null });
    await waitFor(() => [...h.store.approvals.values()].some((a) => a.status === "denied"));
  });

  it("the attack: the server swaps details_ct for harmless text; the phone's honest allow for it is refused", async () => {
    const h = await harness({ turns: medEdit });
    await h.startSession();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    const { row } = await opened(h);
    // The attacker seals its own "details" to the phone (anonymous sealing allows that)…
    const fake = {
      v: 1,
      toolName: "Read",
      summary: "Read: README.md",
      input: { file_path: "README.md" },
      reasons: [],
      origin: "local",
    };
    const swapped = await sealJson({ details: fake }, { [h.phone.id]: h.phone.box.publicKey }, `approval:${row.aid}`);
    h.store.approvals.set(row.aid, { ...h.store.approvals.get(row.aid)!, detailsCt: swapped });
    // …and a phone that (wrongly) trusted it answers for what it was shown.
    const fakeHash = createHash("sha256").update(canonicalize(fake)).digest("hex");
    await h.decide(true, { detailsHash: fakeHash });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.fake.run.ran).toHaveLength(0);
  });
});

describe("command results reach the person's clients (audit: command.accepted / command.rejected)", () => {
  const results = (h: Awaited<ReturnType<typeof harness>>) =>
    h.store.audits
      .filter((a) => a.type === "command.accepted" || a.type === "command.rejected")
      .map((a) => ({ type: a.type, source: a.source, meta: a.meta }));

  it("an accepted session.start says which session it started, and touches no device event", async () => {
    const h = await harness({ turns: editTurn });
    const r = await h.startSession();
    expect(results(h)).toEqual([{ type: "command.accepted", source: "agent", meta: { cid: "c1", sid: r.sid } }]);
    expect(CommandAcceptedMeta.parse(results(h)[0]!.meta)).toEqual({ cid: "c1", sid: r.sid });
    expect(h.core.sessions.has(r.sid!)).toBe(true);
    // devices.last_event keeps whatever security notice it holds.
    expect(h.store.deviceEvents.filter((e) => e.type.startsWith("command."))).toEqual([]);
  });

  it("refusals carry a closed reason and nothing else (no labels, paths or text), one row each", async () => {
    const h = await harness();
    const start = (over: Partial<CommandPayload>) =>
      h.sealed(0, "x").then((promptCt) =>
        h.command({
          type: "session.start",
          adapter: "claude-code",
          workspaceLabel: "chalito",
          promptCt,
          permissionMode: "default",
          ...over,
        } as CommandPayload),
      );
    await start({ workspaceLabel: "/home/ana/secret-project" });
    await start({ adapter: "codex" });
    await h.command({ type: "session.interrupt", sid: "nope" });
    await h.command({ type: "devmode.off" }, { expiresAt: Date.now() - 1 });
    const stranger = await device("dev_stranger");
    await h.command({ type: "devmode.off" }, { signer: stranger });
    const r = results(h);
    expect(r.map((e) => [e.type, e.meta])).toEqual([
      ["command.rejected", { cid: "c1", reason: "unknown_workspace" }],
      ["command.rejected", { cid: "c2", reason: "adapter_disabled" }],
      ["command.rejected", { cid: "c3", reason: "unknown_session" }],
      ["command.rejected", { cid: "c4", reason: "expired" }],
      ["command.rejected", { cid: "c5", reason: "untrusted_signer" }],
    ]);
    for (const e of r) expect(CommandRejectedMeta.strict().safeParse(e.meta).success).toBe(true);
    expect(JSON.stringify(h.store.audits)).not.toContain("secret-project");
  });

  it("a garbled command row is reported as invalid; a malformed row id gets no row", async () => {
    const h = await harness();
    await h.core.handleCommand("c9", { env: { nope: true } });
    await h.core.handleCommand("bad id/../x", { env: { nope: true } });
    expect(results(h)).toEqual([{ type: "command.rejected", source: "agent", meta: { cid: "c9", reason: "invalid" } }]);
  });

  it("internal reasons map onto the closed set", () => {
    expect(publicReason("unknown_workspace")).toBe("unknown_workspace");
    expect(publicReason("invalid_signature")).toBe("bad_signature");
    expect(publicReason("wrong_context")).toBe("bad_signature");
    expect(publicReason("would_loosen")).toBe("policy_would_loosen");
    expect(publicReason("invalid_patch")).toBe("policy_invalid");
    expect(publicReason("step_up_counter")).toBe("step_up_failed");
    expect(publicReason("step_up_required")).toBe("step_up_required");
    expect(publicReason("/etc/passwd")).toBe("internal");
    expect(publicReason(undefined)).toBe("internal");
  });
});
