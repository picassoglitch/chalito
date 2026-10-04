/**
 * Review R-C1 (docs/reviews/beta-security-review.md): unsigned turns (an MCP `prompt_session`,
 * a phone answer) may read on their own and nothing more. Before the fix, an `mcp:`/`call:`
 * turn in an `acceptEdits` session could edit package.json (MED, accept_edits) and then run
 * `npm test` (LOW, allowlist): code execution without the phone.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DevModeToggle, Origin, RemotePermissionMode } from "@chalito/protocol";
import { DEFAULT_POLICY, DEVMODE_OFF, classifyToolCall, decide, type DevModeState } from "../src/policy/index.js";

const HOME = "/home/aldo";
const WS = "/home/aldo/code/chalito";
const ctx = () => ({
  policy: { ...DEFAULT_POLICY, workspaces: [{ label: "chalito", path: WS }] },
  home: HOME,
  cwd: WS,
  realpath: (x: string) => x,
});
const UNSIGNED: Origin[] = ["mcp:claude", "mcp:chatgpt", `call:CA${"a".repeat(32)}`];
const gate = (
  toolName: string,
  input: Record<string, unknown>,
  origin: Origin,
  permissionMode: RemotePermissionMode | "local_only" = "acceptEdits",
  devMode: DevModeState = DEVMODE_OFF,
) => {
  const c = classifyToolCall(toolName, input, ctx());
  return { c, d: decide({ classification: c, origin, originAllowed: true, devMode, permissionMode }) };
};

describe("R-C1 regression: the edit-then-test chain", () => {
  for (const origin of UNSIGNED) {
    it(`${origin}: editing package.json and running npm test both ask the phone`, () => {
      expect(gate("Edit", { file_path: `${WS}/package.json`, old_string: "a", new_string: "b" }, origin).d.action).toBe(
        "ask",
      );
      expect(gate("Bash", { command: "npm test" }, origin).d.action).toBe("ask");
    });
    it(`${origin}: even a plain workspace edit asks under acceptEdits`, () => {
      expect(gate("Edit", { file_path: `${WS}/src/login.ts`, old_string: "a", new_string: "b" }, origin).d).toEqual({
        action: "ask",
        stepUp: false,
      });
    });
    it(`${origin}: reads still run on their own`, () => {
      expect(gate("Read", { file_path: `${WS}/package.json` }, origin).d.action).toBe("allow");
      expect(gate("Grep", { pattern: "login", path: WS }, origin).d.action).toBe("allow");
      expect(gate("Bash", { command: "ls tests && cat package.json | jq .scripts" }, origin).d.action).toBe("allow");
    });
  }

  it("signed origins keep accept_edits and the allowlist, but manifest edits are HIGH (step-up)", () => {
    const client: Origin = "client:dev_phone";
    expect(gate("Edit", { file_path: `${WS}/src/login.ts`, old_string: "a", new_string: "b" }, client).d).toEqual({
      action: "allow",
      via: "accept_edits",
    });
    expect(gate("Bash", { command: "npm test" }, client).d).toEqual({ action: "allow", via: "policy_auto_allow" });
    expect(gate("Edit", { file_path: `${WS}/package.json`, old_string: "a", new_string: "b" }, client).d).toEqual({
      action: "ask",
      stepUp: true,
    });
  });
});

describe("build/test manifests and test code: editing them is HIGH, reading them isn't", () => {
  const edited = [
    "package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "package-lock.json",
    ".npmrc",
    "Makefile",
    "pyproject.toml",
    "setup.cfg",
    "setup.py",
    "conftest.py",
    "tox.ini",
    "vitest.config.ts",
    "jest.config.js",
    "playwright.config.mjs",
    "eslint.config.cjs",
    "Cargo.toml",
    "go.mod",
    "Gemfile",
    "build.gradle",
    "packages/app/package.json",
    "test/helpers.ts",
    "tests/fixtures/data.json",
    "src/__tests__/login.ts",
    "src/login.test.ts",
    "src/login.spec.tsx",
    "pkg/login_test.go",
    "tests_dir/test_login.py",
    "spec/login_spec.rb",
  ];
  it.each(edited)("%s", (rel) => {
    const { c } = gate("Write", { file_path: `${WS}/${rel}`, content: "x" }, "client:dev_phone");
    expect(c.tier).toBe("HIGH");
    expect(c.workspaceEdit).toBe(false);
    expect(gate("Read", { file_path: `${WS}/${rel}` }, "client:dev_phone").c.tier).toBe("LOW");
  });
  it("shell writes into them are HIGH too", () => {
    expect(gate("Bash", { command: "echo x > package.json" }, "client:dev_phone").c.tier).toBe("HIGH");
    expect(gate("Bash", { command: "echo x >> tests/setup.ts" }, "client:dev_phone").c.tier).toBe("HIGH");
  });
  it("ordinary sources stay MED", () => {
    for (const rel of ["src/login.ts", "README.md", "docs/test-plan.md", "src/contest.ts"])
      expect(gate("Write", { file_path: `${WS}/${rel}`, content: "x" }, "client:dev_phone").c.tier).toBe("MED");
  });
});

// ---- properties ---------------------------------------------------------------------------

const origin = fc.constantFrom(...UNSIGNED);
const mode = fc.constantFrom<RemotePermissionMode | "local_only">("default", "plan", "acceptEdits", "local_only");
const devMode = fc
  .subarray<DevModeToggle>(["allowSudo", "autoApproveHigh", "autoApproveCritical", "bypassStyle"])
  .chain((toggles) => fc.boolean().map((on): DevModeState => ({ on, toggles, since: on ? 1 : null })));
const seg = fc.stringMatching(/^[a-z][a-z0-9_-]{0,7}$/);
const relPath = fc
  .tuple(fc.array(seg, { maxLength: 3 }), seg, fc.constantFrom("ts", "js", "json", "py", "md", "go", "toml", "yml"))
  .map(([dirs, name, ext]) => [...dirs, `${name}.${ext}`].join("/"));
const manifest = fc.constantFrom("package.json", "Makefile", "pyproject.toml", "vitest.config.ts", "tests/a.ts");
const anyPath = fc.oneof(relPath, manifest).map((p) => `${WS}/${p}`);

/** Tool calls that are never a read: edits, runners, writes, subagents, external effects. */
const nonRead = fc.oneof(
  fc
    .tuple(fc.constantFrom("Edit", "MultiEdit", "Write", "NotebookEdit"), anyPath)
    .map(([t, p]) => [t, { file_path: p, notebook_path: p, old_string: "a", new_string: "b", content: "x" }] as const),
  fc
    .tuple(
      fc.constantFrom(
        ...DEFAULT_POLICY.allowlist.commands,
        "make",
        "make test",
        "node scripts/x.js",
        "python tools/run.py",
        "git commit -m wip",
        "touch notes.txt",
        "mkdir build",
        "rm -f dist/a.js",
        "cp a.ts b.ts",
        "echo hi > out.txt",
        "npx vitest run",
        "go test ./...",
        "cargo test",
      ),
      fc.constantFrom("", "ls && ", "cat package.json; ", "pwd && "),
    )
    .map(([cmd, prefix]) => ["Bash", { command: `${prefix}${cmd}` }] as const),
  fc.constantFrom(
    ["Task", { prompt: "go" }] as const,
    ["Agent", { prompt: "go" }] as const,
    ["KillShell", { shell_id: "1" }] as const,
    ["WebSearch", { query: "x" }] as const,
    ["WebFetch", { url: "https://unknown.example/x" }] as const,
    ["mcp__github__create_issue", { title: "x" }] as const,
  ),
);

describe("property: no unsigned origin ever gets allow for a non-read tool", () => {
  it("whatever the permission mode or Developer mode", () => {
    fc.assert(
      fc.property(nonRead, origin, mode, devMode, ([tool, input], o, pm, dm) => {
        const { d } = gate(tool, input as Record<string, unknown>, o, pm, dm);
        expect(d.action).not.toBe("allow");
      }),
      { numRuns: 2000 },
    );
  });

  it("and when an unsigned turn is allowed, the call was classified read-only", () => {
    const anyCall = fc.oneof(
      nonRead,
      anyPath.map((p) => ["Read", { file_path: p }] as const),
      anyPath.map((p) => ["Grep", { pattern: "x", path: p }] as const),
      fc.constantFrom(
        ["Bash", { command: "ls -la" }] as const,
        ["Bash", { command: "git status" }] as const,
        ["Bash", { command: "cat README.md | wc -l" }] as const,
        ["TodoWrite", { todos: [] }] as const,
      ),
    );
    fc.assert(
      fc.property(anyCall, origin, mode, devMode, ([tool, input], o, pm, dm) => {
        const { c, d } = gate(tool, input as Record<string, unknown>, o, pm, dm);
        if (d.action === "allow") expect(c.readOnly).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});
