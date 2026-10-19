/**
 * G4: a plan on computer A with helpers on computer B (ADR 0025 §6). Two coordinators over two
 * clones of one bare `origin`, all REAL git; the hand-off link is played by delivering the signed
 * task straight to B's coordinator (the link's own relay, signature and authorization are tested
 * in links.test.ts). B runs its task in its own worktree, pushes the plan's branch; A fetches it,
 * checks it's the reported commit, reviews and integrates.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AdapterEvent } from "@chalito/adapters";
import type { CoordPlanState, CoordRemoteResult, RemotePermissionMode } from "@chalito/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SessionCoord } from "../src/agent-core.js";
import { Coordinator, nodeGit, planDigest, type CoordHost } from "../src/coord/coordinator.js";

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

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const waitFor = async (cond: () => boolean, ms = 20_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A bare origin with `main`, and two clones (computer A and computer B). */
const repos = () => {
  const origin = mkdtempSync(join(tmpdir(), "coord-origin-"));
  sh(origin, "init", "-q", "--bare", "-b", "main");
  const a = mkdtempSync(join(tmpdir(), "coord-a-"));
  sh(a, "clone", "-q", origin, ".");
  sh(a, "checkout", "-q", "-b", "main");
  writeFileSync(join(a, "README.md"), "hola\n");
  sh(a, "add", "-A");
  sh(a, "commit", "-q", "-m", "init");
  sh(a, "push", "-q", "origin", "main");
  const b = mkdtempSync(join(tmpdir(), "coord-b-"));
  sh(b, "clone", "-q", origin, ".");
  return { origin, a, b };
};

type Script = (s: { cwd: string; taskId: string; mode: RemotePermissionMode; turn: number }) => string;

/** A host for one computer; sessions follow `script` (side effects first, then the reply). */
const host = (deviceId: string, root: string, script: Script) => {
  const observers = new Map<string, (e: AdapterEvent) => void>();
  const sessions = new Map<
    string,
    { cwd: string; taskId: string; mode: RemotePermissionMode; turn: number; coord: SessionCoord; prompts: string[] }
  >();
  const published: CoordPlanState[] = [];
  const interrupted: string[] = [];
  let onResult: (taskId: string, r: CoordRemoteResult | null) => boolean = () => false;
  const state = {
    coordinatorOn: true,
    link: true as boolean,
    deliver: null as null | ((task: unknown) => Promise<CoordRemoteResult>),
  };
  const reply = (sid: string) => {
    const s = sessions.get(sid)!;
    const turn = s.turn++;
    setTimeout(() => {
      if (interrupted.includes(sid)) return;
      const text = script({ cwd: s.cwd, taskId: s.taskId, mode: s.mode, turn });
      observers.get(sid)?.({ type: "assistant_text", text } as AdapterEvent);
      observers.get(sid)?.({ type: "state", state: "idle" } as AdapterEvent);
    }, 1);
  };
  const h: CoordHost = {
    workspace: (label) => (label === "proj" ? { label, path: root } : undefined),
    helpersAllowed: () => true,
    startSession: async (i) => {
      sessions.set(i.sid, {
        cwd: i.cwd,
        taskId: i.coord.taskId,
        mode: i.permissionMode,
        turn: 0,
        coord: i.coord,
        prompts: [i.prompt],
      });
      reply(i.sid);
      return { ok: true };
    },
    prompt: async (sid, text) => {
      sessions.get(sid)?.prompts.push(text);
      reply(sid);
    },
    interrupt: async (sid) => {
      interrupted.push(sid);
      observers.get(sid)?.({ type: "state", state: "interrupted" } as AdapterEvent);
    },
    observe: (sid, fn) => {
      observers.set(sid, fn);
      return () => observers.delete(sid);
    },
    publish: async (_sid, s) => void published.push(structuredClone(s)),
    endHelper: () => undefined,
    deviceId: () => deviceId,
    coordinatorOn: () => state.coordinatorOn,
    linkTo: (dev) => (state.link && dev === "dev_b" ? { linkId: "lnk_a_to_b_0001" } : null),
    sendCoordTask: async (_linkId, _fromSid, task) => {
      const taskId = randomUUID();
      void state.deliver!(task).then((r) => onResult(taskId, r));
      return { ok: true, taskId };
    },
    onCoordResult: (fn) => void (onResult = fn),
  };
  return { h, sessions, published, interrupted, state, last: () => published.at(-1)! };
};

