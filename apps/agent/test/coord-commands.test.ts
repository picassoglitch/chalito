/**
 * coord.* commands through the real AgentCore command path (signature, origin, passkey) and a real
 * git repository (ADR 0025 §6, M17 G2). Security review 2026-10-19: approving a plan authorizes
 * auto-answered tool runs, so it needs the signer's passkey like the merge tap; stop stays cheap
 * (no passkey) but, like every coord.* command, only a trusted client's signature reaches it.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "@chalito/adapters/claude-code";
import { fakeClaudeCode, type FakeRun, type FakeStep } from "@chalito/adapters/testing";
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
  verifyEnvelope,
} from "@chalito/crypto";
import { SoftAuthenticator } from "@chalito/client-keys/testing";
import { SignedCoordPlan, type CommandBody, type CoordPlanState, type SealedEnvelope } from "@chalito/protocol";
import { AgentCore } from "../src/agent-core.js";
import { COMPUTER_TOOL_PREFIX } from "../src/computer/tools.js";
import { planDigest } from "../src/coord/coordinator.js";
import { DevMode, DevModeStore } from "../src/devmode.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy/index.js";
import { createLogger } from "../src/redact.js";
import { MemoryStore } from "../src/store.js";

vi.setConfig({ testTimeout: 60_000 });

const ENV_KEYS = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Test";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@example.invalid";
});
afterAll(() => {
  for (const k of ENV_KEYS)
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
});

const OWNER = "hub-user-1";
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const device = async (id: string) => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  return { id, sign, box, pubSign: await toB64url(sign.publicKey), pubBox: await toB64url(box.publicKey) };
};

const PLAN =
  'Plan:\n```json\n{"tasks":[{"id":"a","title":"A","brief":"do a","acceptance":["a"],"files":["a.ts"],"dependsOn":[]}]}\n```';

type QueryFn = ReturnType<typeof fakeClaudeCode>["queryFn"];

const harness = async (o: { coordinator?: boolean; queryFn?: (root: string) => QueryFn } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "coord-cmd-"));
  sh(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "x\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", "init");

  const agent = await device("dev_agent");
  const phone = await device("dev_phone");
  const store = new MemoryStore();
  const trust = new TrustedClientList(agent.id);
  const passkey = new SoftAuthenticator({ origin: "https://chalito.chalyb.com" });
  const passkeyRef = { credentialId: passkey.credentialId, publicKey: passkey.publicKey, rpId: "chalito.chalyb.com" };
  await trust.addConfirmed(
    { deviceId: phone.id, pubSign: phone.pubSign, pubBox: phone.pubBox, webauthn: passkeyRef },
    Date.now(),
  );
  let policy: Policy = {
    ...DEFAULT_POLICY,
    workspaces: [{ label: "proj", path: root }],
    ...(o.coordinator === false ? {} : { coordinator: { enabled: true } }),
  };
  const liability = loadLiabilityText("es");
  const fake = fakeClaudeCode([[{ say: PLAN }]]);
  const core = new AgentCore({
    store,
    adapters: {
      "claude-code": new ClaudeCodeAdapter({
        apiKey: "sk-ant-test",
        queryFn: o.queryFn?.(root) ?? fake.queryFn,
        env: {},
      }),
    },
    policy: { get: () => policy, set: async () => undefined },
    devMode: new DevMode({
      store: new DevModeStore(mkdtempSync(join(tmpdir(), "coord-dm-")), agent.sign, agent.id),
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
    }),
    trust: () => trust,
    saveTrust: async () => undefined,
    nonces: new MemoryNonceStore(),
    owner: OWNER,
    self: { deviceId: agent.id, pubBox: agent.pubBox, box: agent.box, sign: agent.sign },
    home: "/home/aldo",
    locale: () => "es",
    now: Date.now,
    log: createLogger(() => undefined),
    setTimer: () => ({ clear: () => undefined }),
  });
  let n = 0;
  const command = async (payload: unknown, opts: { stepUp?: boolean; relayed?: "mcp-gateway" } = {}) => {
    const cid = `c${++n}`;
    const body = {
      v: 1,
      cid,
      uid: OWNER,
      targetDeviceId: agent.id,
      origin: opts.relayed ? "mcp:claude" : `client:${phone.id}`,
      nonce: await randomNonce(),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      payload,
    } as unknown as CommandBody;
    if (opts.stepUp) {
      const assertion = await passkey.stepUp(passkeyRef.rpId)(await stepUpChallenge(body));
      body.stepUp = { method: "webauthn", at: Date.now(), assertion };
    }
    const env = opts.relayed
      ? { relayedBy: opts.relayed, body }
      : await signEnvelope("chalito.command.v1", body, phone.id, phone.sign.secretKey);
    return core.handleCommand(cid, { env, fromDeviceId: phone.id });
  };
  const goal = async (text: string): Promise<SealedEnvelope> =>
    sealJson(text, { [agent.id]: agent.box.publicKey }, `command:c${n + 1}`);
  /** The plan as the phone opens it from the session doc. */
  const planOf = async (sid: string): Promise<CoordPlanState | null> => {
    const ct = (store.sessions.get(sid) as { coord?: { ct?: SealedEnvelope } } | undefined)?.coord?.ct;
    if (!ct) return null;
    // Security review: the plan is signed by the agent; the phone checks it against the key it trusts.
    const env = SignedCoordPlan.parse(await openJson(ct, phone.id, phone.box, `coord:${sid}`));
    const ok = await verifyEnvelope(env, "chalito.coordplan.v1", new Map([[agent.id, agent.sign.publicKey]]));
    if (!ok.ok) throw new Error(`plan signature: ${ok.reason}`);
    return env.body;
  };
  /** The phone's signed answer to the newest pending approval (no step-up: MED, or a deny). */
  const decide = async (allow: boolean) => {
    const pending = store.pendingApprovals().at(-1)!;
    const opened = await openJson<{ request: { body: { detailsHash: string } } }>(
      pending.detailsCt,
      phone.id,
      phone.box,
      `approval:${pending.aid}`,
    );
    const body = {
      v: 1 as const,
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
  const setPolicy = (p: Partial<Policy>) => void (policy = { ...policy, ...p });
  /** The pending approval's details as the phone opens them (agent-sealed, hash-bound). */
  const pendingDetails = async () => {
    const pending = store.pendingApprovals().at(-1)!;
    return (
      await openJson<{ details: Record<string, unknown> }>(
        pending.detailsCt,
        phone.id,
        phone.box,
        `approval:${pending.aid}`,
      )
    ).details;
  };
  return { core, store, command, goal, planOf, root, fake, decide, setPolicy, pendingDetails };
};

describe("coord.* commands", () => {
  it("start → the phone reads the sealed plan; approve needs the passkey; stop doesn't", async () => {
    const h = await harness();
    const started = await h.command({ type: "coord.start", workspaceLabel: "proj", goalCt: await h.goal("add a") });
    expect(started).toMatchObject({ ok: true, sid: expect.any(String) });
    const sid = (started as { sid: string }).sid;
    await waitFor(async () => (await h.planOf(sid))?.status === "awaiting_approval");
    const plan = (await h.planOf(sid))!;
    expect(plan.tasks.map((t) => t.id)).toEqual(["a"]);

    // Security review: approving without the passkey is refused.
    expect(
      await h.command({ type: "coord.approve", planId: plan.planId, digest: await planDigest(plan, "approve") }),
    ).toEqual({
      ok: false,
      reason: "step_up_required",
    });
    expect((await h.planOf(sid))!.status).toBe("awaiting_approval");
    expect(
      await h.command(
        { type: "coord.approve", planId: plan.planId, digest: await planDigest(plan, "approve") },
        { stepUp: true },
      ),
    ).toMatchObject({
      ok: true,
    });
    await waitFor(async () => (await h.planOf(sid))!.status === "running");

    // The kill switch: signed, no passkey.
    expect(await h.command({ type: "coord.stop", planId: plan.planId })).toMatchObject({ ok: true });
    expect((await h.planOf(sid))!.status).toBe("stopped");
  });

  it("merge needs the passkey too", async () => {
    const h = await harness();
    const started = (await h.command({ type: "coord.start", workspaceLabel: "proj", goalCt: await h.goal("x") })) as {
      sid: string;
    };
    await waitFor(async () => (await h.planOf(started.sid))?.status === "awaiting_approval");
    const { planId } = (await h.planOf(started.sid))!;
    expect(
      await h.command({
        type: "coord.merge",
        planId,
        digest: await planDigest((await h.planOf(started.sid))!, "merge"),
      }),
    ).toEqual({ ok: false, reason: "step_up_required" });
    // With the passkey it reaches the coordinator, which refuses a plan that isn't ready.
    expect(
      await h.command(
        { type: "coord.merge", planId, digest: await planDigest((await h.planOf(started.sid))!, "merge") },
        { stepUp: true },
      ),
    ).toEqual({
      ok: false,
      reason: "plan_not_ready",
    });
  });

  it("no relay carries a coord.* command", async () => {
    const h = await harness();
    for (const payload of [
      { type: "coord.start", workspaceLabel: "proj", goalCt: await h.goal("x") },
      { type: "coord.approve", planId: "pabcdefgh", digest: "a".repeat(64) },
      { type: "coord.stop", planId: "pabcdefgh" },
      { type: "coord.merge", planId: "pabcdefgh", digest: "a".repeat(64) },
    ])
      expect(await h.command(payload, { relayed: "mcp-gateway" })).toEqual({ ok: false, reason: "invalid" });
  });

  it("with coordinator mode off here, nothing starts", async () => {
    const h = await harness({ coordinator: false });
    expect(await h.command({ type: "coord.start", workspaceLabel: "proj", goalCt: await h.goal("x") })).toEqual({
      ok: false,
      reason: "coordinator_off",
    });
  });

  it("end to end: Chalito answers the helpers' routine prompts, asks the phone for a push to main, and the passkey taps run and merge the plan", async () => {
    const asked: string[] = [];
    /**
     * Claude Code, scripted per session by its role, really running each tool call the agent's
     * gate allows (the file write, git) in the session's own folder.
     */
    const executing =
      (root: string): QueryFn =>
      (args) => {
        const cwd = String(args.options.cwd);
        const mode = String(args.options.permissionMode);
        const helper: FakeStep[] = [
          { tool: "Write", input: { file_path: join(cwd, "feature.ts"), content: "export const feature = 1;\n" } },
          { tool: "Bash", input: { command: "git add -A" } },
          { tool: "Bash", input: { command: "git commit -m 'feat: feature'" } },
          { tool: "Bash", input: { command: "git push origin main" } },
          { say: "DONE: added feature.ts" },
        ];
        const steps: FakeStep[] =
          mode === "plan"
            ? cwd === root
              ? [{ say: PLAN }]
              : [{ say: "Looks right.\nAPPROVE" }]
            : cwd.endsWith("integration")
              ? [{ say: "INTEGRATION PASS" }]
              : helper;
        const run: FakeRun = { ran: [], refused: [], modes: [], interrupted: 0 };
        const push = run.ran.push.bind(run.ran);
        run.ran.push = (...items) => {
          for (const it of items) {
            if (it.tool === "Write") writeFileSync(String(it.input.file_path), String(it.input.content));
            if (it.tool === "Bash") execSync(String(it.input.command), { cwd, stdio: "pipe" });
          }
          return push(...items);
        };
        const origRefused = run.refused.push.bind(run.refused);
        run.refused.push = (...items) => {
          for (const it of items) asked.push(`refused:${it.tool}`);
          return origRefused(...items);
        };
        return fakeClaudeCode([steps], run).queryFn(args);
      };
    const h = await harness({ queryFn: executing });
    const started = (await h.command({
      type: "coord.start",
      workspaceLabel: "proj",
      goalCt: await h.goal("add the feature"),
    })) as { sid: string };
    await waitFor(async () => (await h.planOf(started.sid))?.status === "awaiting_approval");
    const { planId } = (await h.planOf(started.sid))!;
    expect(
      await h.command(
        { type: "coord.approve", planId, digest: await planDigest((await h.planOf(started.sid))!, "approve") },
        { stepUp: true },
      ),
    ).toMatchObject({ ok: true });

    // The helper's write, add and commit were answered by Chalito; the push to main reaches the phone.
    await waitFor(() => h.store.pendingApprovals().length === 1);
    // Security review: the helper's workspace label rides inside what the agent signed.
    expect(await h.pendingDetails()).toMatchObject({ workspaceLabel: "proj", toolName: "Bash" });
    const auto = h.store.audits.filter((a) => a.type === "coordinator.auto_allow").map((a) => a.meta.kind);
    expect(auto).toEqual(["workspace_edit", "git_local", "git_local"]);
    await h.decide(false);
    await waitFor(() => asked.includes("refused:Bash"));

    await waitFor(async () => (await h.planOf(started.sid))!.status === "ready_to_merge", 20_000);
    expect(existsSync(join(h.root, "feature.ts"))).toBe(false);
    expect(
      await h.command(
        { type: "coord.merge", planId, digest: await planDigest((await h.planOf(started.sid))!, "merge") },
        { stepUp: true },
      ),
    ).toMatchObject({ ok: true });
    expect((await h.planOf(started.sid))!.status).toBe("merged");
    expect(readFileSync(join(h.root, "feature.ts"), "utf8")).toContain("feature = 1");
    expect(sh(h.root, "log", "--oneline", "-3")).toMatch(/feat: feature/);
  });

  it("security review: an ended helper keeps its identity (no computer control, its worktree) but isn't answered for", async () => {
    let lastCwd = "";
    const turns: FakeStep[][] = [
      [{ say: "ready" }],
      [
        { tool: "Bash", input: { command: "pnpm add zod" } },
        { tool: `${COMPUTER_TOOL_PREFIX}screenshot`, input: {} },
        { say: "done" },
      ],
    ];
    const run: FakeRun = { ran: [], refused: [], modes: [], interrupted: 0 };
    const fake = fakeClaudeCode(turns, run);
    const h = await harness({
      queryFn: () => (args) => {
        lastCwd = String(args.options.cwd);
        return fake.queryFn(args);
      },
    });
    const dir = join(h.root, ".chalito-coord", "pabcdefgh", "a");
    sh(h.root, "worktree", "add", "-q", "-b", "coord/pabcdefgh/a", dir);
    const host = (
      h.core as unknown as {
        coordinator: {
          d: {
            host: {
              startSession: (i: object) => Promise<unknown>;
              prompt: (sid: string, text: string, origin: string) => Promise<void>;
              endHelper: (sid: string) => void;
            };
          };
        };
      }
    ).coordinator.d.host;
    const sid = "22222222-2222-4222-8222-222222222222";
    const origin = "agent:coord_pabcdefgh";
    expect(
      await host.startSession({
        sid,
        appId: "claude-code",
        cwd: dir,
        workspaceLabel: "proj",
        prompt: "go",
        origin,
        permissionMode: "default",
        coord: { planId: "pabcdefgh", taskId: "a", branchPrefix: "coord/pabcdefgh/", active: () => true },
      }),
    ).toEqual({ ok: true });
    await waitFor(() => (h.store.sessions.get(sid) as { state?: string } | undefined)?.state === "idle");
    host.endHelper(sid);

    // Not answered for any more: the install reaches the phone.
    await host.prompt(sid, "next", origin);
    await waitFor(() => h.store.pendingApprovals().length === 1);
    expect(h.store.audits.filter((a) => a.type === "coordinator.auto_allow")).toHaveLength(0);
    await h.decide(false);
    // Still a helper: computer control is refused as one.
    await waitFor(() => run.refused.some((r) => r.tool.startsWith(COMPUTER_TOOL_PREFIX)));
    expect(run.refused.find((r) => r.tool.startsWith(COMPUTER_TOOL_PREFIX))!.reason).toMatch(/coordinator_no_computer/);

    // And it comes back in its own worktree after a restart.
    await h.core.suspendAll();
    lastCwd = "";
    await host.prompt(sid, "again", origin);
    await waitFor(() => lastCwd !== "");
    expect(lastCwd).toBe(dir);
  });

  it("security review: a helper never starts above this computer's permission ceiling", async () => {
    const h = await harness();
    const started = (await h.command({ type: "coord.start", workspaceLabel: "proj", goalCt: await h.goal("x") })) as {
      sid: string;
    };
    await waitFor(async () => (await h.planOf(started.sid))?.status === "awaiting_approval");
    const { planId } = (await h.planOf(started.sid))!;
    h.setPolicy({ remote: { maxPermissionMode: "plan", maxCodexSandbox: "read-only" } });
    expect(
      await h.command(
        { type: "coord.approve", planId, digest: await planDigest((await h.planOf(started.sid))!, "approve") },
        { stepUp: true },
      ),
    ).toEqual({
      ok: false,
      reason: "permission_mode_above_ceiling",
    });
    // And the host itself refuses, whatever the coordinator asks for.
    const host = (
      h.core as unknown as { coordinator: { d: { host: { startSession: (i: object) => Promise<unknown> } } } }
    ).coordinator.d.host;
    expect(
      await host.startSession({
        sid: "11111111-1111-4111-8111-111111111111",
        appId: "claude-code",
        cwd: h.root,
        workspaceLabel: "proj",
        prompt: "x",
        origin: "agent:coord_pabcdefgh",
        permissionMode: "default",
        coord: { planId: "pabcdefgh", taskId: "a", branchPrefix: "coord/pabcdefgh/", active: () => true },
      }),
    ).toEqual({ ok: false, reason: "permission_mode_above_ceiling" });
  });
});
