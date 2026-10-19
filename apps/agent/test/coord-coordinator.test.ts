/**
 * The coordinator (ADR 0025 §1, §6; M17 G2) against REAL git repositories in temp folders, with a
 * scripted host standing in for the coding agents: helpers really commit in their worktrees, the
 * integration helper really merges, the merge tap really moves (and pushes) the base.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEvent } from "@chalito/adapters";
import type { CoordPlanState, Origin, RemotePermissionMode } from "@chalito/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Real git in temp folders: a plan runs dozens of git commands.
vi.setConfig({ testTimeout: 60_000 });
import type { SessionCoord } from "../src/agent-core.js";
import { Coordinator, extractJson, nodeGit, planDigest, validTasks, type CoordHost } from "../src/coord/coordinator.js";

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

/** A repo on `main` with one commit, and (optionally) a bare `origin`. */
const repo = (o: { origin?: boolean } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "coord-repo-"));
  sh(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, "README.md"), "hola\n");
  writeFileSync(join(root, "app.ts"), "export const a = 1;\n");
  sh(root, "add", "-A");
  sh(root, "commit", "-q", "-m", "init");
  let bare: string | null = null;
  if (o.origin) {
    bare = mkdtempSync(join(tmpdir(), "coord-origin-"));
    sh(bare, "init", "-q", "--bare", "-b", "main");
    sh(root, "remote", "add", "origin", bare);
    sh(root, "push", "-q", "origin", "main");
  }
  return { root, bare };
};

type Role = "planner" | "helper" | "review" | "integration";
interface Started {
  sid: string;
  role: Role;
  taskId: string;
  cwd: string;
  prompt: string;
  permissionMode: RemotePermissionMode;
  coord: SessionCoord;
  prompts: string[];
}

/**
 * A host whose sessions follow a script per role: `(s, turn) => reply text`. Replies are emitted
 * as the adapter would (assistant_text, then state idle) after the script's side effects.
 */
const host = (root: string, script: Partial<Record<Role, (s: Started, turn: number) => string>>) => {
  const observers = new Map<string, (e: AdapterEvent) => void>();
  const started: Started[] = [];
  const published: CoordPlanState[] = [];
  const interrupted: string[] = [];
  const ended: string[] = [];
  const turns = new Map<string, number>();
  const roleOf = (taskId: string, mode: RemotePermissionMode): Role =>
    taskId === "planner" ? "planner" : taskId === "integration" ? "integration" : mode === "plan" ? "review" : "helper";
  const reply = (s: Started) => {
    const n = turns.get(s.sid) ?? 0;
    turns.set(s.sid, n + 1);
    setTimeout(() => {
      if (interrupted.includes(s.sid)) return;
      const text = script[s.role]?.(s, n) ?? "";
      observers.get(s.sid)?.({ type: "assistant_text", text } as AdapterEvent);
      observers.get(s.sid)?.({ type: "state", state: "idle" } as AdapterEvent);
    }, 1);
  };
  const h: CoordHost = {
    workspace: (label) => (label === "proj" ? { label, path: root } : undefined),
    helpersAllowed: () => true,
    startSession: async (input) => {
      const s: Started = {
        sid: input.sid,
        role: roleOf(input.coord.taskId, input.permissionMode),
        taskId: input.coord.taskId,
        cwd: input.cwd,
        prompt: input.prompt,
        permissionMode: input.permissionMode,
        coord: input.coord,
        prompts: [input.prompt],
      };
      started.push(s);
      reply(s);
      return { ok: true };
    },
    prompt: async (sid, text) => {
      const s = started.find((x) => x.sid === sid)!;
      s.prompts.push(text);
      reply(s);
    },
    interrupt: async (sid) => {
      interrupted.push(sid);
      observers.get(sid)?.({ type: "state", state: "interrupted" } as AdapterEvent);
    },
    observe: (sid, fn) => {
      observers.set(sid, fn);
      return () => observers.delete(sid);
    },
    publish: async (_sid, state) => void published.push(structuredClone(state)),
    endHelper: (sid) => void ended.push(sid),
    deviceId: () => "dev_here",
    coordinatorOn: () => true,
    linkTo: () => null,
    sendCoordTask: async () => ({ ok: false, reason: "no_links_in_this_test" }),
    onCoordResult: () => undefined,
  };
  return { h, started, published, interrupted, ended };
};

