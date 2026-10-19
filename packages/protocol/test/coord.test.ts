import { describe, expect, it } from "vitest";
import {
  COORD_RULE_TTL_MS,
  CoordRule,
  CoordRuleBody,
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
