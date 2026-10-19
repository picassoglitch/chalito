import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { AdapterEvent } from "@chalito/adapters";
import { CoordTaskSpec, type CoordPlanState, type Origin, type RemotePermissionMode } from "@chalito/protocol";
import { z } from "zod";
import type { SessionCoord } from "../agent-core.js";

/**
 * Coordinator mode on one computer (ADR 0025 §1, §6; M17 G2). One goal from the owner's phone:
 *
 *  1. a planner session (read-only, `plan` mode) proposes tasks;
 *  2. the owner's one tap (`coord.approve`) runs them: each task gets its own git worktree inside
 *     the workspace (`.chalito-coord/<plan>/<task>`, branch `coord/<plan>/<task>`) and a helper
 *     session, at most `maxAgents` at once, in dependency order;
 *  3. a finished task gets the deletion check (ADR 0025 §3) and a reviewer session (read-only);
 *     findings go back to the helper, at most two rounds;
 *  4. once every task is approved, an integration helper merges the branches into
 *     `coord/<plan>/integration`, fixes only what combining broke and runs the tests;
 *  5. the owner's merge tap (`coord.merge`, passkey) fast-forwards the base and pushes it.
 *
 * Helper prompts are answered by the gate (coord/gate.ts) within this computer's ceiling; the rest
 * reaches the phone. The coordinator never merges into the base on its own. `coord.stop` (the kill
 * switch) interrupts every session of the plan and keeps worktrees and branches for inspection.
 *
 * The coordinator's own git commands run with hooks off (`core.hooksPath` = an empty folder): a
 * repo's hooks never run outside a gated session. Plans live in memory: an agent restart ends them
 * (their sessions stay resumable, without the helper marker).
 */