const plan = (tasks: object[]) => "Here is the plan.\n```json\n" + JSON.stringify({ tasks }) + "\n```";
const task = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  brief: `Do ${id}`,
  acceptance: [`${id} works`],
  files: [`${id}.ts`],
  ...o,
});
/** A helper that writes `<task>.ts` and commits it. */
const commitHelper = (s: Started) => {
  writeFileSync(join(s.cwd, `${s.taskId}.ts`), `export const ${s.taskId.replace(/-/g, "_")} = true;\n`);
  sh(s.cwd, "add", "-A");
  sh(s.cwd, "commit", "-q", "-m", `feat: ${s.taskId}`);
  return `All good.\nDONE: added ${s.taskId}`;
};
/** The integration helper: merges whatever the prompt lists as pending, then passes. */
const integrator = (s: Started) => {
  const m = /in this order with git merge --no-ff[^:]*: ([^\n]+)\./.exec(s.prompt);
  for (const b of m ? m[1]!.split(", ") : []) {
    try {
      sh(s.cwd, "merge", "--no-ff", "--no-edit", b);
    } catch {
      // A conflict: keep both sides (the test files are line-disjoint except where noted).
      for (const f of sh(s.cwd, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean))
        writeFileSync(
          join(s.cwd, f),
          readFileSync(join(s.cwd, f), "utf8").replace(/^(<<<<<<<|=======|>>>>>>>).*\n/gm, ""),
        );
      sh(s.cwd, "add", "-A");
      sh(s.cwd, "commit", "-q", "--no-edit");
    }
  }
  return "Tests pass.\nINTEGRATION PASS";
};

const waitFor = async (cond: () => boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const make = (root: string, script: Parameters<typeof host>[1], o: { maxReviewRounds?: number } = {}) => {
  const hh = host(root, script);
  const timers: (() => void)[] = [];
  const audits: string[] = [];
  const c = new Coordinator({
    host: hh.h,
    git: nodeGit(),
    now: Date.now,
    audit: (t) => void audits.push(t),
    log: () => undefined,
    setTimer: (fn) => (timers.push(fn), { clear: () => undefined }),
    ...o,
  });
  const last = () => hh.published.at(-1)!;
  return { c, ...hh, timers, audits, last };
};

const start = (c: Coordinator, o: Partial<Parameters<Coordinator["start"]>[0]> = {}) =>
  c.start({ goal: "Add a and b", workspaceLabel: "proj", appId: "claude-code", maxAgents: 3, maxMinutes: 60, ...o });

describe("planner output", () => {
  it("reads the last JSON block and checks ids, dependencies and cycles", () => {
    expect(validTasks(extractJson(plan([task("a"), task("b", { dependsOn: ["a"] })])), 12)).toHaveLength(2);
    expect(validTasks(extractJson(plan([task("a"), task("a")])), 12)).toBeNull();
    expect(validTasks(extractJson(plan([task("a", { dependsOn: ["x"] })])), 12)).toBeNull();
    expect(
      validTasks(extractJson(plan([task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })])), 12),
    ).toBeNull();
    expect(validTasks(extractJson(plan([task("a"), task("b")])), 1)).toBeNull();
    expect(validTasks(extractJson("no json here"), 12)).toBeNull();
  });
});