const make = (deviceId: string, root: string, script: Script) => {
  const hh = host(deviceId, root, script);
  const c = new Coordinator({
    host: hh.h,
    git: nodeGit(),
    now: Date.now,
    audit: () => undefined,
    log: () => undefined,
    setTimer: () => ({ clear: () => undefined }),
  });
  return { c, ...hh };
};

const PLAN = (ids: string[]) =>
  "```json\n" +
  JSON.stringify({
    tasks: ids.map((id) => ({ id, title: id, brief: `do ${id}`, acceptance: [`${id} ok`], files: [`${id}.ts`] })),
  }) +
  "\n```";

/** A helper that writes `<task>.ts` and commits it (its first turn), then just says DONE. */
const helper = (s: { cwd: string; taskId: string; turn: number }, extra = "") => {
  if (s.turn === 0 || extra) {
    writeFileSync(join(s.cwd, `${s.taskId}.ts`), `export const ${s.taskId} = ${JSON.stringify(extra || "v1")};\n`);
    sh(s.cwd, "add", "-A");
    sh(s.cwd, "commit", "-q", "-m", `feat: ${s.taskId}`);
  }
  return `DONE: ${s.taskId}`;
};

/** A + B, wired: A's tasks for B go straight to B's coordinator. */
const pair = (scripts: { a: Script; b: Script }) => {
  const { origin, a, b } = repos();
  const A = make("dev_a", a, scripts.a);
  const B = make("dev_b", b, scripts.b);
  A.state.deliver = (task) =>
    B.c.runRemote({
      sid: randomUUID(),
      workspaceLabel: "proj",
      appId: undefined,
      ceiling: "default",
      task: task as never,
    });
  return { origin, a, b, A, B };
};

const aScript =
  (review: (s: { taskId: string; turn: number }) => string = () => "APPROVE"): Script =>
  (s) => {
    if (s.taskId === "planner") return PLAN(["one", "two"]);
    if (s.taskId === "integration") {
      // The coordinator merged cleanly already (disjoint files).
      return "INTEGRATION PASS";
    }
    if (s.mode === "plan") return review(s);
    return helper(s);
  };

const startAndApprove = async (A: ReturnType<typeof make>, helpers = ["dev_b"]) => {
  const r = await A.c.start({
    goal: "two things",
    workspaceLabel: "proj",
    appId: "claude-code",
    maxAgents: 3,
    maxMinutes: 60,
    helpers,
  });
  expect(r).toMatchObject({ ok: true });
  const planId = (r as { planId: string }).planId;
  await waitFor(() => A.last().status === "awaiting_approval");
  return { planId, approve: async () => A.c.approve(planId, await planDigest(A.last(), "approve")) };
};