export interface CoordHost {
  workspace(label: string): { label: string; path: string } | undefined;
  /** Whether the remote ceiling lets helpers edit (`default` or above). */
  helpersAllowed(): boolean;
  startSession(input: {
    sid: string;
    appId: string;
    cwd: string;
    workspaceLabel: string;
    prompt: string;
    origin: Origin;
    permissionMode: RemotePermissionMode;
    coord: SessionCoord;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
  prompt(sid: string, text: string, origin: Origin): Promise<void>;
  interrupt(sid: string): Promise<void>;
  /** Adapter events of one session (registered before it starts). */
  observe(sid: string, fn: (e: AdapterEvent) => void): () => void;
  /** Seals the state to the owner's clients on the plan's session (doc.coord). */
  publish(sid: string, state: CoordPlanState): Promise<void>;
}

export interface GitResult {
  code: number;
  out: string;
  err: string;
}
export type GitRun = (cwd: string, args: string[]) => Promise<GitResult>;

/**
 * git as the coordinator runs it (security review, 2026-10-19): hooks off, no fsmonitor, no
 * untracked cache, no external diff or pager or askpass, no system config or attributes, no
 * prompts, a 10-minute ceiling. Settings a repo could use to run code that can't be switched off
 * here (filter and merge drivers, includes, credential helpers, …) are checked against the plan's
 * start instead (`DANGEROUS_CONFIG`).
 */
export const nodeGit = (): GitRun => {
  const hooks = mkdtempSync(join(tmpdir(), "chalito-nohooks-"));
  const forced = [
    `core.hooksPath=${hooks}`,
    "core.fsmonitor=false",
    "core.untrackedCache=false",
    "core.pager=cat",
    "core.askPass=",
    "diff.external=",
    "protocol.ext.allow=never",
  ].flatMap((c) => ["-c", c]);
  return (cwd, args) =>
    new Promise((resolve) => {
      execFile(
        "git",
        [...forced, ...args],
        {
          cwd,
          timeout: 10 * 60 * 1000,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_EDITOR: "true",
            GIT_MERGE_AUTOEDIT: "no",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_ATTR_NOSYSTEM: "1",
            GIT_EXTERNAL_DIFF: "",
            GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "",
          },
        },
        (err, stdout, stderr) =>
          resolve({
            code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0,
            out: String(stdout),
            err: String(stderr),
          }),
      );
    });
};

/**
 * git settings that run programs, fetch elsewhere or pull in more config. The coordinator records
 * them at the plan's start and refuses to run git once any of them changes (a helper's code could
 * plant one in the repo's or a worktree's config).
 */
export const DANGEROUS_CONFIG =
  /^(core\.(fsmonitor|sshcommand|pager|editor|askpass|hookspath|gitproxy|worktree|attributesfile|excludesfile)|diff\.(external|[^=]*\.(command|textconv))|merge\.[^=]*\.driver|filter\.[^=]*|credential\..*|include\.[^=]*|includeif\.[^=]*|extensions\.worktreeconfig|uploadpack\..*|receive\..*|sequence\.editor|gpg\.[^=]*program|alias\.[^=]*|remote\.[^=]*\.(receivepack|uploadpack|proxy|url|pushurl|vcs)|http\..*|protocol\..*|url\..*|ssh\..*|safe\..*)=/i;

export interface CoordinatorDeps {
  host: CoordHost;
  git: GitRun;
  now: () => number;
  audit: (type: string, meta: Record<string, unknown>) => void;
  log: (msg: string, meta: Record<string, unknown>) => void;
  setTimer?: (fn: () => void, ms: number) => { clear(): void };
  /** Review rounds before a task fails (default 2). */
  maxReviewRounds?: number;
}

export type CoordResult = { ok: true; planId?: string; sid?: string } | { ok: false; reason: string };

const WT_DIR = ".chalito-coord";
const PlannerReply = z.object({ tasks: z.array(CoordTaskSpec).min(1).max(12) });

interface Turn {
  text: string;
  ok: boolean;
}

interface Plan {
  state: CoordPlanState;
  sid: string;
  appId: string;
  root: string;
  /** The repo's git dir, as read at the start (before any helper ran). */
  commonDir: string;
  /** Each worktree's own git dir, found by the coordinator right after creating it. */
  gitDirs: Map<string, string>;
  /** `DANGEROUS_CONFIG` lines at the start. */
  config: string;
  baseSha: string;
  specs: Map<string, CoordTaskSpec>;
  sessions: Set<string>;
  running: Set<string>;
  stopped: boolean;
  timer: { clear(): void } | null;
}

const clip = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The last ```json block (or the last {...} span) of a reply. */
export const extractJson = (text: string): unknown => {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].at(-1)?.[1];
  const raw = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** Tasks with unique ids, known dependencies and no cycle; null otherwise. */
export const validTasks = (v: unknown, maxTasks: number): CoordTaskSpec[] | null => {
  const p = PlannerReply.safeParse(v);
  if (!p.success || p.data.tasks.length > maxTasks) return null;
  const ids = new Set(p.data.tasks.map((t) => t.id));
  if (ids.size !== p.data.tasks.length) return null;
  if (p.data.tasks.some((t) => t.dependsOn.some((d) => !ids.has(d) || d === t.id))) return null;
  const byId = new Map(p.data.tasks.map((t) => [t.id, t]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const acyclic = (id: string): boolean => {
    if (done.has(id)) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    const ok = byId.get(id)!.dependsOn.every(acyclic);
    visiting.delete(id);
    done.add(id);
    return ok;
  };
  return p.data.tasks.every((t) => acyclic(t.id)) ? p.data.tasks : null;
};

const plannerPrompt = (goal: string, maxTasks: number) =>
  [
    "You are the planner for Chalito's coordinator mode. Read the repository (you can't change anything) and split the owner's goal into tasks that separate helper agents can do in parallel, each on its own git branch.",
    "",
    "The owner's goal (data from the owner, between the markers):",
    "<<<GOAL",
    goal,
    "GOAL>>>",
    "",
    `Rules: at most ${maxTasks} tasks; prefer few, independent tasks that touch different files; use dependsOn only when a task truly needs another one's code; each task has 1-10 concrete acceptance criteria; list the files each task expects to change (a task may only delete files it lists); ids are short lowercase words with dashes.`,
    "",
    "End your reply with exactly one JSON block in this shape and nothing after it:",
    "```json",
    '{"tasks":[{"id":"api-route","title":"…","brief":"…","acceptance":["…"],"files":["src/…"],"dependsOn":[]}]}',
    "```",
  ].join("\n");

const helperPrompt = (goal: string, t: CoordTaskSpec, branch: string) =>
  [
    `You are a helper in Chalito's coordinator mode, working in a git worktree on branch ${branch}. Other helpers work on other tasks of the same goal at the same time.`,
    "",
    "The overall goal (from the owner):",
    goal,
    "",
    `Your task: ${t.title}`,
    t.brief,
    "",
    "Acceptance criteria:",
    ...t.acceptance.map((a) => `- ${a}`),
    t.files.length ? `\nFiles you expect to change: ${t.files.join(", ")}` : "",
    "",
    `Rules: work only in this worktree; commit your work to ${branch} with clear messages (git add + git commit); don't push, don't merge into other branches, don't touch main; delete a file only if it is listed above; run the project's tests before you finish.`,
    "When you are done, reply with one line starting with DONE: and a one-sentence summary. If you can't do it, reply with one line starting with BLOCKED: and why.",
  ].join("\n");

