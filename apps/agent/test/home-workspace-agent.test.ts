// Owner 2026-11-02: the home-folder workspace's fences through the real AgentCore gate.
// A coordinator helper and a native hook both get a human prompt (or a block) for every fence.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
import type { DecisionBody, RiskTier } from "@chalito/protocol";
import { AgentCore, type SessionCoord } from "../src/agent-core.js";
import { DevMode, DevModeStore } from "../src/devmode.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy/index.js";
import { createLogger } from "../src/redact.js";
import { MemoryStore } from "../src/store.js";

const OWNER = "hub-user-1";

const makeHome = () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "chalito-homeagent-")));
  const file = (rel: string) => {
    mkdirSync(dirname(join(home, rel)), { recursive: true });
    writeFileSync(join(home, rel), "x");
  };
  for (const f of [
    ".ssh/id_ed25519",
    ".bashrc",
    ".claude/settings.json",
    ".chalito/policy.yaml",
    "projects/x/src/a.ts",
    "wayak/a.md",
  ])
    file(f);
  symlinkSync(join(home, ".ssh/id_ed25519"), join(home, "projects/x/key.txt"));
  return home;
};

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

const harness = async (turns: FakeStep[][], home: string) => {
  const agent = await device("dev_agent");
  const phone = await device("dev_phone");
  const store = new MemoryStore();
  const trust = new TrustedClientList(agent.id);
  await trust.addConfirmed({ deviceId: phone.id, pubSign: phone.pubSign, pubBox: phone.pubBox }, Date.now());
  const policy: Policy = {
    ...DEFAULT_POLICY,
    allowEverything: { enabled: false },
    workspaces: [{ label: "home", path: home }],
    workspaceExclude: [join(home, "wayak")],
    coordinator: { enabled: true },
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
    home,
    locale: () => "es",
    now: Date.now,
    log: createLogger(() => undefined),
    // The approval timeouts (10 min) are what these tests fire; the 20-min stall watch isn't driven here.
    setTimer: (fn, ms) => {
      if (ms <= 10 * 60_000) timers.push(fn);
      return { clear: () => undefined };
    },
  });
  let active = true;
  const coord: SessionCoord = { planId: "p1", taskId: "t1", branchPrefix: "coord/p1/", active: () => active };
  const start = (
    withCoord = true,
    origin: "agent:coord_p1" | "client:dev_phone" | "agent:coord_p2" = "agent:coord_p1",
  ) =>
    core.startSession({
      adapter: "claude-code",
      workspace: { label: "home", path: home },
      prompt: "haz la tarea",
      origin,
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
  const autoAllows = () => store.audits.filter((a) => a.type === "coordinator.auto_allow");
  return { core, store, fake, timers, start, decide, autoAllows, stop: () => void (active = false) };
};

const edit = (file_path: string): FakeStep => ({
  tool: "Edit",
  input: { file_path, old_string: "x", new_string: "y" },
});
const read = (file_path: string): FakeStep => ({ tool: "Read", input: { file_path } });

describe("home-folder workspace through the real gate", () => {
  it("coordinator helper: a project edit is answered for the owner, reading ~/.bashrc goes to the phone", async () => {
    const home = makeHome();
    const h = await harness([[edit(`${home}/projects/x/src/a.ts`), read(`${home}/.bashrc`), { say: "ok" }]], home);
    await h.start();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    expect(h.fake.run.ran).toHaveLength(1);
    expect(h.autoAllows().map((a) => a.meta.kind)).toEqual(["workspace_edit"]);
    await h.decide(false);
    await waitFor(() => h.fake.run.refused.length === 1);
  });

  it("coordinator helper: keys, startup files, ~/.chalito and the excluded folder are never answered for the owner", async () => {
    const home = makeHome();
    for (const step of [
      edit(`${home}/.bashrc`),
      edit(`${home}/.claude/settings.json`),
      { tool: "Write", input: { file_path: `${home}/.chalito/policy.yaml`, content: "x" } } as FakeStep,
      read(`${home}/.ssh/id_ed25519`),
      read(`${home}/projects/x/key.txt`),
      read(`${home}/wayak/a.md`),
      { tool: "Bash", input: { command: "cat ~/.claude/settings.json" } } as FakeStep,
      { tool: "Grep", input: { pattern: "KEY", path: home } } as FakeStep,
    ]) {
      const h = await harness([[step, { say: "ok" }]], home);
      await h.start();
      await waitFor(() => h.fake.run.refused.length === 1 || h.store.pendingApprovals().length === 1);
      expect(h.fake.run.ran, JSON.stringify(step)).toHaveLength(0);
      expect(h.autoAllows(), JSON.stringify(step)).toHaveLength(0);
    }
  });

  it("native hook path: a fence asks (HIGH) or is blocked, a project read passes on its own", async () => {
    const home = makeHome();
    const h = await harness([], home);
    const ask = async (toolName: string, input: Record<string, unknown>) => {
      const abort = new AbortController();
      let risk: RiskTier | null = null;
      const p = h.core.requestNativeTool({
        sid: "native_1",
        cwd: join(home, "projects/x"),
        toolName,
        input,
        forcePrompt: false,
        signal: abort.signal,
        onRequested: (_aid, _exp, r) => {
          risk = r;
          abort.abort();
        },
      });
      const out = await p;
      return { out, risk: risk as RiskTier | null };
    };
    expect((await ask("Read", { file_path: `${home}/projects/x/src/a.ts` })).out).toEqual({
      allow: true,
      reason: "policy_read",
    });
    for (const [tool, input] of [
      ["Read", { file_path: `${home}/.bashrc` }],
      ["Read", { file_path: `${home}/.claude/settings.json` }],
      ["Read", { file_path: `${home}/wayak/a.md` }],
      ["Grep", { pattern: "KEY", path: home }],
      ["Bash", { command: "grep -r KEY ~" }],
    ] as const) {
      const r = await ask(tool, input);
      expect(r.risk, JSON.stringify(input)).toBe("HIGH");
      expect(r.out.allow, JSON.stringify(input)).toBe(false);
    }
    for (const [tool, input] of [
      ["Edit", { file_path: `${home}/.bashrc`, old_string: "x", new_string: "y" }],
      ["Read", { file_path: `${home}/.ssh/id_ed25519` }],
      ["Read", { file_path: `${home}/projects/x/key.txt` }],
      ["Write", { file_path: `${home}/.chalito/policy.yaml`, content: "x" }],
      ["Bash", { command: "echo x >> ~/.profile" }],
    ] as const) {
      const r = await ask(tool, input);
      expect(r.risk, JSON.stringify(input)).toBeNull();
      expect(r.out.allow, JSON.stringify(input)).toBe(false);
    }
  });
});
