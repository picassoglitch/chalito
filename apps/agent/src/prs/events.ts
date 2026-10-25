import { z } from "zod";

// Adapted from Alux by Omar (homiomar), pet/prs.js, without its one-org filter: every repo the
// person has PRs in counts, narrowed only by their own allow/deny list (owner, 2026-10-25).

const FIELDS = `nodes{number url title isDraft state mergedAt headRefName updatedAt reviewDecision
repository{nameWithOwner} headRepository{nameWithOwner}
commits(last:1){nodes{commit{oid committedDate statusCheckRollup{state}}}}
reviews(last:30){nodes{author{login __typename} submittedAt state comments{totalCount}}}}`;

/** The person's open PRs and latest merges, asked apart so many merges never hide an open one. Read-only. */
export const PR_QUERY = `query{viewer{login
open:pullRequests(states:OPEN,first:50,orderBy:{field:UPDATED_AT,direction:DESC}){${FIELDS}}
merged:pullRequests(states:MERGED,first:20,orderBy:{field:UPDATED_AT,direction:DESC}){${FIELDS}}}}`;

const Review = z.object({
  author: z.object({ login: z.string(), __typename: z.string().optional() }).nullable(),
  submittedAt: z.string().nullable(),
  state: z.string(),
  comments: z.object({ totalCount: z.number() }).nullish(),
});
const Pr = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  isDraft: z.boolean(),
  state: z.string(),
  mergedAt: z.string().nullish(),
  headRefName: z.string(),
  updatedAt: z.string().nullish(),
  reviewDecision: z.string().nullish(),
  repository: z.object({ nameWithOwner: z.string() }),
  headRepository: z.object({ nameWithOwner: z.string() }).nullish(),
  commits: z
    .object({
      nodes: z.array(
        z.object({
          commit: z.object({
            oid: z.string(),
            committedDate: z.string().nullish(),
            statusCheckRollup: z.object({ state: z.string() }).nullish(),
          }),
        }),
      ),
    })
    .nullish(),
  reviews: z.object({ nodes: z.array(Review) }).nullish(),
});
export const Viewer = z.object({
  login: z.string(),
  open: z.object({ nodes: z.array(Pr.nullable()) }),
  merged: z.object({ nodes: z.array(Pr.nullable()) }),
});
export type Viewer = z.infer<typeof Viewer>;
type PrNode = z.infer<typeof Pr>;

const Shell = z.object({
  login: z.string(),
  open: z.object({ nodes: z.array(z.unknown()) }),
  merged: z.object({ nodes: z.array(z.unknown()) }),
});

export type ParsedViewer =
  | { ok: true; viewer: Viewer; skipped: number; errors: string[] }
  | { ok: false; reason: "json" | "no_data"; errors: string[] };

/** `gh api graphql` stdout → the viewer. Partial answers count (an SSO-protected org gives null nodes
 * plus `errors`); a node that doesn't fit is skipped, not fatal. */
export const parseViewer = (stdout: string): ParsedViewer => {
  let body: { data?: { viewer?: unknown }; errors?: { message?: unknown }[] };
  try {
    body = JSON.parse(stdout) as typeof body;
  } catch {
    return { ok: false, reason: "json", errors: [] };
  }
  const errors = (Array.isArray(body?.errors) ? body.errors : []).map((e) => String(e?.message ?? "")).slice(0, 5);
  const shell = Shell.safeParse(body?.data?.viewer);
  if (!shell.success) return { ok: false, reason: "no_data", errors };
  let skipped = 0;
  const keep = (nodes: unknown[]) =>
    nodes.flatMap((n) => {
      if (n === null) return [];
      const r = Pr.safeParse(n);
      if (!r.success) skipped++;
      return r.success ? [r.data] : [];
    });
  const v = shell.data;
  return {
    ok: true,
    viewer: { login: v.login, open: { nodes: keep(v.open.nodes) }, merged: { nodes: keep(v.merged.nodes) } },
    skipped,
    errors,
  };
};

export type PrEventKind = "approved" | "changes_requested" | "comments" | "ci_failed" | "ci_passed" | "merged";

export interface PrRef {
  repo: string;
  number: number;
  url: string;
  title: string;
  branch: string;
  /** Where the branch lives when it is a fork; null when the fork is gone. */
  headRepo: string | null;
}

export interface PrEvent extends PrRef {
  kind: PrEventKind;
  /** Once per event: the key carries the review time or the commit sha. */
  key: string;
  /** Epoch ms of the review, merge or commit. */
  at: number;
  by?: string;
  sha?: string;
  /** Review comments left since the last commit. */
  comments?: number;
}

export interface PrStatus extends PrRef {
  draft: boolean;
  review: "approved" | "changes_requested" | "review_required" | null;
  ci: "passing" | "failing" | "pending" | null;
  comments: number;
  updatedAt: number;
}