const reviewPrompt = (t: CoordTaskSpec, baseSha: string, branch: string) =>
  [
    `You are the reviewer in Chalito's coordinator mode. Review the changes on ${branch} against ${baseSha.slice(0, 12)} (git diff ${baseSha.slice(0, 12)}..HEAD). You can't change anything.`,
    "",
    `Task: ${t.title}`,
    t.brief,
    "Acceptance criteria:",
    ...t.acceptance.map((a) => `- ${a}`),
    "",
    "Check that every criterion is met, that nothing unrelated changed, and that there are no obvious bugs or security problems.",
    "Reply with one line: APPROVE, or CHANGES: followed by the specific fixes needed.",
  ].join("\n");

const integrationPrompt = (branches: string[], pending: string[]) =>
  [
    "You are the integration helper in Chalito's coordinator mode, on the plan's integration branch. Your job is to combine the helpers' branches, not to add features.",
    "",
    pending.length
      ? `Merge these branches in this order with git merge --no-ff, resolving conflicts so both sides' intent is kept: ${pending.join(", ")}.`
      : "All branches are already merged.",
    `The plan's branches: ${branches.join(", ")}.`,
    "Then run the project's tests and fix only what combining the branches broke. Commit everything.",
    "Reply with one line: INTEGRATION PASS, or INTEGRATION FAIL: and why.",
  ].join("\n");

export class Coordinator {
  readonly #plans = new Map<string, Plan>();
  /** Turn tracking per session: the last assistant text and who waits for the turn's end. */
  readonly #turns = new Map<
    string,
    { text: string; waiting: ((t: Turn) => void)[]; ended: Turn[]; unobserve: () => void }
  >();

  constructor(private readonly d: CoordinatorDeps) {}

