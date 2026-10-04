/** Beta security review proofs. Each FAILS on origin/all b026abf until its finding is fixed. */
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, DEVMODE_OFF, classifyToolCall, decide } from "../src/policy/index.js";
import { redact } from "../src/redact.js";

const HOME = "/home/aldo";
const WS = "/home/aldo/code/chalito";
const ctx = () => ({
  policy: { ...DEFAULT_POLICY, workspaces: [{ label: "chalito", path: WS }] },
  home: HOME,
  cwd: WS,
  realpath: (x: string) => x,
});

describe("R-C1: unsigned turns (MCP prompt, phone call) never get accept_edits / allowlist auto-allow", () => {
  const edit = classifyToolCall("Edit", { file_path: `${WS}/package.json`, old_string: "a", new_string: "b" }, ctx());
  const run = classifyToolCall("Bash", { command: "npm test" }, ctx());
  for (const origin of ["mcp:claude", `call:CA${"a".repeat(32)}`] as const)
    for (const [name, c] of [
      ["edit package.json", edit],
      ["npm test", run],
    ] as const)
      it(`${origin}: ${name} asks the phone`, () => {
        expect(
          decide({
            classification: c,
            origin,
            originAllowed: true,
            devMode: DEVMODE_OFF,
            permissionMode: "acceptEdits",
          }).action,
        ).toBe("ask");
      });
});

describe("R-M9: redact() covers common provider secrets (cards are plaintext to MCP when shared)", () => {
  // Built at runtime so no literal secret-shaped string is committed (push protection).
  const fake = (prefix: string, n = 24) => `${prefix}${"Zq7".repeat(Math.ceil(n / 3)).slice(0, n)}`;
  it.each([
    fake("sk_" + "live_"),
    fake("github_" + "pat_11"),
    fake("xox" + "b-1234-5678-"),
    fake("gl" + "pat-"),
    fake("sb_" + "secret_"),
    fake("ya" + "29."),
    `{"apiKey":"${fake("v", 28)}"}`,
    `PASSWORD=${fake("h", 14)}`,
  ])("%s", (s) => {
    expect(redact(s)).not.toContain(s.slice(-10));
  });
});
