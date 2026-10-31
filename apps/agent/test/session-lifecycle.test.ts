import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManagedSessionAdapter, type SessionAdapter } from "@chalito/adapters";
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
import { SupabaseError } from "../src/supabase-store.js";

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
    /** Timers still armed (not fired, not cleared). */
    armed: () => timers.filter((t) => !t.dead).length,
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
    /** Wraps the Claude Code adapter (e.g. in a ManagedSessionAdapter). */
    wrap?: (a: SessionAdapter) => SessionAdapter;
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
    adapters: {
      "claude-code": (o.wrap ?? ((a) => a))(
        new ClaudeCodeAdapter({ apiKey: "sk-ant-test", queryFn: fake.queryFn, env: {} }),
      ),
    },
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
  const interrupt = (sid: string) => command(async () => ({ type: "session.interrupt", sid }));
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
    interrupt,
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

/**
 * The account revoked this computer: from then on the database refuses its writes by RLS (42501),
 * as Supabase does once the revoke sweep runs (seen in the beta rehearsal, "agent_revoked").
 */
class RevokingStore extends MemoryStore {
  revoked = false;
  /** Only the card write is refused (the state write just before it went through, as in CI). */
  refuseCardsOnly = false;
  refused: string[] = [];
  #refuse(op: string) {
    this.refused.push(op);
    return new SupabaseError(op, "42501", 'new row violates row-level security policy for table "sessions"');
  }
  override async upsertSession(sid: string, data: Record<string, unknown>) {
    if (this.revoked && (!this.refuseCardsOnly || "card" in data)) throw this.#refuse("merge session");
    return super.upsertSession(sid, data);
  }
  override async writeEvent(e: AgentEvent) {
    if (this.revoked && !this.refuseCardsOnly) throw this.#refuse("insert event");
    return super.writeEvent(e);
  }
  override async resolveApproval(...a: Parameters<MemoryStore["resolveApproval"]>) {
    if (this.revoked) throw this.#refuse("resolve approval");
    return super.resolveApproval(...a);
  }
}

