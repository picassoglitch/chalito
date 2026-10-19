import { describe, expect, it } from "vitest";
import {
  COORD_RULE_TTL_MS,
  CommandBody,
  CoordPlanState,
  CoordTaskSpec,
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
    expect(ruleMatchText({ kind: "command", workspaceLabel: "taquito", program: "psql", sub: "" })).toBe(
      "chalito.coordrule.match.v1\ncommand\ntaquito\npsql\n",
    );
    expect(ruleMatchText({ kind: "web", workspaceLabel: "taquito", domain: "API.Stripe.com" })).toBe(
      "chalito.coordrule.match.v1\nweb\ntaquito\napi.stripe.com",
    );
  });

  it("refuses a value with a newline, so two matches can't hash the same", () => {
    expect(ruleMatchText({ kind: "command", workspaceLabel: "a\ncommand", program: "x", sub: "" })).toBeNull();
    expect(ruleMatchText({ kind: "command", workspaceLabel: "a", program: "x\ty", sub: "" })).toBeNull();
  });
});

describe("rememberMatchFor", () => {
  const w = "taquito";
  const bash = (command: string) => rememberMatchFor({ toolName: "Bash", input: { command }, workspaceLabel: w });

  it("reads a simple command as program + subcommand", () => {
    expect(bash("supabase db push")).toEqual({
      kind: "command",
      workspaceLabel: w,
      program: "supabase",
      sub: "db push",
    });
    expect(bash("psql -c x")).toEqual({ kind: "command", workspaceLabel: w, program: "psql", sub: "" });
    expect(bash("gh pr create --fill")).toEqual({
      kind: "command",
      workspaceLabel: w,
      program: "gh",
      sub: "pr create",
    });
    expect(bash("cp a b c")).toEqual({ kind: "command", workspaceLabel: w, program: "cp", sub: "a b" });
    expect(bash("  curl https://api.example.com/x  ")).toEqual({
      kind: "command",
      workspaceLabel: w,
      program: "curl",
      sub: "https://api.example.com/x",
    });
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
    for (const p of [
      { type: "coord.approve", planId: "pabcdef12" },
      { type: "coord.stop", planId: "pabcdef12" },
      { type: "coord.merge", planId: "pabcdef12" },
    ])
      expect(CommandBody.safeParse(body(p)).success, p.type).toBe(true);
    expect(CommandBody.safeParse(body({ type: "coord.approve", planId: "../x" })).success).toBe(false);
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
