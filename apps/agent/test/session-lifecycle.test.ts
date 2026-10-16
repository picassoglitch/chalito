import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "@chalito/adapters/claude-code";
import { fakeClaudeCode, type FakeStep } from "@chalito/adapters/testing";
import { SESSIONS_DEFAULTS, loadLiabilityText } from "@chalito/config";
import {
  MemoryNonceStore,
  TrustedClientList,
  generateBoxKeyPair,
  generateSigningKeyPair,
  openJson,
  randomNonce,
  sealJson,
  signEnvelope,
  toB64url,
} from "@chalito/crypto";
import type { AgentEvent, CommandPayload } from "@chalito/protocol";
import { AgentCore, type PolicyHolder } from "../src/agent-core.js";
import { DevMode, DevModeStore } from "../src/devmode.js";
import { DeltaThrottle } from "../src/live/deltas.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy/index.js";
import { createLogger } from "../src/redact.js";
import { FileSessionRegistry, MemorySessionRegistry } from "../src/session-registry.js";
import { MemoryStore } from "../src/store.js";

const OWNER = "hub-user-1";
const WS = "/home/aldo/code/chalito";
const MIN = 60_000;

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** Manual timers on a manual clock: `advance` fires whatever came due. */
const clock = () => {
  let now = Date.now();
  let timers: { at: number; fn: () => void; dead: boolean }[] = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, dead: false };
      timers.push(t);
      return { clear: () => void (t.dead = true) };
    },
    advance: (ms: number) => {
      now += ms;
      const due = timers.filter((t) => !t.dead && t.at <= now);
      timers = timers.filter((t) => !due.includes(t));
      for (const t of due) t.fn();
    },
  };
};

const device = async (id: string) => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  return { id, sign, box, pubSign: await toB64url(sign.publicKey), pubBox: await toB64url(box.publicKey) };
};

const harness = async (
  o: {
    turns?: FakeStep[][];
    registry?: MemorySessionRegistry;
    store?: MemoryStore;
    maxLive?: number;
    flushChars?: number;
    policy?: Partial<Policy>;
  } = {},
) => {
  const agent = await device("dev_agent");
  const phone = await device("dev_phone");
  const store = o.store ?? new MemoryStore();
  const trust = new TrustedClientList(agent.id);
  await trust.addConfirmed({ deviceId: phone.id, pubSign: phone.pubSign, pubBox: phone.pubBox }, Date.now());
  let policy: Policy = { ...DEFAULT_POLICY, workspaces: [{ label: "chalito", path: WS }], ...o.policy };
  const holder: PolicyHolder = { get: () => policy, set: async (p) => void (policy = p) };
  const liability = loadLiabilityText("es");
  const devMode = new DevMode({
    store: new DevModeStore(mkdtempSync(join(tmpdir(), "chalito-life-")), agent.sign, agent.id),
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
  const c = clock();
  const fake = fakeClaudeCode(o.turns ?? [[{ say: "Listo, ya quedó." }]]);
  const registry = o.registry ?? new MemorySessionRegistry();
  const logs: string[] = [];
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
    home: "/home/aldo",
    locale: () => "es",
    now: c.now,
    log: createLogger((l) => logs.push(l)),
    setTimer: c.setTimer,
    registry,
    sessionsConfig: {
      session: { ...SESSIONS_DEFAULTS.session, maxLivePerDevice: o.maxLive ?? 6 },
      live: { deltaFlushMs: 150, deltaFlushChars: o.flushChars ?? 512 },
    },
  });
  let n = 0;
  const command = async (payload: (cid: string) => Promise<unknown>) => {
    const cid = `c${++n}`;
    const body = {
      v: 1,
      cid,
      uid: OWNER,
      targetDeviceId: agent.id,
      origin: `client:${phone.id}`,
      nonce: await randomNonce(),
      issuedAt: c.now(),
      expiresAt: c.now() + 60_000,
      payload: await payload(cid),
    };
    const env = await signEnvelope("chalito.command.v1", body, phone.id, phone.sign.secretKey);
    return core.handleCommand(cid, { env, fromDeviceId: phone.id });
  };
  const sealed = (cid: string, v: unknown) => sealJson(v, { [agent.id]: agent.box.publicKey }, `command:${cid}`);
  const start = (prompt = "arregla el login") =>
    command(
      async (cid) =>
        ({
          type: "session.start",
          adapter: "claude-code",
          workspaceLabel: "chalito",
          promptCt: await sealed(cid, prompt),
          permissionMode: "default",
        }) satisfies CommandPayload,
    );
  const prompt = (sid: string, text: string) =>
    command(async (cid) => ({ type: "session.prompt", sid, promptCt: await sealed(cid, text) }));
  const resume = (sid: string, text?: string) =>
    command(async (cid) => ({ type: "session.resume", sid, ...(text ? { promptCt: await sealed(cid, text) } : {}) }));
  const states = (sid: string) =>
    store.events.flatMap((e) => (e.sid === sid && e.type === "session.state" ? [e.state] : []));
  const open = (e: AgentEvent) =>
    openJson<{ text: string }>((e as unknown as { ct: never }).ct, phone.id, phone.box, `event:${e.sid}`);
  return {
    core,
    store,
    fake,
    registry,
    clock: c,
    start,
    prompt,
    resume,
    states,
    open,
    logs,
    setPolicy: (p: Policy) => (policy = p),
  };
};