describe("an agent revoked mid-approval (beta rehearsal f)", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => void unhandled.push(err);
  const pendingApproval = async () => {
    const store = new RevokingStore();
    const h = await harness({ store, turns: [[{ tool: "Bash", input: { command: "git push origin main" } }]] });
    const r = await h.start();
    if (!r.ok) throw new Error(JSON.stringify(r));
    await waitFor(() => store.pendingApprovals().length === 1);
    return { h, store, sid: r.sid! };
  };
  const settle = () => new Promise((r) => setTimeout(r, 30));

  it("an adapter event after the revoke publishes nothing more, and nothing goes unhandled", async () => {
    process.on("unhandledRejection", onUnhandled);
    try {
      const store = new RevokingStore();
      const h = await harness({ store, turns: [[{ say: "uno" }], [{ say: "dos" }]] });
      const sid = (await h.start()).sid!;
      await waitFor(() => h.states(sid).includes("idle"));
      await settle();
      // The phone revokes this computer; the next turn's "running" state is the first write after.
      store.revoked = true;
      await h.prompt(sid, "sigue");
      await waitFor(() => h.core.revoked);
      await settle();
      expect(unhandled).toEqual([]);
      expect(store.refused.length).toBeGreaterThan(0);
      expect(h.logs.some((l) => l.includes('"agent.revoked"'))).toBe(true);
      // Stopped: the session is closed (resumable) and no timer is left to fire.
      expect(h.core.sessions.size).toBe(0);
      expect(h.clock.armed()).toBe(0);
      const refused = store.refused.length;
      h.clock.advance(60 * MIN);
      await settle();
      expect(store.refused.length).toBe(refused);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a card refused after the revoke (state written, card not) is handled the same way", async () => {
    process.on("unhandledRejection", onUnhandled);
    try {
      const store = new RevokingStore();
      store.refuseCardsOnly = true;
      const h = await harness({ store, turns: [[{ say: "uno" }], [{ say: "dos" }]] });
      const sid = (await h.start()).sid!;
      await waitFor(() => h.states(sid).includes("idle"));
      await settle();
      store.revoked = true;
      await h.prompt(sid, "sigue");
      await waitFor(() => h.core.revoked);
      await settle();
      expect(unhandled).toEqual([]);
      expect(store.refused).toContain("merge session");
      expect(h.core.sessions.size).toBe(0);
      expect(h.clock.armed()).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a revoke first seen when the approval times out ends it as agent_revoked, unhandled-free", async () => {
    process.on("unhandledRejection", onUnhandled);
    try {
      const { h, store } = await pendingApproval();
      store.revoked = true;
      h.clock.advance(10 * MIN + 1_000);
      await waitFor(() => h.core.revoked);
      await settle();
      expect(unhandled).toEqual([]);
      expect(h.core.sessions.size).toBe(0);
      expect(h.clock.armed()).toBe(0);
      // A later approval is denied without a write.
      expect(
        await h.core.approvals.request({
          sid: "s",
          risk: "HIGH",
          stepUp: false,
          origin: "local:tty",
          details: { toolName: "Bash", input: {}, reasons: [] },
        }),
      ).toEqual({ allow: false, reason: "agent_revoked" });
      expect(store.pendingApprovals()).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("IA de Chalyb blocked (ADR 0030)", () => {
  it("a session refused for tokens after its turn gets session.blocked {out_of_energy}, once", async () => {
    let checks = 0;
    const h = await harness({
      turns: [[{ say: "Listo." }], [{ say: "Otra." }]],
      wrap: (inner) =>
        new ManagedSessionAdapter("claude-code", {
          source: {
            issue: async (sid) => ({ id: `cc_${sid}`, token: "chc_x", baseUrl: "https://ai.test", model: "m" }),
            status: async () => ({ state: "active", blockedReason: ++checks >= 1 ? "out_of_energy" : null }),
            end: async () => undefined,
          },
          make: () => inner,
        }),
    });
    const r = await h.start();
    if (!r.ok) throw new Error(JSON.stringify(r));
    await waitFor(() => h.store.events.some((e) => e.type === "session.blocked"));
    const blocked = h.store.events.filter((e) => e.type === "session.blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ sid: r.sid, reason: "out_of_energy", urgency: "normal" });
  });
});

describe("IA de Chalyb credential expiry (ADR 0030)", () => {
  it("after an idle-expired credential ends the CLI, the next prompt restarts it on a fresh credential", async () => {
    const issued: string[] = [];
    let state: "active" | "expired" = "expired";
    const h = await harness({
      turns: [[{ say: "Listo." }], [{ say: "Otra vez." }]],
      wrap: (inner) =>
        new ManagedSessionAdapter("claude-code", {
          source: {
            issue: async (sid) => {
              issued.push(sid);
              return { id: `cc_${issued.length}`, token: "chc_x", baseUrl: "https://ai.test", model: "m" };
            },
            status: async () => ({ state, blockedReason: null }),
            end: async () => undefined,
          },
          make: () => inner,
        }),
    });
    const r = await h.start();
    if (!r.ok) throw new Error(JSON.stringify(r));
    await waitFor(() => h.states(r.sid!).includes("idle"));
    // The credential expired: the CLI is ended, and the session waits, resumable.
    expect(issued).toHaveLength(1);
    state = "active";
    await new Promise((res) => setTimeout(res, 50));
    const p = await h.prompt(r.sid!, "sigue");
    if (!p.ok) throw new Error(JSON.stringify(p));
    await waitFor(() => issued.length === 2);
    await waitFor(() => h.store.events.filter((e) => e.type === "message.assistant").length === 2);
  });
});

describe("stuck and stall alerts (from Alux, by Omar)", () => {
  const failing = (n: number) =>
    Array.from({ length: n }, () => ({ tool: "Bash", input: { command: "pnpm test" }, fail: true }));
  const alerts = (h: Awaited<ReturnType<typeof harness>>, sid: string) =>
    h.store.events.filter(
      (e): e is Extract<AgentEvent, { type: "agent.alert" }> => e.sid === sid && e.type === "agent.alert",
    );

  it("the same command failing 5 times in a turn writes one sealed stuck alert for that turn", async () => {
    const h = await harness({ turns: [[...failing(7), { say: "sigo intentando" }], [...failing(5)]] });
    const sid = (await h.start()).sid!;
    await waitFor(() => h.states(sid).includes("idle"));
    await waitFor(() => alerts(h, sid).length === 1);
    const [a] = alerts(h, sid);
    const turnStart = h.store.events.find(
      (e) => e.sid === sid && e.type === "session.state" && e.state === "running",
    )!.t;
    expect(a).toMatchObject({ kind: "stuck", count: 5, turn: turnStart, urgency: "normal" });
    // The command is sealed to the person's devices: only their device opens it.
    expect(await h.open(a as never)).toEqual({ cmd: "pnpm test" });
    expect(JSON.stringify(a)).not.toContain("pnpm test");
    // A new turn that goes in circles again alerts again, once, keyed on its own start.
    h.clock.advance(MIN);
    await h.prompt(sid, "otra vez");
    await waitFor(() => h.states(sid).filter((s) => s === "idle").length === 2);
    await waitFor(() => alerts(h, sid).length === 2);
    expect(alerts(h, sid)[1]!.turn).toBeGreaterThan(turnStart);
  });

  it("four failures stay quiet", async () => {
    const h = await harness({ turns: [[...failing(4), { say: "listo" }]] });
    const sid = (await h.start()).sid!;
    await waitFor(() => h.states(sid).includes("idle"));
    // Sealing is async: give a wrong alert time to land before checking there is none.
    await waitFor(() => h.store.events.some((e) => e.sid === sid && e.type === "message.assistant"));
    await new Promise((r) => setTimeout(r, 50));
    expect(alerts(h, sid)).toEqual([]);
  });

  it("an open question is the person's turn: 25 quiet minutes waiting on it never stall", async () => {
    const ask = { questions: [{ question: "¿Hago push?", options: [{ label: "Sí" }] }] };
    const h = await harness({ turns: [[{ tool: "AskUserQuestion", input: ask }, { say: "listo" }]] });
    const sid = (await h.start()).sid!;
    await waitFor(() => h.store.events.some((e) => e.sid === sid && e.type === "question.asked"));
    h.clock.advance(25 * MIN);
    await new Promise((r) => setTimeout(r, 50));
    expect(alerts(h, sid)).toEqual([]);
  });

  it("a question abandoned by an interrupt doesn't switch stall detection off for the session", async () => {
    let resume!: () => void;
    const pause = new Promise<void>((r) => (resume = r));
    const ask = { questions: [{ question: "¿Hago push?", options: [{ label: "Sí" }] }] };
    const h = await harness({
      turns: [
        [{ tool: "AskUserQuestion", input: ask }, { say: "listo" }],
        [{ say: "sigo" }, { pause }, { say: "ya" }],
      ],
    });
    const sid = (await h.start()).sid!;
    await waitFor(() => h.store.events.some((e) => e.sid === sid && e.type === "question.asked"));
    await h.interrupt(sid);
    await waitFor(() => h.states(sid).includes("idle"));
    h.clock.advance(MIN);
    await h.prompt(sid, "sigue");
    await waitFor(() => h.store.events.some((e) => e.sid === sid && e.type === "message.assistant"));
    h.clock.advance(20 * MIN);
    await waitFor(() => alerts(h, sid).length === 1);
    expect(alerts(h, sid)[0]).toMatchObject({ kind: "stalled" });
    resume();
  });

  it("a running turn with no output for 20 minutes writes one stalled alert", async () => {
    let resume!: () => void;
    const pause = new Promise<void>((r) => (resume = r));
    const h = await harness({ turns: [[{ say: "empiezo" }, { pause }, { say: "listo" }]] });
    const sid = (await h.start()).sid!;
    await waitFor(() => h.store.events.some((e) => e.sid === sid && e.type === "message.assistant"));
    h.clock.advance(19 * MIN);
    expect(alerts(h, sid)).toEqual([]);
    h.clock.advance(1 * MIN);
    await waitFor(() => alerts(h, sid).length === 1);
    expect(alerts(h, sid)[0]).toMatchObject({ kind: "stalled", urgency: "low" });
    expect((alerts(h, sid)[0] as { ct?: unknown }).ct).toBeUndefined();
    h.clock.advance(60 * MIN);
    resume();
    await waitFor(() => h.states(sid).includes("idle"));
    expect(alerts(h, sid)).toHaveLength(1);
  });
});