export interface RepoFilter {
  allow: readonly string[];
  deny: readonly string[];
}

/** `owner/repo` or `owner/*`, any case. Deny wins; an empty allow list means every repo. */
export const repoAllowed = (repo: string, f: RepoFilter): boolean => {
  const r = repo.toLowerCase();
  const hit = (p: string) => {
    const q = p.toLowerCase();
    return q.endsWith("/*") ? r.startsWith(q.slice(0, -1)) : r === q;
  };
  if (f.deny.some(hit)) return false;
  return f.allow.length === 0 || f.allow.some(hit);
};

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

const ref = (p: PrNode): PrRef => ({
  repo: p.repository.nameWithOwner,
  number: p.number,
  url: p.url,
  title: p.title,
  branch: p.headRefName,
  headRepo: p.headRepository?.nameWithOwner ?? null,
});

const prsOf = (v: Viewer, f: RepoFilter): PrNode[] =>
  [...v.open.nodes, ...v.merged.nodes].filter(
    (p): p is PrNode => p !== null && repoAllowed(p.repository.nameWithOwner, f),
  );

const reading = (v: Viewer, p: PrNode) => {
  const human = (r: z.infer<typeof Review>) =>
    r.author !== null && r.author.login !== v.login && r.author.__typename !== "Bot" && r.submittedAt !== null;
  const reviews = (p.reviews?.nodes ?? []).filter(human);
  const commit = p.commits?.nodes.at(-1)?.commit ?? null;
  const pushedAt = ms(commit?.committedDate);
  const decisive = reviews.filter((r) => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED").at(-1) ?? null;
  const comments = reviews
    .filter((r) => ms(r.submittedAt) > pushedAt)
    .reduce((n, r) => n + (r.comments?.totalCount ?? 0), 0);
  return { reviews, commit, pushedAt, decisive, comments, rollup: commit?.statusCheckRollup?.state ?? null };
};

/** Open PRs for the panel list, drafts included. */
export const prStatuses = (v: Viewer, f: RepoFilter): PrStatus[] =>
  prsOf(v, f)
    .filter((p) => p.state === "OPEN")
    .map((p) => {
      const { decisive, comments, rollup } = reading(v, p);
      // GitHub's own decision when the repo has one; the latest decisive review only where it has none.
      const decision = p.reviewDecision ?? (decisive ? decisive.state : null);
      const review =
        decision === "APPROVED"
          ? "approved"
          : decision === "CHANGES_REQUESTED"
            ? "changes_requested"
            : decision === "REVIEW_REQUIRED"
              ? "review_required"
              : null;
      const ci =
        rollup === "SUCCESS"
          ? "passing"
          : rollup === "FAILURE" || rollup === "ERROR"
            ? "failing"
            : rollup
              ? "pending"
              : null;
      return { ...ref(p), draft: p.isDraft, review, ci, comments, updatedAt: ms(p.updatedAt) };
    });

export const DEFAULT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** News about the person's PRs. CI results are keyed by sha, so a re-run on an old commit still counts;
 * reviews and merges only while younger than `maxAgeMs`. */
export const prEvents = (v: Viewer, f: RepoFilter, now: number, maxAgeMs = DEFAULT_MAX_AGE_MS): PrEvent[] => {
  const out: Omit<PrEvent, "key">[] = [];
  for (const p of prsOf(v, f)) {
    const base = ref(p);
    if (p.state === "MERGED") {
      if (p.mergedAt) out.push({ ...base, kind: "merged", at: ms(p.mergedAt) });
      continue;
    }
    if (p.isDraft || p.state !== "OPEN") continue;
    const { reviews, commit, pushedAt, decisive, comments, rollup } = reading(v, p);
    if (decisive)
      out.push({
        ...base,
        kind: decisive.state === "APPROVED" ? "approved" : "changes_requested",
        by: decisive.author!.login,
        at: ms(decisive.submittedAt),
        comments,
      });
    // Most review rounds come as plain comments: one left after the last push and decision is news.
    const note = reviews.filter((r) => r.state === "COMMENTED").at(-1);
    if (note && ms(note.submittedAt) > Math.max(pushedAt, ms(decisive?.submittedAt)))
      out.push({ ...base, kind: "comments", by: note.author!.login, at: ms(note.submittedAt), comments });
    if (commit && (rollup === "FAILURE" || rollup === "ERROR"))
      out.push({ ...base, kind: "ci_failed", sha: commit.oid, at: pushedAt });
    if (commit && rollup === "SUCCESS") out.push({ ...base, kind: "ci_passed", sha: commit.oid, at: pushedAt });
  }
  return out
    .filter((e) => e.kind === "ci_failed" || e.kind === "ci_passed" || now - e.at < maxAgeMs)
    .map((e) => ({ ...e, key: `pr:${e.repo}#${e.number}:${e.kind}:${e.sha ?? e.at}` }));
};
