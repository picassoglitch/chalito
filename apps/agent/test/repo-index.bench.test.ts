import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as NodeFs from "node:fs";
import { describe, expect, it, vi } from "vitest";

/** First Run C perf: 200 repos, classification reads a ready index (no folder walk, no per-repo stat). */

const calls = { readdirSync: 0, statSync: 0, readFileSync: 0, lstatSync: 0 };
let counting = false;
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof NodeFs>();
  const count =
    <K extends keyof typeof calls>(name: K) =>
    (...a: unknown[]) => {
      if (counting) calls[name]++;
      return (real[name] as (...x: unknown[]) => unknown)(...a);
    };
  return {
    ...real,
    default: real,
    readdirSync: count("readdirSync"),
    statSync: count("statSync"),
    readFileSync: count("readFileSync"),
    lstatSync: count("lstatSync"),
  };
});

const { classifyToolCall, DEFAULT_POLICY } = await import("../src/policy/index.js");
const { clearRepoIndex, refreshRepoIndex } = await import("../src/policy/repo-index.js");

describe("classification with 200 repos in the workspace", () => {
  it("stays under 1 ms per call after warm-up, without walking folders or statting each repo", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "chalito-bench-")));
    const ws = join(home, "ws");
    for (let i = 0; i < 200; i++) {
      const r = join(ws, `group${i % 10}`, `repo${i}`);
      mkdirSync(join(r, ".git"), { recursive: true });
      writeFileSync(join(r, ".git", "config"), `[core]\n\thooksPath = hooks-${i}\n`);
    }
    clearRepoIndex();
    // The daemon's async scan (fs.promises), off the classify path.
    await refreshRepoIndex([ws]);
    const ctx = {
      policy: { ...DEFAULT_POLICY, workspaces: [{ label: "ws", path: ws }] },
      home,
      cwd: ws,
      realpath: (x: string) => x,
      env: { GIT_CONFIG_NOSYSTEM: "1" },
    };
    const write = (f: string) => classifyToolCall("Write", { file_path: join(ws, f), content: "x" }, ctx);
    // Warm-up: the first call builds the union (reads the 200 repos' configs once).
    expect(write("group3/repo13/hooks-13/pre-commit").tier).toBe("HIGH");
    expect(write("group4/repo14/hooks-14/pre-commit").tier).toBe("HIGH");

    counting = true;
    const n = 500;
    const start = performance.now();
    for (let i = 0; i < n; i++) write(`group${i % 10}/repo${i % 200}/src/file${i}.ts`);
    const perCall = (performance.now() - start) / n;
    counting = false;

    expect(perCall).toBeLessThan(1);
    // No folder walk, no config reads, and no per-repo stat loop per call (at most one mtime sweep).
    expect(calls.readdirSync).toBe(0);
    expect(calls.readFileSync).toBe(0);
    expect(calls.statSync).toBeLessThan(n);
    expect(write("group9/repo199/hooks-199/x").tier).toBe("HIGH");
    expect(write("group9/repo199/src/hooks/useX.ts").tier).toBe("MED");
  });
});
