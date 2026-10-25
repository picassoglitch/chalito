import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseViewer, prEvents, prStatuses, repoAllowed, type Viewer } from "../src/prs/events.js";
import { repoOfRemote, sessionFor, type SessionRepo } from "../src/prs/link.js";
import {
  GH_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
  MAX_BACKOFF_MS,
  POLL_MS,
  PROBE_TTL_MS,
  PrWatch,
  SEEN_TTL_MS,
  findGh,
  type PrWatchDeps,
} from "../src/prs/watch.js";
import { spawnRunner, type RunResult } from "../src/runner.js";
import { H, T0, commit, fakeRunner, iso, ok, pr, review, viewerJson } from "./prs-fixtures.js";

const ALL = { allow: [], deny: [] };
const viewer = (open: unknown[], merged: unknown[] = []): Viewer => {
  const p = parseViewer(viewerJson(open, merged));
  if (!p.ok) throw new Error(p.reason);
  return p.viewer;
};

describe("PR events from the GraphQL answer", () => {
  it("approved, changes requested, comments, red and green CI, merged: one keyed event each", () => {
    const v = viewer(
      [
        pr({ number: 1, reviews: { nodes: [review("APPROVED", T0 - H, "ana")] } }),
        pr({ number: 2, reviews: { nodes: [review("CHANGES_REQUESTED", T0 - H, "luis", 3)] } }),
        pr({ number: 3, reviews: { nodes: [review("COMMENTED", T0 - H, "ana", 2)] } }),
        pr({ number: 4, commits: commit("bad", T0 - 9 * 24 * H, "FAILURE") }),
        pr({ number: 5, commits: commit("good", T0 - H, "SUCCESS") }),
      ],
      [pr({ number: 6, state: "MERGED", mergedAt: iso(T0 - 2 * H) })],
    );
    const ev = prEvents(v, ALL, T0);
    expect(ev.map((e) => [e.number, e.kind, e.key])).toEqual([
      [1, "approved", `pr:acme/app#1:approved:${T0 - H}`],
      [2, "changes_requested", `pr:acme/app#2:changes_requested:${T0 - H}`],
      [3, "comments", `pr:acme/app#3:comments:${T0 - H}`],
      // Red CI stays news however old the commit, until a push changes the sha.
      [4, "ci_failed", "pr:acme/app#4:ci_failed:bad"],
      [5, "ci_passed", "pr:acme/app#5:ci_passed:good"],
      [6, "merged", `pr:acme/app#6:merged:${T0 - 2 * H}`],
    ]);
    expect(ev[1]).toMatchObject({ by: "luis", comments: 3 });
  });

  it("ignores the person's own reviews, bots, drafts and anything older than three days", () => {
    const v = viewer([
      pr({ number: 1, reviews: { nodes: [review("APPROVED", T0 - H, "me")] } }),
      pr({ number: 2, reviews: { nodes: [review("COMMENTED", T0 - H, "ci-bot", 9, "Bot")] } }),
      pr({ number: 3, isDraft: true, reviews: { nodes: [review("APPROVED", T0 - H)] } }),
      pr({ number: 4, reviews: { nodes: [review("APPROVED", T0 - 4 * 24 * H)] } }),
    ]);
    expect(prEvents(v, ALL, T0)).toEqual([]);
  });

  it("a comment left before the last push is not news; one after the decision is", () => {
    const pushed = T0 - 2 * H;
    const old = viewer([
      pr({ commits: commit("c", pushed, null), reviews: { nodes: [review("COMMENTED", pushed - H)] } }),
    ]);
    expect(prEvents(old, ALL, T0)).toEqual([]);
    const after = viewer([
      pr({
        commits: commit("c", pushed, null),
        reviews: { nodes: [review("APPROVED", pushed + 10), review("COMMENTED", pushed + 20, "luis", 1)] },
      }),
    ]);
    expect(prEvents(after, ALL, T0).map((e) => e.kind)).toEqual(["approved", "comments"]);
  });

  it("the panel list: open PRs only, with review, CI and comments since the push", () => {
    const v = viewer(
      [
        pr({
          number: 1,
          commits: commit("x", T0 - 3 * H, "PENDING"),
          reviews: { nodes: [review("COMMENTED", T0 - H, "ana", 2)] },
        }),
        pr({ number: 2, isDraft: true, commits: commit("y", T0 - 3 * H, "ERROR"), reviewDecision: null }),
      ],
      [pr({ number: 3, state: "MERGED", mergedAt: iso(T0) })],
    );
    expect(prStatuses(v, ALL).map((p) => [p.number, p.draft, p.review, p.ci, p.comments])).toEqual([
      [1, false, "review_required", "pending", 2],
      [2, true, null, "failing", 0],
    ]);
  });

  it("an unparsable or data-less answer says why, never throws", () => {
    expect(parseViewer("not json")).toEqual({ ok: false, reason: "json", errors: [] });
    expect(parseViewer(JSON.stringify({ errors: [{ message: "Bad credentials" }] }))).toEqual({
      ok: false,
      reason: "no_data",
      errors: ["Bad credentials"],
    });
  });

  it("a partial answer keeps what it can: SSO-hidden null nodes and a node that doesn't fit are skipped", () => {
    const body = JSON.parse(viewerJson([null, pr(), { number: "x" }])) as Record<string, unknown>;
    body.errors = [{ type: "FORBIDDEN", message: "Resource protected by organization SAML enforcement." }];
    const p = parseViewer(JSON.stringify(body));
    expect(p).toMatchObject({ ok: true, skipped: 1, errors: [expect.stringContaining("SAML")] });
    expect(p.ok && p.viewer.open.nodes.map((n) => n?.number)).toEqual([7]);
  });

  it("the list status follows GitHub's decision, not just the last review", () => {
    const reviews = { nodes: [review("CHANGES_REQUESTED", T0 - 2 * H, "luis"), review("APPROVED", T0 - H, "ana")] };
    const blocked = viewer([pr({ reviewDecision: "CHANGES_REQUESTED", reviews })]);
    expect(prStatuses(blocked, ALL)[0]!.review).toBe("changes_requested");
    const noRule = viewer([pr({ reviewDecision: null, reviews })]);
    expect(prStatuses(noRule, ALL)[0]!.review).toBe("approved");
  });

  it("green CI after a re-run on an old commit is still news (keyed by sha)", () => {
    const v = viewer([pr({ commits: commit("old", T0 - 9 * 24 * H, "SUCCESS") })]);
    expect(prEvents(v, ALL, T0).map((e) => e.key)).toEqual(["pr:acme/app#7:ci_passed:old"]);
  });

  it("allow and deny lists: owner/* or owner/repo, deny wins, empty allow is everything", () => {
    expect(repoAllowed("acme/app", ALL)).toBe(true);
    expect(repoAllowed("Acme/App", { allow: ["acme/*"], deny: [] })).toBe(true);
    expect(repoAllowed("other/app", { allow: ["acme/*"], deny: [] })).toBe(false);
    expect(repoAllowed("acme/app", { allow: ["acme/*"], deny: ["acme/app"] })).toBe(false);
    const v = viewer([pr({ commits: commit("bad", T0, "FAILURE") })]);
    expect(prEvents(v, { allow: [], deny: ["acme/*"] }, T0)).toEqual([]);
  });
});

