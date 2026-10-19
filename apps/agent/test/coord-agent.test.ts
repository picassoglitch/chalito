/**
 * Coordinator mode through the real AgentCore gate (ADR 0025 §6): a helper session's prompts are
 * answered by Chalito within this computer's ceiling and the owner's remembered rules; the rest
 * asks the phone, a timeout asks again while the plan runs, and computer control is refused.
 */
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
  generateSigningKeyPair,
  openJson,
  randomNonce,
  signEnvelope,
  toB64url,
} from "@chalito/crypto";
import { rememberMatchFor, ruleMatchText, type DecisionBody } from "@chalito/protocol";
import { AgentCore, type SessionCoord } from "../src/agent-core.js";
import { DevMode, DevModeStore } from "../src/devmode.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy/index.js";
import { createLogger } from "../src/redact.js";
import { MemoryStore } from "../src/store.js";

const OWNER = "hub-user-1";
const WS = "/home/aldo/code/taquito";

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const device = async (id: string) => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  return { id, sign, box, pubSign: await toB64url(sign.publicKey), pubBox: await toB64url(box.publicKey) };
};

const harness = async (turns: FakeStep[][], policyOver: Partial<Policy> = {}) => {
  const agent = await device("dev_agent");
  const phone = await device("dev_phone");
  const store = new MemoryStore();
  const trust = new TrustedClientList(agent.id);
  await trust.addConfirmed({ deviceId: phone.id, pubSign: phone.pubSign, pubBox: phone.pubBox }, Date.now());
  const policy: Policy = {
    ...DEFAULT_POLICY,
    workspaces: [{ label: "taquito", path: WS }],
    coordinator: { enabled: true },
    ...policyOver,
  };
  const liability = loadLiabilityText("es");
  const devMode = new DevMode({
    store: new DevModeStore(mkdtempSync(join(tmpdir(), "chalito-coord-")), agent.sign, agent.id),
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
  const timers: (() => void)[] = [];
  const fake = fakeClaudeCode(turns);
  const core = new AgentCore({
    store,
    adapters: { "claude-code": new ClaudeCodeAdapter({ apiKey: "sk-ant-test", queryFn: fake.queryFn, env: {} }) },
    policy: { get: () => policy, set: async () => undefined },
    devMode,
    trust: () => trust,
    saveTrust: async () => undefined,
    nonces: new MemoryNonceStore(),
    owner: OWNER,
    self: { deviceId: agent.id, pubBox: agent.pubBox, box: agent.box, sign: agent.sign },
    home: "/home/aldo",
    locale: () => "es",
    now: Date.now,
    log: createLogger(() => undefined),
    setTimer: (fn) => {
      timers.push(fn);
      return { clear: () => undefined };
    },
  });
  let active = true;
  const coord: SessionCoord = { planId: "p1", taskId: "t1", branchPrefix: "coord/p1/", active: () => active };
  const start = (withCoord = true) =>
    core.startSession({
      adapter: "claude-code",
      workspace: { label: "taquito", path: WS },
      prompt: "haz la tarea",
      origin: "agent:coord_p1",
      permissionMode: "default",
      ...(withCoord ? { coord } : {}),
    });
  const decide = async (allow: boolean) => {
    const pending = store.pendingApprovals().at(-1)!;
    const opened = await openJson<{ request: { body: { detailsHash: string } } }>(
      pending.detailsCt,
      phone.id,
      phone.box,
      `approval:${pending.aid}`,
    );
    const body: DecisionBody = {
      v: 1,
      aid: pending.aid,
      requestId: pending.requestId,
      uid: OWNER,
      targetDeviceId: agent.id,
      allow,
      nonce: await randomNonce(),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      detailsHash: opened.request.body.detailsHash,
    };
    store.attachDecision(pending.aid, await signEnvelope("chalito.decision.v1", body, phone.id, phone.sign.secretKey));
  };
  const remember = async (command: string) => {
    const m = rememberMatchFor({ toolName: "Bash", input: { command }, workspaceLabel: "taquito" })!;
    const now = Date.now();
    store.coordRules.push(
      await signEnvelope(
        "chalito.coordrule.v1",
        {
          v: 1,
          ruleId: "cr_rule00001",
          uid: OWNER,
          match: createHash("sha256").update(ruleMatchText(m)!).digest("hex"),
          createdAt: now,
          expiresAt: now + 86_400_000,
        },
        phone.id,
        phone.sign.secretKey,
      ),
    );
  };
  const autoAllows = () => store.audits.filter((a) => a.type === "coordinator.auto_allow");
  return { core, store, fake, timers, start, decide, remember, autoAllows, stop: () => void (active = false) };
};

const bash = (command: string): FakeStep => ({ tool: "Bash", input: { command } });

describe("coordinator helper sessions", () => {
  it("Chalito answers the owner's list on its own: edits, local git, installs, tests, the plan's branch push", async () => {
    const h = await harness([
      [
        { tool: "Edit", input: { file_path: `${WS}/src/login.ts`, old_string: "a", new_string: "b" } },
        bash("pnpm add zod"),
        bash("pnpm test"),
        bash("git add -A && git commit -m 'fix: login'"),
        bash("git push -u origin coord/p1/t1"),
        { say: "listo" },
      ],
    ]);
    await h.start();
    await waitFor(() => h.fake.run.ran.length === 5);
    expect(h.store.pendingApprovals()).toHaveLength(0);
    expect(h.autoAllows().map((a) => a.meta.kind)).toEqual([
      "workspace_edit",
      "package_install",
      "tests",
      "git_local",
      "coord_branch_push",
    ]);
  });

  it("anything on the ask-first list goes to the phone, and the owner's no stands", async () => {
    const h = await harness([[bash("git push origin main"), { say: "ok" }]]);
    await h.start();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    expect(h.fake.run.ran).toHaveLength(0);
    await h.decide(false);
    await waitFor(() => h.fake.run.refused.length === 1);
    expect(h.autoAllows()).toHaveLength(0);
  });

  it("a remembered rule answers a MED prompt the owner said 'Siempre así' to", async () => {
    const h = await harness([[bash("supabase db push"), { say: "ok" }]]);
    await h.remember("supabase db push");
    await h.start();
    await waitFor(() => h.fake.run.ran.length === 1);
    expect(h.autoAllows()[0]!.meta.via).toBe("remembered_rule");
  });

  it("with coordinator mode off on this computer, nothing is answered for the owner, rules included", async () => {
    const h = await harness([[bash("supabase db push"), { say: "ok" }]], { coordinator: { enabled: false } });
    await h.remember("supabase db push");
    await h.start();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    expect(h.autoAllows()).toHaveLength(0);
  });

  it("a session that isn't a helper gets nothing answered for it", async () => {
    const h = await harness([[bash("pnpm add zod"), { say: "ok" }]]);
    await h.start(false);
    await waitFor(() => h.store.pendingApprovals().length === 1);
    expect(h.autoAllows()).toHaveLength(0);
  });

  it("a timeout asks again while the plan runs, and is a no once it stopped", async () => {
    const h = await harness([[bash("git push origin main"), { say: "ok" }]]);
    await h.start();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    h.timers.shift()!();
    await waitFor(() => h.store.approvals.size === 2 && h.store.pendingApprovals().length === 1);
    expect(h.fake.run.refused).toHaveLength(0);
    h.stop();
    h.timers.shift()!();
    await waitFor(() => h.fake.run.refused.length === 1);
    expect(h.fake.run.ran).toHaveLength(0);
  });

  it("a timeout never becomes a yes: the owner's later allow on the new prompt is what runs it", async () => {
    const h = await harness([[bash("supabase db push"), { say: "ok" }]]);
    await h.start();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    h.timers.shift()!();
    await waitFor(() => h.store.approvals.size === 2 && h.store.pendingApprovals().length === 1);
    expect(h.fake.run.ran).toHaveLength(0);
    await h.decide(true);
    await waitFor(() => h.fake.run.ran.length === 1);
  });
});