describe("a plan from goal to merge (real git)", () => {
  it("plans, waits for the tap, runs helpers in worktrees, reviews, integrates, and merges + pushes on the tap", async () => {
    const { root, bare } = repo({ origin: true });
    const t = make(root, {
      planner: () => plan([task("a"), task("b")]),
      helper: commitHelper,
      review: () => "Looks right.\nAPPROVE",
      integration: integrator,
    });
    const r = await start(t.c);
    expect(r).toMatchObject({ ok: true, planId: expect.stringMatching(/^p[a-z0-9]{8}$/) });
    const planId = (r as { planId: string }).planId;
    await waitFor(() => t.last().status === "awaiting_approval");
    // The planner reads only; nothing ran yet.
    expect(t.started.map((s) => [s.role, s.permissionMode])).toEqual([["planner", "plan"]]);
    expect(t.last().tasks.map((x) => x.branch)).toEqual([`coord/${planId}/a`, `coord/${planId}/b`]);

    expect(await t.c.approve(planId, await planDigest(t.last(), "approve"))).toMatchObject({ ok: true });
    await waitFor(() => t.last().status === "ready_to_merge");
    // Helpers worked inside the workspace, each in its own worktree, as coordinator helpers.
    const helpers = t.started.filter((s) => s.role === "helper");
    // The two start concurrently: any order.
    expect(helpers.map((s) => s.cwd).sort()).toEqual([
      join(root, ".chalito-coord", planId, "a"),
      join(root, ".chalito-coord", planId, "b"),
    ]);
    expect(helpers.every((s) => s.coord.branchPrefix === `coord/${planId}/`)).toBe(true);
    // Waiting for the merge tap, nothing is answered for the owner any more.
    expect(helpers.every((s) => !s.coord.active())).toBe(true);
    expect(t.started.filter((s) => s.role === "review").every((s) => s.permissionMode === "plan")).toBe(true);
    // The main checkout is untouched until the tap, and the worktrees don't show in its status.
    expect(existsSync(join(root, "a.ts"))).toBe(false);
    expect(sh(root, "status", "--porcelain")).toBe("");

    expect(await t.c.merge(planId, await planDigest(t.last(), "merge"))).toMatchObject({ ok: true });
    expect(t.last().status).toBe("merged");
    expect(readFileSync(join(root, "a.ts"), "utf8")).toContain("a = true");
    expect(readFileSync(join(root, "b.ts"), "utf8")).toContain("b = true");
    expect(sh(bare!, "rev-parse", "main")).toBe(sh(root, "rev-parse", "main"));
    expect(t.last().note).toMatch(/origin/);
    // Nothing more runs once merged.
    expect(helpers[0]!.coord.active()).toBe(false);
  });

  it("never merges without the tap, and refuses the tap before the plan is ready", async () => {
    const { root } = repo();
    const t = make(root, { planner: () => plan([task("a")]) });
    const r = (await start(t.c)) as { planId: string };
    await waitFor(() => t.last().status === "awaiting_approval");
    expect(await t.c.merge(r.planId, await planDigest(t.last(), "merge"))).toEqual({
      ok: false,
      reason: "plan_not_ready",
    });
    expect(await t.c.approve("pnope0000", await planDigest(t.last(), "approve"))).toEqual({
      ok: false,
      reason: "unknown_plan",
    });
  });

  it("runs at most maxAgents helpers at once and a dependent task after (and on top of) what it needs", async () => {
    const { root } = repo();
    let live = 0;
    let peak = 0;
    const t = make(root, {
      planner: () => plan([task("a"), task("b"), task("c", { dependsOn: ["a"] })]),
      helper: (s) => {
        live++;
        peak = Math.max(peak, live);
        if (s.taskId === "c") expect(existsSync(join(s.cwd, "a.ts"))).toBe(true);
        const out = commitHelper(s);
        live--;
        return out;
      },
      review: () => "APPROVE",
      integration: integrator,
    });
    const r = (await start(t.c, { maxAgents: 1 })) as { planId: string };
    await waitFor(() => t.last().status === "awaiting_approval");
    await t.c.approve(r.planId, await planDigest(t.last(), "approve"));
    await waitFor(() => t.last().status === "ready_to_merge");
    expect(peak).toBe(1);
    const order = t.started.filter((s) => s.role === "helper").map((s) => s.taskId);
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("a"));
  });

  it("sends review findings back to the helper and approves on the next round", async () => {
    const { root } = repo();
    const t = make(root, {
      planner: () => plan([task("a")]),
      helper: (s, n) => (n === 0 ? commitHelper(s) : "DONE: fixed"),
      review: (_s) => (t.started.filter((x) => x.role === "review").length === 1 ? "CHANGES: add a test" : "APPROVE"),
      integration: integrator,
    });
    const r = (await start(t.c)) as { planId: string };
    await waitFor(() => t.last().status === "awaiting_approval");
    await t.c.approve(r.planId, await planDigest(t.last(), "approve"));
    await waitFor(() => t.last().status === "ready_to_merge");
    const helper = t.started.find((s) => s.role === "helper")!;
    expect(helper.prompts[1]).toMatch(/add a test/);
    expect(t.last().tasks[0]!.reviewRounds).toBe(1);
  });

  it("fails a task after the review rounds run out, and the plan with it", async () => {
    const { root } = repo();
    const t = make(
      root,
      {
        planner: () => plan([task("a")]),
        helper: (s, n) => (n === 0 ? commitHelper(s) : "DONE: tried"),
        review: () => "CHANGES: still wrong",
      },
      { maxReviewRounds: 1 },
    );
    const r = (await start(t.c)) as { planId: string };
    await waitFor(() => t.last().status === "awaiting_approval");
    await t.c.approve(r.planId, await planDigest(t.last(), "approve"));
    await waitFor(() => t.last().status === "failed");
    expect(t.last().tasks[0]!.status).toBe("failed");
  });

  it("blocks a deletion the task didn't list (ADR 0025 §3) before any review", async () => {
    const { root } = repo();
    const t = make(root, {
      planner: () => plan([task("a")]),
      helper: (s, n) => {
        if (n > 0) {
          sh(s.cwd, "checkout", "HEAD~1", "--", "README.md");
          sh(s.cwd, "commit", "-q", "-m", "restore");
          return "DONE: restored";
        }
        rmSync(join(s.cwd, "README.md"));
        return commitHelper(s);
      },
      review: () => "APPROVE",
      integration: integrator,
    });
    const r = (await start(t.c)) as { planId: string };
    await waitFor(() => t.last().status === "awaiting_approval");
    await t.c.approve(r.planId, await planDigest(t.last(), "approve"));
    await waitFor(() => t.last().status === "ready_to_merge");
    const helper = t.started.find((s) => s.role === "helper")!;
    expect(helper.prompts[1]).toMatch(/README\.md/);
  });

  it("security review: a rename hides no deletion (the source path counts as deleted)", async () => {
    const { root } = repo();
    const t = make(root, {
      planner: () => plan([task("a")]),
      helper: (s, n) => {
        if (n > 0) return "DONE: kept";
        sh(s.cwd, "mv", "README.md", "docs.md");
        return commitHelper(s);
      },
      review: () => "APPROVE",
      integration: integrator,
    });
    const r = (await start(t.c)) as { planId: string };
    await waitFor(() => t.last().status === "awaiting_approval");
    await t.c.approve(r.planId, await planDigest(t.last(), "approve"));
    await waitFor(() => (t.started.find((s) => s.role === "helper")?.prompts.length ?? 0) > 1);
    expect(t.started.find((s) => s.role === "helper")!.prompts[1]).toMatch(/README\.md/);
  });

  it("security review: approve checks the permission ceiling again", async () => {
    const { root } = repo();
    const t = make(root, { planner: () => plan([task("a")]) });
    const r = (await start(t.c)) as { planId: string };
    await waitFor(() => t.last().status === "awaiting_approval");
    t.h.helpersAllowed = () => false;
    expect(await t.c.approve(r.planId, await planDigest(t.last(), "approve"))).toEqual({
      ok: false,
      reason: "permission_mode_above_ceiling",
    });
    expect(t.last().status).toBe("awaiting_approval");
  });

  it("hands conflicting branches to the integration helper", async () => {
    const { root } = repo();
    const t = make(root, {
      planner: () => plan([task("a", { files: ["app.ts"] }), task("b", { files: ["app.ts"] })]),
      helper: (s) => {
        writeFileSync(join(s.cwd, "app.ts"), `export const a = 1;\nexport const ${s.taskId}2 = 2;\n`);
        sh(s.cwd, "commit", "-q", "-am", s.taskId);
        return "DONE: ok";
      },
      review: () => "APPROVE",
      integration: integrator,
    });
    const r = (await start(t.c)) as { planId: string };
    await waitFor(() => t.last().status === "awaiting_approval");
    await t.c.approve(r.planId, await planDigest(t.last(), "approve"));
    await waitFor(() => t.last().status === "ready_to_merge");
    const integ = t.started.find((s) => s.role === "integration")!;
    expect(integ.prompt).toMatch(new RegExp(`in this order with git merge --no-ff[^:]*: coord/${r.planId}/b`));
  });

  it("a failed integration leaves the plan failed, never ready", async () => {
    const { root } = repo();
    const t = make(root, {
      planner: () => plan([task("a")]),
      helper: commitHelper,
      review: () => "APPROVE",
      integration: () => "INTEGRATION FAIL: tests broke",
    });
    const r = (await start(t.c)) as { planId: string };
    await waitFor(() => t.last().status === "awaiting_approval");
    await t.c.approve(r.planId, await planDigest(t.last(), "approve"));
    await waitFor(() => t.last().status === "failed");
    expect(t.last().note).toMatch(/tests broke/);
  });

  it("an unreadable plan is asked for again once, then fails", async () => {
    const { root } = repo();
    const t = make(root, { planner: () => "I think we should do things." });
    await start(t.c);
    await waitFor(() => t.last().status === "failed");
    expect(t.started[0]!.prompts).toHaveLength(2);
  });
});