describe("partial streaming (M16 A)", () => {
  it("broadcasts throttled, sealed deltas and stores only the final message, tied by mid", async () => {
    const h = await harness({ flushChars: 4 });
    const r = await h.start();
    if (!r.ok) throw new Error(JSON.stringify(r) + h.logs.join("\n"));
    await waitFor(() => h.states(r.sid!).includes("idle"));
    await waitFor(() => h.store.events.some((e) => e.type === "message.assistant"));
    const final = h.store.events.find((e) => e.type === "message.assistant")!;
    await waitFor(() => h.store.live.length >= 2);
    const deltas = h.store.live as Extract<AgentEvent, { type: "message.assistant.delta" }>[];
    expect(deltas.every((d) => d.type === "message.assistant.delta")).toBe(true);
    expect(deltas.map((d) => d.n)).toEqual([0, 1]);
    // The pieces add up to the message; the final row names the draft and takes the seq the deltas carried.
    expect((await Promise.all(deltas.map(h.open))).map((x) => x.text).join("")).toBe("Listo, ya quedó.");
    expect(deltas.every((d) => d.mid === (final as { mid?: string }).mid && d.seq === final.seq)).toBe(true);
    expect((await h.open(final)).text).toBe("Listo, ya quedó.");
    expect(h.store.events.some((e) => e.type === "message.assistant.delta")).toBe(false);
    // Deltas don't use up seq numbers: the stored rows stay contiguous.
    const seqs = h.store.events.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });

  it("the throttle flushes at most every flushMs, or at once past flushChars", () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const out: string[] = [];
    const t = new DeltaThrottle({
      flushMs: 150,
      flushChars: 512,
      schedule: (fn, ms) => {
        const rec = { fn, ms };
        timers.push(rec);
        return { clear: () => void timers.splice(timers.indexOf(rec), 1) };
      },
      emit: (s) => out.push(s),
    });
    for (const piece of ["Ho", "la", " ", "mun", "do"]) t.push(piece);
    expect(out).toEqual([]);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(150);
    timers.shift()!.fn();
    expect(out).toEqual(["Hola mundo"]);
    t.push("x".repeat(600));
    expect(out.at(-1)).toHaveLength(600);
    t.push("tarde");
    t.discard();
    expect(timers).toHaveLength(0);
    expect(out).toHaveLength(2);
  });
});