  plans(): CoordPlanState[] {
    return [...this.#plans.values()].map((p) => p.state);
  }

  // ---- commands -------------------------------------------------------------------------------

  async start(input: {
    goal: string;
    workspaceLabel: string;
    appId: string;
    maxAgents: number;
    maxMinutes: number;
    base?: string;
  }): Promise<CoordResult> {
    const ws = this.d.host.workspace(input.workspaceLabel);
    if (!ws) return { ok: false, reason: "unknown_workspace" };
    if (!this.d.host.helpersAllowed()) return { ok: false, reason: "permission_mode_above_ceiling" };
    const top = await this.#git(ws.path, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) return { ok: false, reason: "not_a_git_repo" };
    const root = top.out.trim();
    let base = input.base;
    if (!base) {
      const head = await this.#git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      if (head.code !== 0) return { ok: false, reason: "detached_head" };
      base = head.out.trim();
    }
    const sha = await this.#git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${base}^{commit}`]);
    if (sha.code !== 0) return { ok: false, reason: "unknown_base" };
    const common = await this.#git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common.code !== 0) return { ok: false, reason: "not_a_git_repo" };
    const commonDir = common.out.trim();
    const config = await this.#configOf(["--git-dir", commonDir, "--work-tree", root], root);
    if (config === null) return { ok: false, reason: "not_a_git_repo" };
    await this.#excludeWorktrees(commonDir);

    const planId = `p${randomBytes(6).toString("hex").slice(0, 8)}`;
    const sid = randomUUID();
    const plan: Plan = {
      sid,
      appId: input.appId,
      root,
      commonDir,
      gitDirs: new Map(),
      config,
      baseSha: sha.out.trim(),
      specs: new Map(),
      sessions: new Set([sid]),
      running: new Set(),
      stopped: false,
      timer: null,
      state: {
        v: 1,
        planId,
        goal: clip(input.goal, 4000),
        workspaceLabel: ws.label,
        base,
        status: "planning",
        maxAgents: input.maxAgents,
        maxMinutes: input.maxMinutes,
        startedAt: null,
        tasks: [],
        integration: { branch: `coord/${planId}/integration`, sid: null, note: null },
        note: null,
        updatedAt: this.d.now(),
      },
    };
    this.#plans.set(planId, plan);
    this.d.audit("coord.started", { planId, sid, workspaceLabel: ws.label, appId: input.appId });
    // One agent can work through several tasks in turn: at least 4, at most 12.
    const maxTasks = Math.min(12, Math.max(4, input.maxAgents * 2));
    const started = await this.#session(plan, sid, {
      cwd: root,
      prompt: plannerPrompt(input.goal, maxTasks),
      permissionMode: "plan",
      taskId: "planner",
    });
    if (!started.ok) {
      this.#plans.delete(planId);
      return started;
    }
    await this.#publish(plan);
    void this.#plan(plan, maxTasks).catch((err: unknown) => this.#fail(plan, err));
    return { ok: true, planId, sid };
  }

  async approve(planId: string): Promise<CoordResult> {
    const plan = this.#plans.get(planId);
    if (!plan) return { ok: false, reason: "unknown_plan" };
    if (plan.state.status !== "awaiting_approval") return { ok: false, reason: "plan_not_waiting" };
    plan.state.status = "running";
    plan.state.startedAt = this.d.now();
    plan.timer = (this.d.setTimer ?? defaultTimer)(
      () => void this.stop(planId, "budget"),
      plan.state.maxMinutes * 60 * 1000,
    );
    this.d.audit("coord.approved", { planId, tasks: plan.state.tasks.length });
    await this.#publish(plan);
    this.#schedule(plan);
    return { ok: true, planId, sid: plan.sid };
  }

  async stop(planId: string, by: "owner" | "budget" | "revoked" | "restart" = "owner"): Promise<CoordResult> {
    const plan = this.#plans.get(planId);
    if (!plan) return { ok: false, reason: "unknown_plan" };
    if (plan.stopped || plan.state.status === "merged") return { ok: true, planId, sid: plan.sid };
    plan.stopped = true;
    plan.timer?.clear();
    for (const t of plan.state.tasks) if (t.status !== "approved" && t.status !== "failed") t.status = "stopped";
    plan.state.status = "stopped";
    plan.state.note = {
      owner: "Detenido por ti.",
      budget: "Se acabó el tiempo del plan.",
      revoked: "Esta computadora fue retirada de tu cuenta.",
      restart: "Chalito se detuvo en esta computadora; el plan terminó.",
    }[by];
    await Promise.all([...plan.sessions].map((sid) => this.d.host.interrupt(sid).catch(() => undefined)));
    for (const sid of plan.sessions) this.#release(sid);
    this.d.audit("coord.stopped", { planId, by });
    await this.#publish(plan);
    return { ok: true, planId, sid: plan.sid };
  }

  /** Every plan, at once (revoke-all, agent shutdown). */
  async stopAll(by: "revoked" | "restart" = "restart"): Promise<void> {
    await Promise.all([...this.#plans.keys()].map((id) => this.stop(id, by)));
  }

  /** The owner's merge tap: the base fast-forwards to the integration branch, then is pushed. */
  async merge(planId: string): Promise<CoordResult> {
    const plan = this.#plans.get(planId);
    if (!plan) return { ok: false, reason: "unknown_plan" };
    if (plan.state.status !== "ready_to_merge") return { ok: false, reason: "plan_not_ready" };
    const { base, integration } = { base: plan.state.base, integration: plan.state.integration.branch };
    const git = (args: string[], cwd = plan.root) => this.#pgit(plan, cwd, args);
    const target = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${integration}^{commit}`])).out.trim();
    const old = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${base}^{commit}`])).out.trim();
    if (!target || !old) return { ok: false, reason: "branch_missing" };
    if ((await git(["merge-base", "--is-ancestor", old, target])).code !== 0) {
      plan.state.note = `${base} cambió desde que empezó el plan; hay que integrar otra vez.`;
      await this.#publish(plan);
      return { ok: false, reason: "base_moved" };
    }
    // Where the base is checked out, it moves there (only if clean); otherwise just the ref.
    const wt = await git(["worktree", "list", "--porcelain"]);
    const checkedOut = wt.out
      .split("\n\n")
      .map((b) => ({ path: /^worktree (.+)$/m.exec(b)?.[1], branch: /^branch (.+)$/m.exec(b)?.[1] }))
      .find((b) => b.branch === `refs/heads/${base}`)?.path;
    // Another of the owner's worktrees: its own git dir, found the same way as the plan's.
    if (checkedOut && checkedOut !== plan.root && !(await this.#registerWorktree(plan, checkedOut)))
      return { ok: false, reason: "merge_failed" };
    if (checkedOut) {
      const dirty = await git(["status", "--porcelain", "--untracked-files=no"], checkedOut);
      if (dirty.code !== 0 || dirty.out.trim()) {
        plan.state.note = `Hay cambios sin guardar en ${base}; guárdalos y vuelve a tocar Fusionar.`;
        await this.#publish(plan);
        return { ok: false, reason: "base_dirty" };
      }
      const ff = await git(["merge", "--ff-only", target], checkedOut);
      if (ff.code !== 0) return { ok: false, reason: "merge_failed" };
    } else {
      const upd = await git(["update-ref", `refs/heads/${base}`, target, old]);
      if (upd.code !== 0) return { ok: false, reason: "merge_failed" };
    }
    let note = `${base} ahora incluye el plan.`;
    if ((await git(["remote", "get-url", "origin"])).code === 0) {
      // Only the owner's own (global) credential helpers, never one from the repo's config.
      const helpers = (await this.d.git(plan.root, ["config", "--global", "--get-all", "credential.helper"])).out
        .split("\n")
        .filter(Boolean);
      const cred = ["credential.helper=", ...helpers.map((h) => `credential.helper=${h}`)].flatMap((c) => ["-c", c]);
      const push = await git([...cred, "push", "origin", `refs/heads/${base}:refs/heads/${base}`]);
      note =
        push.code === 0
          ? `${base} incluye el plan y se subió a origin.`
          : `${base} incluye el plan en esta computadora; no se pudo subir: ${clip(push.err.trim(), 200)}`;
    }
    plan.state.status = "merged";
    plan.state.note = note;
    plan.timer?.clear();
    for (const sid of plan.sessions) this.#release(sid);
    this.d.audit("coord.merged", { planId, base, pushed: note.includes("origin") });
    await this.#publish(plan);
    return { ok: true, planId, sid: plan.sid };
  }

  // ---- the plan's life --------------------------------------------------------------------------

  async #plan(plan: Plan, maxTasks: number): Promise<void> {
    let turn = await this.#turn(plan.sid);
    let tasks = turn.ok ? validTasks(extractJson(turn.text), maxTasks) : null;
    if (!tasks && turn.ok && !plan.stopped) {
      await this.d.host.prompt(
        plan.sid,
        "Your plan couldn't be read. Reply again with only the JSON block in the shape asked for.",
        this.#origin(plan),
      );
      turn = await this.#turn(plan.sid);
      tasks = turn.ok ? validTasks(extractJson(turn.text), maxTasks) : null;
    }
    if (plan.stopped) return;
    if (!tasks) return this.#fail(plan, new Error("El planificador no propuso un plan válido."));
    for (const t of tasks) plan.specs.set(t.id, t);
    plan.state.tasks = tasks.map((t) => ({
      id: t.id,
      title: t.title,
      acceptance: t.acceptance,
      dependsOn: t.dependsOn,
      status: "pending" as const,
      branch: `coord/${plan.state.planId}/${t.id}`,
      sid: null,
      note: null,
      reviewRounds: 0,
    }));
    plan.state.status = "awaiting_approval";
    this.#release(plan.sid);
    await this.#publish(plan);
  }

  #schedule(plan: Plan): void {
    if (plan.stopped || plan.state.status !== "running") return;
    const byId = new Map(plan.state.tasks.map((t) => [t.id, t]));
    for (const t of plan.state.tasks) {
      if (plan.running.size >= plan.state.maxAgents) break;
      if (t.status !== "pending") continue;
      if (!t.dependsOn.every((d) => byId.get(d)?.status === "approved")) continue;
      plan.running.add(t.id);
      void this.#runTask(plan, t.id)
        .catch((err: unknown) => this.#taskFailed(plan, t.id, err instanceof Error ? err.message : "error"))
        .finally(() => {
          plan.running.delete(t.id);
          void this.#afterTask(plan);
        });
    }
  }

  async #afterTask(plan: Plan): Promise<void> {
    if (plan.stopped || plan.state.status !== "running") return;
    const tasks = plan.state.tasks;
    if (tasks.every((t) => t.status === "approved"))
      return void this.#integrate(plan).catch((e) => this.#fail(plan, e));
    const failed = tasks.filter((t) => t.status === "failed");
    // A failed task blocks the tasks that need it; once nothing else can run, the plan has failed.
    this.#schedule(plan);
    if (plan.running.size === 0 && failed.length)
      return this.#fail(plan, new Error(`No se pudo terminar: ${failed.map((t) => t.title).join(", ")}.`));
    await this.#publish(plan);
  }

  async #runTask(plan: Plan, taskId: string): Promise<void> {
    const t = plan.state.tasks.find((x) => x.id === taskId)!;
    const spec = plan.specs.get(taskId)!;
    const dir = join(plan.root, WT_DIR, plan.state.planId, taskId);
    const add = await this.#pgit(plan, plan.root, ["worktree", "add", "-b", t.branch, dir, plan.baseSha]);
    if (add.code !== 0) return this.#taskFailed(plan, taskId, `worktree: ${clip(add.err.trim(), 200)}`);
    if (!(await this.#registerWorktree(plan, dir))) return this.#taskFailed(plan, taskId, "worktree: no git dir");
    // A task that needs others starts from their (approved) work.
    for (const dep of t.dependsOn) {
      const m = await this.#pgit(plan, dir, ["merge", "--no-ff", "--no-edit", `coord/${plan.state.planId}/${dep}`]);
      if (m.code !== 0) {
        await this.#pgit(plan, dir, ["merge", "--abort"]);
        return this.#taskFailed(plan, taskId, `No se pudo partir del trabajo de ${dep}.`);
      }
    }
    const sid = randomUUID();
    t.sid = sid;
    t.status = "running";
    await this.#publish(plan);
    const started = await this.#session(plan, sid, {
      cwd: dir,
      prompt: helperPrompt(plan.state.goal, spec, t.branch),
      permissionMode: "default",
      taskId,
    });
    if (!started.ok) return this.#taskFailed(plan, taskId, `No arrancó el agente (${started.reason}).`);
    const rounds = this.d.maxReviewRounds ?? 2;
    let turn = await this.#turn(sid);
    for (;;) {
      if (plan.stopped) return;
      if (!turn.ok) return this.#taskFailed(plan, taskId, "El agente se detuvo.");
      const last = lastLine(turn.text);
      if (/^BLOCKED:/i.test(last)) return this.#taskFailed(plan, taskId, clip(last));
      t.note = clip(last);
      const finding = await this.#checkTask(plan, dir, t.branch, spec);
      let changes = finding;
      if (!changes) {
        t.status = "reviewing";
        await this.#publish(plan);
        changes = await this.#review(plan, spec, t.branch, dir);
        if (plan.stopped) return;
      }
      if (changes === null) {
        t.status = "approved";
        this.#release(sid);
        await this.#publish(plan);
        return;
      }
      if (t.reviewRounds >= rounds) return this.#taskFailed(plan, taskId, clip(`Revisión sin aprobar: ${changes}`));
      t.reviewRounds++;
      t.status = "changes_requested";
      t.note = clip(changes);
      await this.#publish(plan);
      await this.d.host.prompt(
        sid,
        `The review asks for changes. Fix them, commit, and reply DONE: or BLOCKED: again.\n\n${changes}`,
        this.#origin(plan),
      );
      t.status = "running";
      turn = await this.#turn(sid);
    }
  }

  /** The coordinator's own checks (ADR 0025 §3): committed, clean, no unlisted deletions. */
  async #checkTask(plan: Plan, dir: string, branch: string, spec: CoordTaskSpec): Promise<string | null> {
    const status = await this.#pgit(plan, dir, ["status", "--porcelain"]);
    if (status.code !== 0) return "The worktree couldn't be read: restore it and commit your work.";
    if (status.out.trim()) return "There are uncommitted changes: commit all your work.";
    // What gets reviewed and integrated is the branch, read from the repo itself.
    const ref = `refs/heads/${branch}`;
    const count = await this.#pgit(plan, plan.root, ["rev-list", "--count", `${plan.baseSha}..${ref}`]);
    if (count.code !== 0 || Number(count.out.trim()) === 0) return "Nothing was committed on the branch.";
    const deleted = await this.#pgit(plan, plan.root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--diff-filter=D",
      "--name-only",
      plan.baseSha,
      ref,
    ]);
    const unlisted = deleted.out
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f && !spec.files.includes(f));
    return unlisted.length
      ? `These files were deleted but the task doesn't list them; restore them or explain: ${unlisted.slice(0, 20).join(", ")}`
      : null;
  }

  /** A read-only reviewer on the task's worktree: null to approve, or the changes asked for. */
  async #review(plan: Plan, spec: CoordTaskSpec, branch: string, dir: string): Promise<string | null> {
    const sid = randomUUID();
    const started = await this.#session(plan, sid, {
      cwd: dir,
      prompt: reviewPrompt(spec, plan.baseSha, branch),
      permissionMode: "plan",
      taskId: `${spec.id}-review`,
    });
    if (!started.ok) return `The reviewer couldn't start (${started.reason}).`;
    const turn = await this.#turn(sid);
    this.#release(sid);
    if (!turn.ok) return "The reviewer stopped before answering.";
    const verdict = turn.text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .reverse()
      .find((l) => /^(APPROVE\b|CHANGES:)/i.test(l));
    if (verdict && /^APPROVE\b/i.test(verdict)) return null;
    return verdict ? verdict.replace(/^CHANGES:\s*/i, "") : clip(turn.text.trim() || "No verdict.", 1500);
  }

  async #integrate(plan: Plan): Promise<void> {
    if (plan.stopped) return;
    plan.state.status = "integrating";
    await this.#publish(plan);
    const integration = plan.state.integration.branch;
    const dir = join(plan.root, WT_DIR, plan.state.planId, "integration");
    const add = await this.#pgit(plan, plan.root, ["worktree", "add", "-b", integration, dir, plan.baseSha]);
    if (add.code !== 0) return this.#fail(plan, new Error(`worktree: ${clip(add.err.trim(), 200)}`));
    if (!(await this.#registerWorktree(plan, dir))) return this.#fail(plan, new Error("worktree: no git dir"));
    const order = topoOrder(plan.state.tasks);
    const branches = order.map((t) => t.branch);
    // Clean merges here; the first conflict and everything after it go to the integration helper.
    const pending: string[] = [];
    for (const b of branches) {
      if (pending.length) {
        pending.push(b);
        continue;
      }
      const m = await this.#pgit(plan, dir, ["merge", "--no-ff", "--no-edit", b]);
      if (m.code !== 0) {
        await this.#pgit(plan, dir, ["merge", "--abort"]);
        pending.push(b);
      }
    }
    const sid = randomUUID();
    plan.state.integration.sid = sid;
    await this.#publish(plan);
    const started = await this.#session(plan, sid, {
      cwd: dir,
      prompt: integrationPrompt(branches, pending),
      permissionMode: "default",
      taskId: "integration",
    });
    if (!started.ok) return this.#fail(plan, new Error(`El agente de integración no arrancó (${started.reason}).`));
    const turn = await this.#turn(sid);
    this.#release(sid);
    if (plan.stopped) return;
    const last = lastLine(turn.text);
    plan.state.integration.note = clip(last);
    const merged = await Promise.all(
      branches.map((b) =>
        this.#pgit(plan, plan.root, ["merge-base", "--is-ancestor", `refs/heads/${b}`, `refs/heads/${integration}`]),
      ),
    );
    const st = await this.#pgit(plan, dir, ["status", "--porcelain"]);
    const clean = st.code === 0 && !st.out.trim();
    if (!turn.ok || !/^INTEGRATION PASS\b/i.test(last) || merged.some((m) => m.code !== 0) || !clean) {
      return this.#fail(
        plan,
        new Error(
          !turn.ok
            ? "La integración se detuvo."
            : merged.some((m) => m.code !== 0)
              ? "No todas las ramas quedaron integradas."
              : !clean
                ? "La integración dejó cambios sin guardar."
                : clip(last || "La integración no pasó."),
        ),
      );
    }
    plan.timer?.clear();
    plan.state.status = "ready_to_merge";
    plan.state.note = "Listo para fusionar: revisa y toca Fusionar.";
    this.d.audit("coord.ready", { planId: plan.state.planId });
    await this.#publish(plan);
  }

  // ---- helpers -----------------------------------------------------------------------------------

  #origin(plan: Plan): Origin {
    return `agent:coord_${plan.state.planId}`;
  }

  async #session(
    plan: Plan,
    sid: string,
    o: { cwd: string; prompt: string; permissionMode: RemotePermissionMode; taskId: string },
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    this.#watch(sid);
    plan.sessions.add(sid);
    const r = await this.d.host.startSession({
      sid,
      appId: plan.appId,
      cwd: o.cwd,
      workspaceLabel: plan.state.workspaceLabel,
      prompt: o.prompt,
      origin: this.#origin(plan),
      permissionMode: o.permissionMode,
      coord: {
        planId: plan.state.planId,
        taskId: o.taskId,
        branchPrefix: `coord/${plan.state.planId}/`,
        active: () => !plan.stopped && plan.state.status !== "merged" && plan.state.status !== "failed",
      },
    });
    if (!r.ok) this.#release(sid);
    return r;
  }

  #watch(sid: string): void {
    if (this.#turns.has(sid)) return;
    // A turn can end before anyone waits for it (a fast agent, inside startSession): kept in `ended`.
    const entry = {
      text: "",
      waiting: [] as ((t: Turn) => void)[],
      ended: [] as Turn[],
      unobserve: () => undefined as void,
    };
    this.#turns.set(sid, entry);
    entry.unobserve = this.d.host.observe(sid, (e) => {
      if (e.type === "assistant_text") entry.text = e.text;
      if (e.type !== "state") return;
      const end =
        e.state === "idle" || e.state === "completed"
          ? true
          : e.state === "failed" || e.state === "interrupted"
            ? false
            : null;
      if (end === null) return;
      const turn = { text: entry.text, ok: end };
      entry.text = "";
      const w = entry.waiting.shift();
      if (w) w(turn);
      else entry.ended.push(turn);
    });
  }

  /** The end of the session's current turn. */
  #turn(sid: string): Promise<Turn> {
    const entry = this.#turns.get(sid);
    if (!entry) return Promise.resolve({ text: "", ok: false });
    const ended = entry.ended.shift();
    if (ended) return Promise.resolve(ended);
    return new Promise((resolve) => entry.waiting.push(resolve));
  }

  #release(sid: string): void {
    const entry = this.#turns.get(sid);
    if (!entry) return;
    entry.unobserve();
    for (const w of entry.waiting.splice(0)) w({ text: entry.text, ok: false });
    this.#turns.delete(sid);
  }

  async #taskFailed(plan: Plan, taskId: string, note: string): Promise<void> {
    const t = plan.state.tasks.find((x) => x.id === taskId);
    if (!t || plan.stopped) return;
    t.status = "failed";
    t.note = clip(note);
    if (t.sid) this.#release(t.sid);
    await this.#publish(plan);
  }

  /** The plan is over: nothing more runs, its sessions are interrupted, the state says why. */
  async #fail(plan: Plan, err: unknown): Promise<void> {
    if (plan.stopped) return;
    plan.stopped = true;
    plan.timer?.clear();
    plan.state.status = "failed";
    plan.state.note = clip(err instanceof Error ? err.message : "Algo falló.");
    for (const t of plan.state.tasks) if (t.status === "running" || t.status === "reviewing") t.status = "stopped";
    await Promise.all([...plan.sessions].map((sid) => this.d.host.interrupt(sid).catch(() => undefined)));
    for (const sid of plan.sessions) this.#release(sid);
    this.d.audit("coord.failed", { planId: plan.state.planId });
    await this.#publish(plan);
  }

  async #publish(plan: Plan): Promise<void> {
    plan.state.updatedAt = this.d.now();
    try {
      await this.d.host.publish(plan.sid, plan.state);
    } catch (err) {
      this.d.log("coord.publish_failed", {
        planId: plan.state.planId,
        error: err instanceof Error ? err.message : "error",
      });
    }
  }

  async #git(cwd: string, args: string[]): Promise<GitResult> {
    return this.d.git(cwd, args);
  }

  /** Worktrees live inside the workspace; keep them out of `git status` of the main checkout. */
  async #excludeWorktrees(commonDir: string): Promise<void> {
    const { appendFileSync, existsSync, mkdirSync, readFileSync } = await import("node:fs");
    const info = join(commonDir, "info");
    const file = join(info, "exclude");
    try {
      if (existsSync(file) && readFileSync(file, "utf8").split("\n").includes(`/${WT_DIR}/`)) return;
      mkdirSync(info, { recursive: true });
      appendFileSync(file, `\n/${WT_DIR}/\n`);
    } catch (err) {
      this.d.log("coord.exclude_failed", { error: err instanceof Error ? err.message : "error" });
    }
  }

  /** The `DANGEROUS_CONFIG` lines git sees with these git-dir arguments (sorted), or null. */
  async #configOf(dirArgs: string[], cwd: string): Promise<string | null> {
    const r = await this.d.git(cwd, [...dirArgs, "config", "--list", "--show-scope"]);
    if (r.code !== 0) return null;
    return r.out
      .split("\n")
      .map((l) => l.replace(/^\S+\t/, ""))
      .filter((l) => DANGEROUS_CONFIG.test(l))
      .sort()
      .join("\n");
  }

  /**
   * The plan's git: from the repo root or a worktree the coordinator made, always with the git dir
   * it computed itself (never the worktree's `.git` file, which a helper can rewrite), and only
   * while the code-running settings are the ones from the plan's start.
   */
  async #pgit(plan: Plan, cwd: string, args: string[]): Promise<GitResult> {
    const dirArgs =
      cwd === plan.root
        ? ["--git-dir", plan.commonDir, "--work-tree", plan.root]
        : plan.gitDirs.has(cwd)
          ? ["--git-dir", plan.gitDirs.get(cwd)!, "--work-tree", cwd]
          : null;
    if (!dirArgs) return { code: 128, out: "", err: "not a worktree of this plan" };
    const now = await this.#configOf(dirArgs, cwd);
    if (now !== plan.config) {
      const err = "La configuración de git del repo cambió durante el plan; Chalito no ejecutó nada más.";
      void this.#fail(plan, new Error(err));
      return { code: 128, out: "", err };
    }
    return this.d.git(cwd, [...dirArgs, ...args]);
  }

  /** Right after `worktree add`: the admin dir whose `gitdir` file points back at this worktree. */
  async #registerWorktree(plan: Plan, dir: string): Promise<boolean> {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const admin = join(plan.commonDir, "worktrees");
    try {
      for (const name of readdirSync(admin)) {
        const back = readFileSync(join(admin, name, "gitdir"), "utf8").trim();
        if (resolve(back) === resolve(join(dir, ".git"))) {
          plan.gitDirs.set(dir, join(admin, name));
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }
}

const defaultTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { clear: () => clearTimeout(t) };
};

const lastLine = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? "";

/** Tasks with their dependencies first (the planner's order otherwise). */
const topoOrder = <T extends { id: string; dependsOn: string[] }>(tasks: T[]): T[] => {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out: T[] = [];
  const seen = new Set<string>();
  const visit = (t: T) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    for (const d of t.dependsOn) visit(byId.get(d)!);
    out.push(t);
  };
  for (const t of tasks) visit(t);
  return out;
};