describe("linking news to the session on that branch", () => {
  it("reads owner/repo from https, ssh and scp remotes", () => {
    expect(repoOfRemote("https://github.com/acme/app.git")).toBe("acme/app");
    expect(repoOfRemote("git@github.com:acme/app.git")).toBe("acme/app");
    expect(repoOfRemote("ssh://git@github.com/acme/app")).toBe("acme/app");
    expect(repoOfRemote("")).toBeNull();
    expect(repoOfRemote("git@gitlab.com:acme/app.git")).toBeNull();
  });

  const place = (o: Partial<SessionRepo>): SessionRepo => ({
    sid: "s1",
    label: "uno",
    cwd: "/w/app",
    lastActiveAt: 1,
    branch: "feat/7-cobro",
    repos: ["acme/app"],
    ...o,
  });
  const [ev] = prEvents(viewer([pr({ commits: commit("bad", T0, "FAILURE") })]), ALL, T0);

  it("matches repo and branch, newest session first; a fork's remote matches too", () => {
    expect(sessionFor(ev!, [place({}), place({ sid: "s2", label: "dos", lastActiveAt: 5 })])).toEqual({
      sid: "s2",
      label: "dos",
    });
    expect(sessionFor({ ...ev!, headRepo: "me/app" }, [place({ repos: ["me/app"] })])).toEqual({
      sid: "s1",
      label: "uno",
    });
  });

  it("another branch or another repo is a general item", () => {
    expect(sessionFor(ev!, [place({ branch: "main" }), place({ repos: ["acme/web"] })])).toBeNull();
  });
});