describe("session lifecycle (M16 A)", () => {
  it("closes an idle session after session.idleTimeout, keeping its provider session id", async () => {
    const h = await harness();
    const r = await h.start();
    const sid = r.sid!;
    await waitFor(() => h.states(sid).includes("idle"));
    h.clock.advance(29 * MIN);
    expect(h.core.sessions.has(sid)).toBe(true);
    h.clock.advance(1 * MIN);
    expect(h.core.sessions.has(sid)).toBe(false);
    expect(h.core.dormantSessions()).toMatchObject([{ sid, providerSessionId: "fake-session-1", live: false }]);
    expect(h.registry.records).toMatchObject([{ sid, providerSessionId: "fake-session-1", state: "idle" }]);
    // The phone still sees an idle session (not "completed"), now without a process.
    await new Promise((r2) => setTimeout(r2, 20));
    expect(h.states(sid).at(-1)).toBe("idle");
    expect(h.store.sessions.get(sid)).toMatchObject({ state: "idle", live: false });
  });

  it("a busy session is never idle-closed", async () => {
    const h = await harness({ turns: [[{ tool: "Bash", input: { command: "sleep 100" } }]] });
    const r = await h.start();
    await waitFor(() => h.store.pendingApprovals().length === 1);
    h.clock.advance(60 * MIN);
    expect(h.core.sessions.has(r.sid!)).toBe(true);
  });

  it("a prompt for an idle-closed session resumes it in the same provider session", async () => {
    const h = await harness({ turns: [[{ say: "uno" }]] });
    const sid = (await h.start()).sid!;
    await waitFor(() => h.states(sid).includes("idle"));
    await waitFor(() => h.store.events.some((e) => e.type === "message.assistant"));
    h.clock.advance(31 * MIN);
    expect(h.core.sessions.has(sid)).toBe(false);
    const before = h.store.events.length;
    const r = await h.prompt(sid, "sigue");
    expect(r).toMatchObject({ ok: true, sid });
    expect(h.fake.run.resumed).toEqual([undefined, "fake-session-1"]);
    await waitFor(() => h.states(sid).filter((s) => s === "idle").length === 2);
    const after = h.store.events.slice(before);
    // The person's prompt is in the timeline, and the seq carries on.
    expect(after[0]).toMatchObject({ type: "message.user" });
    expect(after.map((e) => e.seq)[0]).toBe(before);
    expect(h.store.events.filter((e) => e.type === "session.started")).toHaveLength(1);
    expect(h.store.audits.map((a) => a.type)).toContain("session.resumed");
  });

  it("session.resume without a prompt reopens it idle and runs no turn", async () => {
    const h = await harness();
    const sid = (await h.start()).sid!;
    await waitFor(() => h.states(sid).includes("idle"));
    h.clock.advance(31 * MIN);
    expect(await h.resume(sid)).toMatchObject({ ok: true });
    expect(h.core.sessions.has(sid)).toBe(true);
    expect(h.fake.run.resumed).toEqual([undefined, "fake-session-1"]);
    expect(h.fake.run.turns).toBe(1);
  });

  it("after a restart, saved sessions resume lazily; one that was mid-turn is reported interrupted", async () => {
    const registry = new MemorySessionRegistry();
    const a = await harness({ registry, turns: [[{ tool: "Bash", input: { command: "sleep 100" } }]] });
    const sid = (await a.start()).sid!;
    await waitFor(() => a.store.pendingApprovals().length === 1);
    expect(registry.records).toMatchObject([
      { sid, state: "running", live: true, providerSessionId: "fake-session-1" },
    ]);
    // The agent dies (no clean shutdown). A new one starts with the same registry.
    const store = new MemoryStore();
    const b = await harness({ registry, store });
    expect(await b.core.restore()).toBe(1);
    expect(b.core.sessions.size).toBe(0);
    expect(b.fake.run.resumed ?? []).toEqual([]);
    expect(store.sessions.get(sid)).toMatchObject({ state: "interrupted", live: false });
    const savedSeq = registry.records[0]!.seq;
    expect(savedSeq).toBeGreaterThanOrEqual(1000);
    expect(await b.prompt(sid, "¿en qué ibas?")).toMatchObject({ ok: true, sid });
    expect(b.fake.run.resumed).toEqual(["fake-session-1"]);
    await waitFor(() => store.events.some((e) => e.type === "message.assistant"));
    expect(store.events[0]!.seq).toBe(savedSeq);
  });

  it("a clean shutdown keeps every session resumable", async () => {
    const h = await harness();
    const sid = (await h.start()).sid!;
    await waitFor(() => h.states(sid).includes("idle"));
    await h.core.suspendAll();
    expect(h.core.sessions.size).toBe(0);
    expect(h.registry.records).toMatchObject([{ sid, live: false, providerSessionId: "fake-session-1" }]);
  });

  it("caps live sessions: the longest-idle one makes room; when all are busy, session_limit", async () => {
    const h = await harness({
      maxLive: 1,
      turns: [[{ say: "hola" }], [{ tool: "Bash", input: { command: "sleep 100" } }]],
    });
    const a = (await h.start()).sid!;
    await waitFor(() => h.states(a).includes("idle"));
    // B's first turn is "hola" too (each query restarts the fake's script); its second blocks.
    const b = (await h.start()).sid!;
    expect(h.core.sessions.has(a)).toBe(false);
    expect(h.core.dormantSessions().map((d) => d.sid)).toEqual([a]);
    await waitFor(() => h.states(b).includes("idle"));
    await h.prompt(b, "corre algo");
    await waitFor(() => h.store.pendingApprovals().length === 1);
    expect(await h.start()).toMatchObject({ ok: false, reason: "session_limit" });
    expect(await h.prompt(a, "despierta")).toMatchObject({ ok: false, reason: "session_limit" });
    expect(h.store.audits.filter((x) => x.type === "command.rejected").map((x) => x.meta.reason)).toEqual([
      "session_limit",
      "session_limit",
    ]);
  });

  it("a resume re-checks the workspace in the local policy", async () => {
    const h = await harness();
    const sid = (await h.start()).sid!;
    await waitFor(() => h.states(sid).includes("idle"));
    h.clock.advance(31 * MIN);
    h.setPolicy({ ...DEFAULT_POLICY, workspaces: [] });
    expect(await h.prompt(sid, "sigue")).toMatchObject({ ok: false, reason: "unknown_workspace" });
    expect(h.fake.run.resumed).toEqual([undefined]);
  });

  it("the file registry round-trips, 0600, and ignores a corrupt file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chalito-reg-"));
    const reg = new FileSessionRegistry(dir);
    const rec = {
      sid: "s1",
      adapter: "codex" as const,
      workspaceLabel: "chalito",
      label: "chalito",
      permissionMode: "default" as const,
      startedBy: "client:dev_phone" as const,
      providerSessionId: "thr_1",
      seq: 12,
      state: "idle" as const,
      lastActiveAt: 1,
      live: false,
    };
    reg.save([rec]);
    expect(reg.load()).toEqual([rec]);
    const { statSync, writeFileSync } = await import("node:fs");
    if (process.platform !== "win32") expect(statSync(reg.file).mode & 0o777).toBe(0o600);
    writeFileSync(reg.file, "{nope");
    expect(reg.load()).toEqual([]);
  });
});
