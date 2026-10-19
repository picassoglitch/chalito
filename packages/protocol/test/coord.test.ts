import { describe, expect, it } from "vitest";
import {
  COORD_RULE_TTL_MS,
  CommandBody,
  CoordPlanState,
  CoordTaskSpec,
  ApprovalDetails,
  SignedCoordPlan,
  planDigestInput,
  RelayedCommand,
  CoordRule,
  CoordRuleBody,
  CoordRuleRevoke,
  SigningContext,
  rememberMatchFor,
  ruleMatchText,
} from "../src/index.js";

const body = {
  v: 1,
  ruleId: "cr_abcdefgh",
  uid: "u1",
  match: "a".repeat(64),
  createdAt: 1_000,
  expiresAt: 1_000 + 24 * 60 * 60 * 1000,
};

describe("coordinator rules (ADR 0025 §6)", () => {
  it("has its own signing context", () => {
    expect(SigningContext.options).toContain("chalito.coordrule.v1");
  });

  it("parses a signed rule and refuses any other context", () => {
    const env = { ctx: "chalito.coordrule.v1", body, signerDeviceId: "dev_p", sig: "A".repeat(86) };
    expect(CoordRule.safeParse(env).success).toBe(true);
    expect(CoordRule.safeParse({ ...env, ctx: "chalito.decision.v1" }).success).toBe(false);
  });

  it("caps a rule's life at 90 days and refuses one that ends before it starts", () => {
    expect(CoordRuleBody.safeParse({ ...body, expiresAt: body.createdAt + COORD_RULE_TTL_MS }).success).toBe(true);
    expect(CoordRuleBody.safeParse({ ...body, expiresAt: body.createdAt + COORD_RULE_TTL_MS + 1 }).success).toBe(false);
    expect(CoordRuleBody.safeParse({ ...body, expiresAt: body.createdAt }).success).toBe(false);
  });

  it("carries only the hash: no extra plaintext fields", () => {
    expect(CoordRuleBody.safeParse({ ...body, program: "psql" }).success).toBe(false);
    expect(CoordRuleBody.safeParse({ ...body, match: "psql" }).success).toBe(false);
  });

  it("builds one canonical text per match, lowercasing domains", () => {
    expect(ruleMatchText({ kind: "command", workspaceLabel: "taquito", argv: ["psql", "-c", "x"] })).toBe(
      "chalito.coordrule.match.v2\ncommand\ntaquito\n3\npsql\n-c\nx",
    );
    expect(ruleMatchText({ kind: "web", workspaceLabel: "taquito", domain: "API.Stripe.com" })).toBe(
      "chalito.coordrule.match.v2\nweb\ntaquito\napi.stripe.com",
    );
  });

  it("refuses a value with a newline, so two matches can't hash the same", () => {
    expect(ruleMatchText({ kind: "command", workspaceLabel: "a\ncommand", argv: ["x"] })).toBeNull();
    expect(ruleMatchText({ kind: "command", workspaceLabel: "a", argv: ["x\ty"] })).toBeNull();
  });
});

describe("rememberMatchFor", () => {
  const w = "taquito";
  const bash = (command: string) => rememberMatchFor({ toolName: "Bash", input: { command }, workspaceLabel: w });

  it("reads a simple command as its exact words", () => {
    expect(bash("git commit -m wip")).toEqual({
      kind: "command",
      workspaceLabel: w,
      argv: ["git", "commit", "-m", "wip"],
    });
    expect(bash("  pnpm test  ")).toEqual({ kind: "command", workspaceLabel: w, argv: ["pnpm", "test"] });
  });

  it("never remembers a compound, quoted, expanded or redirected command", () => {
    for (const c of [
      "git add -A && rm -rf x",
      "ls; rm x",
      "cat a | sh",
      'psql -c "drop table x"',
      "echo $HOME",
      "echo `id`",
      "ls > out",
      "rm *",
      "FOO=1 make",
      "ls ~",
      "",
    ])
      expect(bash(c), c).toBeNull();
  });

  it("reads a web fetch as its host, lowercased", () => {
    expect(
      rememberMatchFor({ toolName: "WebFetch", input: { url: "https://API.Stripe.com/v1" }, workspaceLabel: w }),
    ).toEqual({ kind: "web", workspaceLabel: w, domain: "api.stripe.com" });
    expect(rememberMatchFor({ toolName: "WebFetch", input: { url: "nope" }, workspaceLabel: w })).toBeNull();
  });

  it("remembers nothing else", () => {
    expect(rememberMatchFor({ toolName: "Edit", input: { file_path: "/x" }, workspaceLabel: w })).toBeNull();
    expect(rememberMatchFor({ toolName: "mcp__x__y", input: {}, workspaceLabel: w })).toBeNull();
    expect(rememberMatchFor({ toolName: "Bash", input: null, workspaceLabel: w })).toBeNull();
  });
});