describe("G4: helpers on the owner's other computers", () => {
  it("B does its task in its own worktree and pushes the plan's branch; A fetches, reviews, integrates and merges", async () => {
    const { origin, a, b, A, B } = pair({ a: aScript(), b: (s) => helper(s) });
    const { planId, approve } = await startAndApprove(A);
    // Which computer runs what is shown before the tap (and part of its digest).
    expect(A.last().tasks.map((t) => [t.id, t.deviceId])).toEqual([
      ["one", "dev_a"],
      ["two", "dev_b"],
    ]);
    expect(await approve()).toMatchObject({ ok: true });
    await waitFor(() => A.last().status === "ready_to_merge");
    // B worked in a worktree of its own copy, as a helper of this plan, and pushed exactly its branch.
    const bs = [...B.sessions.values()];
    expect(bs.map((s) => s.cwd)).toEqual([join(b, ".chalito-coord", planId, "two")]);
    expect(bs[0]!.coord).toMatchObject({ planId, branchPrefix: `coord/${planId}/` });
    expect(sh(origin, "branch", "--list", `coord/${planId}/*`)).toContain(`coord/${planId}/two`);
    expect(sh(origin, "branch", "--list", `coord/${planId}/one`)).toBe("");
    // A reviewed B's work in a read-only copy at the reported commit.
    const reviewer = [...A.sessions.values()].find((s) => s.mode === "plan" && s.taskId === "two-review")!;
    expect(reviewer.cwd).toBe(join(a, ".chalito-coord", planId, "two"));
    await A.c.merge(planId, await planDigest(A.last(), "merge"));
    expect(A.last().status).toBe("merged");
    expect(readFileSync(join(a, "two.ts"), "utf8")).toContain("v1");
    expect(sh(origin, "show", "main:two.ts")).toContain("v1");
  });

  it("review findings go back to B as a revision; B's next commit is fetched and approved", async () => {
    let reviews = 0;
    const { A, B } = pair({
      a: aScript((s) => (s.taskId === "two-review" && ++reviews === 1 ? "CHANGES: make it v2" : "APPROVE")),
      b: (s) => (s.turn === 0 ? helper(s) : helper(s, "v2")),
    });
    const { approve } = await startAndApprove(A);
    await approve();
    await waitFor(() => A.last().status === "ready_to_merge" || A.last().status === "failed");
    expect(A.last().status).toBe("ready_to_merge");
    const bSession = [...B.sessions.values()][0]!;
    expect(bSession.prompts.some((p) => p.includes("make it v2"))).toBe(true);
    expect(A.last().tasks.find((t) => t.id === "two")!.reviewRounds).toBeGreaterThanOrEqual(1);
  });

  it("with coordinator mode off on B, B refuses and A's task fails (nothing runs on B)", async () => {
    const { A, B } = pair({ a: aScript(), b: (s) => helper(s) });
    B.state.coordinatorOn = false;
    const { approve } = await startAndApprove(A);
    await approve();
    await waitFor(() => A.last().status === "failed");
    expect(A.last().tasks.find((t) => t.id === "two")!.note).toMatch(/modo coordinador/);
    expect(B.sessions.size).toBe(0);
  });

  it("a plan can't name a helper computer it has no link to", async () => {
    const { A } = pair({ a: aScript(), b: (s) => helper(s) });
    A.state.link = false;
    expect(
      await A.c.start({
        goal: "x",
        workspaceLabel: "proj",
        appId: "claude-code",
        maxAgents: 2,
        maxMinutes: 30,
        helpers: ["dev_b"],
      }),
    ).toEqual({ ok: false, reason: "no_link" });
  });

  it("B starts only from a base that's on origin", async () => {
    const { a, A, B } = pair({ a: aScript(), b: (s) => helper(s) });
    // A commits on main without pushing: B can't start from it.
    writeFileSync(join(a, "local.txt"), "x\n");
    sh(a, "add", "-A");
    sh(a, "commit", "-q", "-m", "local only");
    const { approve } = await startAndApprove(A);
    await approve();
    await waitFor(() => A.last().status === "failed");
    expect(A.last().tasks.find((t) => t.id === "two")!.note).toMatch(/origin/);
    expect(B.sessions.size).toBe(0);
  });

  it("A refuses a branch that isn't the commit B reported", async () => {
    const { A } = pair({ a: aScript(), b: (s) => helper(s) });
    const deliver = A.state.deliver!;
    A.state.deliver = async (task) => ({ ...(await deliver(task)), head: "f".repeat(40) });
    const { approve } = await startAndApprove(A);
    await approve();
    await waitFor(() => A.last().status === "failed");
    expect(A.last().tasks.find((t) => t.id === "two")!.note).toMatch(/no es la que informó/);
  });

  it("the kill switch reaches B: its helper is interrupted", async () => {
    const { A, B } = pair({ a: aScript(), b: () => "" });
    const { planId, approve } = await startAndApprove(A);
    await approve();
    await waitFor(() => B.sessions.size === 1);
    await A.c.stop(planId);
    await waitFor(() => B.interrupted.length > 0);
    expect(A.last().status).toBe("stopped");
    expect([...B.sessions.values()][0]!.coord.active()).toBe(false);
    // The worktree on B stays for inspection.
    expect(existsSync([...B.sessions.values()][0]!.cwd)).toBe(true);
  });
});