const GIT = {
  "git rev-parse --abbrev-ref HEAD @/w/app": ok("feat/7-cobro\n"),
  "git remote -v @/w/app": ok(
    "origin\tgit@github.com:acme/app.git (fetch)\norigin\tgit@github.com:acme/app.git (push)\n",
  ),
  "git rev-parse --abbrev-ref HEAD @/w/other": ok("main\n"),
  "git remote -v @/w/other": ok("origin\thttps://github.com/acme/app (fetch)\n"),
};

const harness = (o: { gh?: string | null; answers?: Parameters<typeof fakeRunner>[0]; dir?: string } = {}) => {
  let graphql = viewerJson([pr()]);
  const { runner, calls } = fakeRunner({
    "gh api graphql": () => ok(graphql),
    "gh auth status": ok("Logged in"),
    ...GIT,
    ...o.answers,
  });
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  let now = T0;
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "prwatch-"));
  const deps: PrWatchDeps = {
    runner,
    ghPath: () => (o.gh === undefined ? "/usr/bin/gh" : o.gh),
    sessions: () => [
      { sid: "s-app", label: "Cobro", cwd: "/w/app", lastActiveAt: 10 },
      { sid: "s-other", label: "Otra", cwd: "/w/other", lastActiveAt: 20 },
    ],
    dir,
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return { clear: () => void (t.cleared = true) };
    },
  };
  const TIMEOUTS = new Set([GH_TIMEOUT_MS + 1000, GIT_TIMEOUT_MS + 1000]);
  const pending = () => timers.filter((t) => !t.cleared && !TIMEOUTS.has(t.ms));
  return {
    deps,
    dir,
    calls,
    timers,
    pending,
    setGraphql: (s: string) => (graphql = s),
    tick: (ms: number) => (now += ms),
    gql: () => calls.filter((c) => c.args[1] === "graphql").length,
  };
};