describe("rule withdrawals", () => {
  it("has its own signing context and a strict body", () => {
    expect(SigningContext.options).toContain("chalito.coordrule-revoke.v1");
    const env = {
      ctx: "chalito.coordrule-revoke.v1",
      body: { v: 1, uid: "u1", ruleId: "cr_abcdefgh", revokedAt: 5 },
      signerDeviceId: "dev_p",
      sig: "A".repeat(86),
    };
    expect(CoordRuleRevoke.safeParse(env).success).toBe(true);
    expect(CoordRuleRevoke.safeParse({ ...env, ctx: "chalito.coordrule.v1" }).success).toBe(false);
    expect(CoordRuleRevoke.safeParse({ ...env, body: { ...env.body, extra: 1 } }).success).toBe(false);
  });
});

describe("coordinator commands and plan state (G2)", () => {
  const body = (payload: unknown, origin = "client:dev_p") => ({
    v: 1,
    cid: "c1",
    uid: "u1",
    targetDeviceId: "dev_a",
    origin,
    nonce: "A".repeat(22),
    issuedAt: 1,
    expiresAt: 2,
    payload,
  });
  const goalCt = {
    alg: "xchacha20poly1305+sealedbox",
    nonce: "A".repeat(32),
    ct: "AAAA",
    keys: { dev_a: "A".repeat(107) },
  };

  it("parses the four commands with no defaults filled in (the signature covers the parsed body)", () => {
    const start = CommandBody.safeParse(body({ type: "coord.start", workspaceLabel: "p", goalCt }));
    expect(start.success).toBe(true);
    expect(start.data!.payload).not.toHaveProperty("maxAgents");
    expect(start.data!.payload).not.toHaveProperty("maxMinutes");
    const digest = "a".repeat(64);
    for (const p of [
      { type: "coord.approve", planId: "pabcdef12", digest },
      { type: "coord.stop", planId: "pabcdef12" },
      { type: "coord.merge", planId: "pabcdef12", digest },
    ])
      expect(CommandBody.safeParse(body(p)).success, p.type).toBe(true);
    expect(CommandBody.safeParse(body({ type: "coord.approve", planId: "../x", digest })).success).toBe(false);
    // Security review: approve and merge name the exact plan they're about.
    expect(CommandBody.safeParse(body({ type: "coord.approve", planId: "pabcdef12" })).success).toBe(false);
    expect(CommandBody.safeParse(body({ type: "coord.merge", planId: "pabcdef12", digest: "xyz" })).success).toBe(
      false,
    );
    expect(
      CommandBody.safeParse(body({ type: "coord.start", workspaceLabel: "p", goalCt, base: "--upload-pack=x" }))
        .success,
    ).toBe(false);
    expect(
      CommandBody.safeParse(body({ type: "coord.start", workspaceLabel: "p", goalCt, base: "a..b" })).success,
    ).toBe(false);
  });

  it("no relay carries a coord.* command", () => {
    for (const [relayedBy, origin] of [
      ["mcp-gateway", "mcp:claude"],
      ["notifier", `call:CA${"a".repeat(32)}`],
      ["a2a-server", "a2a:x"],
    ] as const)
      expect(
        RelayedCommand.safeParse({ relayedBy, body: body({ type: "coord.stop", planId: "pabcdef12" }, origin) })
          .success,
      ).toBe(false);
  });

  it("validates a planner's task and the sealed plan state", () => {
    expect(CoordTaskSpec.safeParse({ id: "a", title: "A", brief: "b", acceptance: ["x"] }).success).toBe(true);
    expect(CoordTaskSpec.safeParse({ id: "A B", title: "A", brief: "b", acceptance: ["x"] }).success).toBe(false);
    expect(CoordTaskSpec.safeParse({ id: "a", title: "A", brief: "b", acceptance: [] }).success).toBe(false);
    expect(CoordPlanState.safeParse({ v: 1 }).success).toBe(false);
  });
});

