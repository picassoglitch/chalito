import type { ProcessRunner, RunResult } from "../src/runner.js";

/** GraphQL nodes shaped like `gh api graphql` returns them for PR_QUERY. */
export const T0 = Date.parse("2026-10-25T12:00:00Z");
export const iso = (ms: number) => new Date(ms).toISOString();
export const H = 60 * 60 * 1000;

export const review = (state: string, at: number, login = "ana", comments = 0, typename = "User") => ({
  author: { login, __typename: typename },
  submittedAt: iso(at),
  state,
  comments: { totalCount: comments },
});

export const pr = (o: Record<string, unknown> = {}) => ({
  number: 7,
  url: "https://github.com/acme/app/pull/7",
  title: "Cobro recurrente",
  isDraft: false,
  state: "OPEN",
  mergedAt: null,
  headRefName: "feat/7-cobro",
  updatedAt: iso(T0 - H),
  reviewDecision: "REVIEW_REQUIRED",
  repository: { nameWithOwner: "acme/app" },
  headRepository: { nameWithOwner: "acme/app" },
  commits: { nodes: [{ commit: { oid: "a1", committedDate: iso(T0 - 5 * H), statusCheckRollup: null } }] },
  reviews: { nodes: [] },
  ...o,
});

export const commit = (oid: string, at: number, rollup: string | null) => ({
  nodes: [{ commit: { oid, committedDate: iso(at), statusCheckRollup: rollup ? { state: rollup } : null } }],
});

export const viewerJson = (open: unknown[], merged: unknown[] = [], login = "me") =>
  JSON.stringify({ data: { viewer: { login, open: { nodes: open }, merged: { nodes: merged } } } });

type Answer = RunResult | ((args: string[]) => RunResult);

/** Answers `gh` and `git` by their first arguments; records every call. */
export const fakeRunner = (answers: Record<string, Answer>) => {
  const calls: { cmd: string; args: string[] }[] = [];
  const runner: ProcessRunner = {
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      const key = cmd.endsWith("git")
        ? `git ${args.slice(2).join(" ")} @${args[1]}`
        : `gh ${args.slice(0, 2).join(" ")}`;
      const a = answers[key] ?? answers[key.split(" @")[0]!];
      if (!a) return { code: 1, stdout: "", stderr: `no answer for ${key}` };
      return typeof a === "function" ? a(args) : a;
    },
  };
  return { runner, calls };
};

export const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