describe("PrWatch: polling with the person's gh", () => {
  it("is off by default: no gh at all, except one cached `gh auth status` when Settings asks", async () => {
    const h = harness();
    const w = new PrWatch(h.deps);
    w.start();
    expect(h.pending()).toEqual([]);
    expect(await w.view()).toMatchObject({ enabled: false, state: "off", gh: null });
    expect(h.calls).toEqual([]);
    expect(await w.view(true)).toMatchObject({ enabled: false, state: "off", gh: "ready" });
    await w.view(true);
    expect(h.calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual(["auth status"]);
  });

  it("each event alerts once: the first poll learns, a new review is news once, a restart doesn't repeat it", async () => {
    const h = harness();
    const w = new PrWatch(h.deps);
    await w.configure({ enabled: true });
    expect(h.pending().at(-1)?.ms).toBe(0);
    h.setGraphql(viewerJson([pr({ commits: commit("bad", T0 - H, "FAILURE") })]));
    await w.poll();
    expect((await w.view()).events).toEqual([]);
    expect(h.pending().at(-1)?.ms).toBe(POLL_MS);

    h.tick(POLL_MS);
    h.setGraphql(
      viewerJson([
        pr({
          commits: commit("bad", T0 - H, "FAILURE"),
          reviewDecision: "CHANGES_REQUESTED",
          reviews: { nodes: [review("CHANGES_REQUESTED", T0 + 1000, "luis", 2)] },
        }),
      ]),
    );
    await w.poll();
    await w.poll();
    const v = await w.view();
    expect(v.events.map((e) => [e.kind, e.session])).toEqual([["changes_requested", { sid: "s-app", label: "Cobro" }]]);
    expect(v).toMatchObject({
      state: "ok",
      login: "me",
      prs: [{ number: 7, review: "changes_requested", ci: "failing" }],
    });

    const again = new PrWatch(h.deps);
    await again.poll();
    expect((await again.view()).events.map((e) => e.key)).toEqual(v.events.map((e) => e.key));
    expect(statSync(join(h.dir, "pr-watch.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(h.dir, "pr-watch.json"), "utf8")).not.toMatch(/token/i);

    h.setGraphql(viewerJson([pr({ commits: commit("bad2", T0 + H, "FAILURE") })]));
    await again.poll();
    expect((await again.view()).events.map((e) => e.kind)).toEqual(["ci_failed", "changes_requested"]);
  });

  it("news on a branch no session works is a general item", async () => {
    const h = harness();
    const w = new PrWatch(h.deps);
    await w.configure({ enabled: true });
    await w.poll();
    h.setGraphql(viewerJson([pr({ headRefName: "fix/otra", reviews: { nodes: [review("APPROVED", T0 + 1)] } })]));
    await w.poll();
    expect((await w.view()).events).toMatchObject([{ kind: "approved", session: null }]);
  });

  it("gh missing: a one-time state, no polling, and turning it on again retries", async () => {
    const h = harness({ gh: null });
    const w = new PrWatch(h.deps);
    await w.configure({ enabled: true });
    await w.poll();
    expect(await w.view()).toMatchObject({ enabled: true, state: "gh_missing", prs: [] });
    expect(h.pending()).toEqual([]);
    expect(h.calls).toEqual([]);
    await w.configure({ enabled: true });
    expect(h.pending().at(-1)?.ms).toBe(0);
  });

  it("gh signed out: stops polling instead of nagging", async () => {
    const h = harness({
      answers: {
        "gh api graphql": { code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" },
      },
    });
    const w = new PrWatch(h.deps);
    await w.configure({ enabled: true });
    await w.poll();
    expect((await w.view()).state).toBe("logged_out");
    expect(h.pending()).toEqual([]);
    await w.poll();
    expect(h.gql()).toBe(2);
  });

  it("other failures back off, doubling up to an hour, and a good answer resets to five minutes", async () => {
    const h = harness();
    const w = new PrWatch(h.deps);
    await w.configure({ enabled: true });
    h.setGraphql("{}");
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      await w.poll();
      delays.push(h.pending().at(-1)!.ms);
    }
    expect(delays).toEqual([2 * POLL_MS, 4 * POLL_MS, 8 * POLL_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
    expect((await w.view()).state).toBe("error");
    h.setGraphql(viewerJson([pr()]));
    await w.poll();
    expect(h.pending().at(-1)!.ms).toBe(POLL_MS);
  });

  it("turning it off stops the timer; the deny list hides a repo", async () => {
    const h = harness();
    const w = new PrWatch(h.deps);
    await w.configure({ enabled: true });
    await w.poll();
    expect(h.pending().at(-1)?.ms).toBe(POLL_MS);
    await w.configure({ deny: ["acme/*"] });
    expect(h.pending().at(-1)?.ms).toBe(0);
    await w.poll();
    expect((await w.view()).prs).toEqual([]);
    const off = await w.configure({ enabled: false });
    expect(off).toMatchObject({ enabled: false, state: "off", deny: ["acme/*"] });
    expect(h.pending()).toEqual([]);
  });

  it("a partial GraphQL answer (gh exits 1 for an SSO org) still shows and alerts the readable PRs", async () => {
    const h = harness();
    const body = JSON.parse(viewerJson([null, pr()])) as Record<string, unknown>;
    body.errors = [{ type: "FORBIDDEN", message: "Resource protected by organization SAML enforcement." }];
    h.deps.runner = {
      run: async (_c, args) =>
        args[1] === "graphql"
          ? {
              code: 1,
              stdout: JSON.stringify(body),
              stderr: "gh: Resource protected by organization SAML enforcement.",
            }
          : ok(""),
    };
    const w = new PrWatch(h.deps);
    await w.configure({ enabled: true });
    await w.poll();
    expect(await w.view()).toMatchObject({ state: "ok", prs: [{ number: 7 }] });
    expect(h.pending().at(-1)!.ms).toBe(POLL_MS);
  });

  it.each([
    ["gh exit 4", { code: 4, stdout: "", stderr: "" }],
    ["a revoked token", { code: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" }],
  ])("%s counts as signed out", async (_n, answer: RunResult) => {
    const h = harness({ answers: { "gh api graphql": answer } });
    const w = new PrWatch(h.deps);
    await w.configure({ enabled: true });
    await w.poll();
    expect((await w.view()).state).toBe("logged_out");
  });

  it("only ENOENT from the spawn means gh is missing; another spawn error backs off", async () => {
    const missing = harness({ answers: { "gh api graphql": { code: 127, stdout: "", stderr: "spawn gh ENOENT" } } });
    const a = new PrWatch(missing.deps);
    await a.configure({ enabled: true });
    await a.poll();
    expect((await a.view()).state).toBe("gh_missing");
    const busy = harness({ answers: { "gh api graphql": { code: 127, stdout: "", stderr: "spawn EAGAIN" } } });
    const b = new PrWatch(busy.deps);
    await b.configure({ enabled: true });
    await b.poll();
    expect((await b.view()).state).toBe("error");
    expect(busy.pending().at(-1)!.ms).toBe(2 * POLL_MS);
  });

  it("retrying after gh was missing works in one step and resets the backoff", async () => {
    let gh: string | null = null;
    const h = harness();
    h.deps.ghPath = () => gh;
    const w = new PrWatch(h.deps);
    await w.configure({ enabled: true });
    await w.poll();
    expect((await w.view()).state).toBe("gh_missing");
    gh = "/usr/bin/gh";
    await w.configure({ enabled: true });
    await w.poll();
    expect((await w.view()).state).toBe("ok");
    expect(h.pending().at(-1)!.ms).toBe(POLL_MS);
  });

  it("a hung gh times out into the backoff, and a second poll shares the one in flight", async () => {
    const h = harness();
    let graphqlCalls = 0;
    h.deps.runner = {
      run: (_c, args, opts) => {
        if (args[1] === "graphql") graphqlCalls++;
        expect(opts?.timeoutMs).toBe(GH_TIMEOUT_MS);
        return new Promise(() => undefined);
      },
    };
    const w = new PrWatch(h.deps);
    await w.configure({ enabled: true });
    const first = w.poll();
    const second = w.poll();
    expect(second).toBe(first);
    h.timers.find((t) => t.ms === GH_TIMEOUT_MS + 1000)!.fn();
    await first;
    expect(graphqlCalls).toBe(1);
    expect((await w.view()).state).toBe("error");
    expect(h.pending().at(-1)!.ms).toBe(2 * POLL_MS);
  });

  it("a hung or failing git only loses that session's link; the poll still finishes", async () => {
    const h = harness();
    const inner = h.deps.runner;
    h.deps.runner = {
      run: (cmd, args, opts) => {
        if (cmd === "git" && args[1] === "/w/other") return new Promise(() => undefined);
        if (cmd === "git" && args[1] === "/w/broken") return Promise.reject(new Error("boom"));
        return inner.run(cmd, args, opts);
      },
    };
    h.deps.sessions = () => [
      { sid: "s-app", label: "Cobro", cwd: "/w/app", lastActiveAt: 10 },
      { sid: "s-other", label: "Otra", cwd: "/w/other", lastActiveAt: 20 },
      { sid: "s-broken", label: "Rota", cwd: "/w/broken", lastActiveAt: 30 },
    ];
    const w = new PrWatch(h.deps);
    await w.configure({ enabled: true });
    await w.poll();
    h.setGraphql(viewerJson([pr({ reviews: { nodes: [review("APPROVED", T0 + 1)] } })]));
    const p = w.poll();
    await new Promise((r) => setTimeout(r, 0));
    for (const t of h.timers.filter((t) => t.ms === GIT_TIMEOUT_MS + 1000 && !t.cleared)) t.fn();
    await p;
    expect((await w.view()).events).toMatchObject([{ kind: "approved", session: { sid: "s-app" } }]);
    expect(h.pending().at(-1)!.ms).toBe(POLL_MS);
  });

  it("turning it off while a poll runs: the late answer is dropped, no timer comes back", async () => {
    const h = harness();
    let answer!: (r: RunResult) => void;
    h.deps.runner = {
      run: (_c, args) => (args[0] === "auth" ? Promise.resolve(ok("")) : new Promise((r) => (answer = r))),
    };
    const w = new PrWatch(h.deps);
    await w.configure({ enabled: true });
    const p = w.poll();
    await w.configure({ enabled: false });
    answer(ok(viewerJson([pr()])));
    await p;
    expect(await w.view()).toMatchObject({ state: "off", prs: [] });
    expect(h.pending()).toEqual([]);
  });

  it.each([
    ["the lists change", { deny: ["acme/x"] }],
    ["it is switched off and on", null],
  ])("when %s while a poll runs, the old answer is dropped and a fresh poll follows", async (_n, change) => {
    const h = harness();
    const answers: ((r: RunResult) => void)[] = [];
    h.deps.runner = {
      run: (_c, args) => (args[0] === "auth" ? Promise.resolve(ok("")) : new Promise((r) => answers.push(r))),
    };
    const w = new PrWatch(h.deps);
    await w.configure({ enabled: true });
    const first = w.poll();
    if (change) await w.configure(change);
    else {
      await w.configure({ enabled: false });
      await w.configure({ enabled: true });
    }
    // The change's own timer fires while the old poll is still out: it only gets that poll back.
    const own = h.pending().at(-1)!;
    own.cleared = true;
    own.fn();
    expect(h.pending()).toEqual([]);
    answers[0]!(ok(viewerJson([pr()])));
    await first;
    expect(answers).toHaveLength(1);
    expect(h.pending().at(-1)?.ms).toBe(0);
    h.pending().at(-1)!.fn();
    await new Promise((r) => setTimeout(r, 0));
    answers[1]!(ok(viewerJson([pr()])));
    await w.poll();
    expect((await w.view()).state).toBe("ok");
    expect(h.pending().at(-1)?.ms).toBe(POLL_MS);
  });

  it("a red CI still failing after the seen TTL is not told again; an old key no longer in play is pruned", async () => {
    const h = harness();
    const w = new PrWatch(h.deps);
    await w.configure({ enabled: true });
    h.setGraphql(
      viewerJson(
        [pr({ commits: commit("bad", T0 - H, "FAILURE") })],
        [pr({ number: 9, state: "MERGED", mergedAt: iso(T0 - H) })],
      ),
    );
    await w.poll();
    h.tick(SEEN_TTL_MS + H);
    h.setGraphql(viewerJson([pr({ commits: commit("bad", T0 - H, "FAILURE") })]));
    await w.poll();
    expect((await w.view()).events).toEqual([]);
    const seen = Object.keys(JSON.parse(readFileSync(join(h.dir, "pr-watch.json"), "utf8")).seen as object);
    expect(seen).toEqual(["pr:acme/app#7:ci_failed:bad"]);
  });

  it("changing the lists learns newly watched repos quietly but keeps news from repos already watched", async () => {
    const h = harness();
    const w = new PrWatch(h.deps);
    await w.configure({ enabled: true, deny: ["other/*"] });
    await w.poll();
    const other = pr({
      number: 3,
      url: "https://github.com/other/lib/pull/3",
      repository: { nameWithOwner: "other/lib" },
      reviews: { nodes: [review("APPROVED", T0 - H)] },
    });
    h.setGraphql(viewerJson([pr({ reviews: { nodes: [review("APPROVED", T0 + 1)] } }), other]));
    await w.configure({ deny: [] });
    await w.poll();
    expect((await w.view()).events.map((e) => [e.repo, e.kind])).toEqual([["acme/app", "approved"]]);
  });

  it("a corrupt file is set aside; a bad stored event keeps the switch and the lists", async () => {
    const h = harness();
    const file = join(h.dir, "pr-watch.json");
    writeFileSync(file, JSON.stringify({ v: 1, enabled: true, deny: ["acme/secret"], recent: [{ kind: "new_kind" }] }));
    const warns: string[] = [];
    h.deps.log = { warn: (m) => void warns.push(m) };
    expect(await new PrWatch(h.deps).view()).toMatchObject({ enabled: true, deny: ["acme/secret"], events: [] });
    expect(readFileSync(`${file}.bad`, "utf8")).toContain("new_kind");
    writeFileSync(file, "not json");
    expect(await new PrWatch(h.deps).view()).toMatchObject({ enabled: false });
    expect(warns).toEqual(["prs.load_failed", "prs.load_failed"]);
  });

  it("a switch that couldn't be saved says so", async () => {
    const h = harness({ dir: join(tmpdir(), "prwatch-missing-dir", String(Math.random())) });
    await expect(new PrWatch(h.deps).configure({ enabled: true })).rejects.toThrow("save_failed");
  });

  it("the Settings probe: missing, signed out or unknown, cached for its TTL", async () => {
    const none = harness({ gh: null });
    expect((await new PrWatch(none.deps).view(true)).gh).toBe("missing");
    const out = harness({
      answers: {
        "gh auth status": {
          code: 1,
          stdout: "",
          stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login",
        },
      },
    });
    const w = new PrWatch(out.deps);
    expect((await w.view(true)).gh).toBe("logged_out");
    await w.view(true);
    out.tick(PROBE_TTL_MS);
    await w.view(true);
    expect(out.calls.length).toBe(2);
    const offline = harness({
      answers: { "gh auth status": { code: 1, stdout: "", stderr: "error connecting to api.github.com" } },
    });
    expect((await new PrWatch(offline.deps).view(true)).gh).toBeNull();
  });

  it.skipIf(process.platform === "win32")("the real runner kills a child that outlives its timeout", async () => {
    const mark = join(mkdtempSync(join(tmpdir(), "prwatch-kill-")), "still-alive");
    const t = Date.now();
    const r = await spawnRunner.run("sh", ["-c", `sleep 0.4; touch '${mark}'`], { timeoutMs: 100 });
    expect(r.code).toBe(124);
    expect(Date.now() - t).toBeLessThan(400);
    await new Promise((res) => setTimeout(res, 700));
    expect(existsSync(mark)).toBe(false);
    expect((await spawnRunner.run("true", [], { timeoutMs: 1000 })).code).toBe(0);
  });

  it.skipIf(process.platform === "win32")("finds gh beyond a login service's short PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "prwatch-home-"));
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "gh"), "#!/bin/sh\n", { mode: 0o755 });
    expect(findGh({ PATH: "/nowhere", HOME: home }, "linux")).toBe(join(home, ".local", "bin", "gh"));
  });
});