describe("signed plans and tap digests (security review)", () => {
  const state = {
    v: 1,
    planId: "pabcdef12",
    goal: "g",
    workspaceLabel: "w",
    base: "main",
    status: "awaiting_approval",
    maxAgents: 3,
    maxMinutes: 120,
    startedAt: null,
    tasks: [
      {
        id: "a",
        title: "A",
        acceptance: ["x"],
        dependsOn: [],
        status: "pending",
        branch: "coord/pabcdef12/a",
        sid: null,
        note: "agent text",
        reviewRounds: 0,
      },
    ],
    integration: { branch: "coord/pabcdef12/integration", sid: null, note: null, head: null },
    note: null,
    updatedAt: 1,
  } as const;

  it("the plan travels signed by the agent", () => {
    expect(SigningContext.options).toContain("chalito.coordplan.v1");
    const env = { ctx: "chalito.coordplan.v1", body: state, signerDeviceId: "dev_a", sig: "A".repeat(86) };
    expect(SignedCoordPlan.safeParse(env).success).toBe(true);
    expect(SignedCoordPlan.safeParse({ ...env, ctx: "chalito.coordrule.v1" }).success).toBe(false);
  });

  it("the approve digest covers what the owner approves, not progress; merge adds the integration commit", () => {
    const p = CoordPlanState.parse(state);
    const a = planDigestInput(p, "approve");
    expect(a).not.toHaveProperty("integration");
    expect(JSON.stringify(a)).not.toContain("agent text");
    expect(planDigestInput({ ...p, updatedAt: 99, status: "running" }, "approve")).toEqual(a);
    expect(planDigestInput({ ...p, goal: "other" }, "approve")).not.toEqual(a);
    const m = planDigestInput({ ...p, integration: { ...p.integration, head: "b".repeat(40) } }, "merge");
    expect(m).toMatchObject({ kind: "merge", integration: { head: "b".repeat(40) } });
  });

  it("approval details may carry the helper's workspace label", () => {
    const d = { v: 1, summary: "x", origin: "agent:coord_pabcdef12", workspaceLabel: "taquito" };
    expect(ApprovalDetails.parse(d).workspaceLabel).toBe("taquito");
    const { workspaceLabel: _w, ...plain } = d;
    expect(ApprovalDetails.parse(plain)).not.toHaveProperty("workspaceLabel");
  });
});

describe("security review: a remembered command is exactly that command", () => {
  const w = "taquito";
  const m = (command: string) => rememberMatchFor({ toolName: "Bash", input: { command }, workspaceLabel: w });

  it("binds every word, options included", () => {
    expect(m("pnpm test")).toEqual({ kind: "command", workspaceLabel: w, argv: ["pnpm", "test"] });
    const text = (c: string) => ruleMatchText(m(c)!);
    expect(text("pnpm test")).not.toBe(text("pnpm test --filter api"));
    expect(text("git log")).not.toBe(text("git log -5"));
    expect(text("eslint src")).not.toBe(text("eslint src --fix"));
  });

  it("never remembers a command run through a wrapper or a path", () => {
    for (const c of [
      "npx foo --x",
      "pnpm exec foo",
      "pnpm dlx foo",
      "npm exec foo",
      "npm x foo",
      "yarn dlx foo",
      "bunx foo",
      "bun x foo",
      "uvx foo",
      "uv run foo",
      "pipx run foo",
      "sh -c ls",
      "bash -c ls",
      "env FOO=1 ls",
      "node -e 1",
      "python -c 1",
      "python3 script.py",
      "xargs rm",
      "sudo ls",
      "timeout 5 ls",
      "nohup ls",
      "./deploy.sh",
      "/usr/bin/psql -c x",
      "scripts/run",
    ])
      expect(m(c), c).toBeNull();
  });

  it("the match text can't be confused between word lists", () => {
    expect(ruleMatchText({ kind: "command", workspaceLabel: w, argv: ["a b"] })).not.toBe(
      ruleMatchText({ kind: "command", workspaceLabel: w, argv: ["a", "b"] }),
    );
  });
});

describe("security review: only known-safe programs can be remembered (allowlist)", () => {
  const w = "taquito";
  const m = (command: string) => rememberMatchFor({ toolName: "Bash", input: { command }, workspaceLabel: w });

  it("test runners by their explicit forms, linters, formatters and read/commit git", () => {
    for (const c of [
      "pnpm test",
      "pnpm test --filter api",
      "npm test",
      "npm run lint",
      "yarn lint",
      "pytest -q tests/api",
      "cargo test",
      "go test ./...",
      "eslint src",
      "prettier --check .",
      "ruff check .",
      "tsc --noEmit",
      "git status",
      "git diff --stat",
      "git log -5",
      "git add src/a.ts",
      "git commit -m wip",
    ])
      expect(m(c), c).not.toBeNull();
  });

  it("everything else asks every time, however it's spelled", () => {
    for (const c of [
      "python3.12 -c 1",
      "NODE -e 1",
      "Npx foo",
      "pnpm dev",
      "pnpm deploy",
      "npm run deploy",
      "yarn start",
      "make deploy",
      "just release",
      "rake db:migrate",
      "task build",
      "git -c core.pager=x status",
      "git --exec-path=/tmp status",
      "git push origin main",
      "git reset --hard",
      "supabase db push",
      "psql -c x",
      "curl https://x.com",
      "./eslint src",
      "node_modules/.bin/eslint src",
    ])
      expect(m(c), c).toBeNull();
  });

  it("normalizes the program's case", () => {
    expect(m("ESLint src")).toEqual({ kind: "command", workspaceLabel: w, argv: ["eslint", "src"] });
  });
});
