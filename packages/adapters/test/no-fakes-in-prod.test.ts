import { describe, expect, it } from "vitest";
import * as root from "../src/index.js";
import * as claude from "../src/claude-code/index.js";
import * as codex from "../src/codex/index.js";
import * as acp from "../src/acp/index.js";
import * as testing from "../src/testing.js";

describe("fake sessions are test-only", () => {
  it("the production entry points export no fake session", () => {
    for (const mod of [root, claude, codex, acp])
      for (const name of Object.keys(mod)) expect(name).not.toMatch(/^fake/i);
  });

  it("they live under @chalito/adapters/testing", () => {
    expect(Object.keys(testing).sort()).toEqual(["fakeClaudeCode", "fakeCodex"]);
  });
});