describe("the kill switch, the budget and the merge tap's checks", () => {
  it("stop interrupts every session of the plan and keeps the branches", async () => {
    const { root } = repo();
    const t = make(root, {
      planner: () => plan([task("a")]),
      helper: () => "", // never finishes its turn on its own (empty reply = idle with no DONE)
    });
    const r = (await start(t.c)) as { planId: string };
    await waitFor(() => t.last().status === "awaiting_approval");
    await t.c.approve(r.planId, await planDigest(t.last(), "approve"));
    await waitFor(() => t.started.some((s) => s.role === "helper"));
    expect(await t.c.stop(r.planId)).toMatchObject({ ok: true });
    expect(t.last().status).toBe("stopped");
    expect(t.interrupted).toContain(t.started.find((s) => s.role === "helper")!.sid);
    expect(sh(root, "branch", "--list", `coord/${r.planId}/a`)).toContain(`coord/${r.planId}/a`);
    expect(t.started.every((s) => !s.coord.active())).toBe(true);
    expect(await t.c.approve(r.planId, await planDigest(t.last(), "approve"))).toEqual({
      ok: false,
      reason: "plan_not_waiting",
    });
  });

  it("the budget stops the plan when it runs out", async () => {
    const { root } = repo();
    const t = make(root, { planner: () => plan([task("a")]), helper: () => "" });
    const r = (await start(t.c)) as { planId: string };
    await waitFor(() => t.last().status === "awaiting_approval");
    await t.c.approve(r.planId, await planDigest(t.last(), "approve"));
    t.timers.forEach((fire) => fire());
    await waitFor(() => t.last().status === "stopped");
    expect(t.last().note).toMatch(/tiempo/);
  });

  it("refuses the tap when the base moved or its checkout is dirty", async () => {
    const { root } = repo();
    const t = make(root, {
      planner: () => plan([task("a")]),
      helper: commitHelper,
      review: () => "APPROVE",
      integration: integrator,
    });
    const r = (await start(t.c)) as { planId: string };
    await waitFor(() => t.last().status === "awaiting_approval");
    await t.c.approve(r.planId, await planDigest(t.last(), "approve"));
    await waitFor(() => t.last().status === "ready_to_merge");
    writeFileSync(join(root, "app.ts"), "export const a = 99;\n");
    expect(await t.c.merge(r.planId, await planDigest(t.last(), "merge"))).toEqual({ ok: false, reason: "base_dirty" });
    sh(root, "commit", "-q", "-am", "someone else");
    expect(await t.c.merge(r.planId, await planDigest(t.last(), "merge"))).toEqual({ ok: false, reason: "base_moved" });
    expect(t.last().status).toBe("ready_to_merge");
  });

  it("the coordinator's own git never runs the repo's hooks", async () => {
    const { root } = repo();
    const marker = join(root, "..", `hook-ran-${Date.now()}`);
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    for (const hook of ["post-merge", "pre-merge-commit", "post-checkout", "reference-transaction"]) {
      writeFileSync(join(root, ".git", "hooks", hook), `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(join(root, ".git", "hooks", hook), 0o755);
    }
    const t = make(root, {
      planner: () => plan([task("a"), task("b")]),
      // The helpers' own git is the agent's business (gated); here they commit with hooks off too.
      helper: (s) => {
        writeFileSync(join(s.cwd, `${s.taskId}.ts`), "x\n");
        execFileSync("git", ["-c", "core.hooksPath=/nonexistent", "add", "-A"], { cwd: s.cwd });
        execFileSync("git", ["-c", "core.hooksPath=/nonexistent", "commit", "-q", "-m", s.taskId], { cwd: s.cwd });
        return "DONE: ok";
      },
      review: () => "APPROVE",
      integration: () => "INTEGRATION PASS",
    });
    const r = (await start(t.c)) as { planId: string };
    await waitFor(() => t.last().status === "awaiting_approval");
    await t.c.approve(r.planId, await planDigest(t.last(), "approve"));
    await waitFor(() => t.last().status === "ready_to_merge");
    await t.c.merge(r.planId, await planDigest(t.last(), "merge"));
    expect(t.last().status).toBe("merged");
    expect(existsSync(marker)).toBe(false);
  });

  it("security review: git config a helper plants (core.fsmonitor) never runs in the coordinator's git", async () => {
    const { root } = repo();
    const marker = join(tmpdir(), `fsmonitor-ran-${Date.now()}`);
    const evil = join(tmpdir(), `fsmonitor-${Date.now()}.sh`);
    writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(evil, 0o755);
    const t = make(root, {
      planner: () => plan([task("a")]),
      helper: (s) => {
        const out = commitHelper(s);
        // What auto-approved code (a test script, an install script) could do in its worktree.
        sh(s.cwd, "config", "core.fsmonitor", evil);
        return out;
      },
      review: () => "APPROVE",
      integration: integrator,
    });
    const r = (await start(t.c)) as { planId: string };
    await waitFor(() => t.last().status === "awaiting_approval");
    await t.c.approve(r.planId, await planDigest(t.last(), "approve"));
    await waitFor(() => t.last().status === "failed");
    expect(existsSync(marker)).toBe(false);
    expect(t.last().note).toMatch(/configuración de git/);
  });

  it("security review: a helper redirecting its worktree's .git file can't make the coordinator run its config", async () => {
    const { root } = repo();
    const marker = join(tmpdir(), `redirect-ran-${Date.now()}`);
    const evil = join(tmpdir(), `fsmonitor-r-${Date.now()}.sh`);
    writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(evil, 0o755);
    const t = make(root, {
      planner: () => plan([task("a")]),
      helper: (s) => {
        const out = commitHelper(s);
        // A fake git dir with an fsmonitor, and the worktree's .git file pointed at it.
        const fake = mkdtempSync(join(tmpdir(), "fake-gitdir-"));
        sh(fake, "init", "-q");
        sh(fake, "config", "core.fsmonitor", evil);
        writeFileSync(join(s.cwd, ".git"), `gitdir: ${join(fake, ".git")}\n`);
        return out;
      },
      review: () => "APPROVE",
      integration: integrator,
    });
    const r = (await start(t.c)) as { planId: string };
    await waitFor(() => t.last().status === "awaiting_approval");
    await t.c.approve(r.planId, await planDigest(t.last(), "approve"));
    await waitFor(
      () => ["failed", "ready_to_merge"].includes(t.last().status) || t.last().tasks[0]!.status === "changes_requested",
    );
    expect(existsSync(marker)).toBe(false);
  });

  it("security review: a tap is for exactly the plan the owner saw", async () => {
    const { root } = repo();
    const t = make(root, {
      planner: () => plan([task("a")]),
      helper: commitHelper,
      review: () => "APPROVE",
      integration: integrator,
    });
    const r = (await start(t.c)) as { planId: string };
    await waitFor(() => t.last().status === "awaiting_approval");
    // A digest of something else (another goal) is refused.
    const other = await planDigest({ ...t.last(), goal: "something else" }, "approve");
    expect(await t.c.approve(r.planId, other)).toEqual({ ok: false, reason: "plan_changed" });
    expect(t.last().status).toBe("awaiting_approval");
    await t.c.approve(r.planId, await planDigest(t.last(), "approve"));
    await waitFor(() => t.last().status === "ready_to_merge");
    expect(t.last().integration.head).toMatch(/^[0-9a-f]{40}$/);
    // Something lands on the integration branch after it was shown as ready: the old tap is refused.
    const shown = await planDigest(t.last(), "merge");
    const wt = join(root, ".chalito-coord", r.planId, "integration");
    writeFileSync(join(wt, "late.ts"), "x\n");
    sh(wt, "add", "-A");
    sh(wt, "commit", "-q", "-m", "late");
    expect(await t.c.merge(r.planId, shown)).toEqual({ ok: false, reason: "plan_changed" });
    expect(existsSync(join(root, "late.ts"))).toBe(false);
  });

  it("refuses a workspace that isn't a git repo or a base that doesn't exist", async () => {
    const plain = mkdtempSync(join(tmpdir(), "coord-plain-"));
    const t = make(plain, {});
    expect(await start(t.c)).toEqual({ ok: false, reason: "not_a_git_repo" });
    const { root } = repo();
    const t2 = make(root, {});
    expect(await start(t2.c, { base: "nope" })).toEqual({ ok: false, reason: "unknown_base" });
    expect(await start(t2.c, { workspaceLabel: "other" })).toEqual({ ok: false, reason: "unknown_workspace" });
  });
});

// Keep the origin type import used (the host's prompt signature takes it).
export type { Origin };
