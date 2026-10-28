import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as NodeFs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/** First Run C perf: 200 repos, classification reads a ready index (no folder walk, no per-repo stat). */
// Counted in file-system calls, not milliseconds: a busy CI runner pushed a 0.1 ms call past 1 ms.

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
const { hooksOptionsFor } = await import("../src/policy/classify.js");

let home = "";
afterEach(() => {
  vi.useRealTimers();
  if (home) rmSync(home, { recursive: true, force: true });
});

// 200 repos on disk and 3,000 classifications, by design: seconds on a loaded runner.
describe("classification with 200 repos in the workspace", { timeout: 30_000 }, () => {
  it("makes no file-system call per classification after warm-up: no folder walk, no per-repo stat", async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "chalito-bench-")));
    const ws = join(home, "ws");
    for (let i = 0; i < 200; i++) {
      const r = join(ws, `group${i % 10}`, `repo${i}`);
      mkdirSync(join(r, ".git"), { recursive: true });
      writeFileSync(join(r, ".git", "config"), `[core]\n\thooksPath = hooks-${i}\n`);
    }
    clearRepoIndex();
    // The daemon's async scan (fs.promises), off the classify path.
    // (the union is built there too, with the classification's options)
    const ctx = {
      policy: { ...DEFAULT_POLICY, workspaces: [{ label: "ws", path: ws }] },
      home,
      cwd: ws,
      realpath: (x: string) => x,
      env: { GIT_CONFIG_NOSYSTEM: "1" },
    };
    const write = (f: string) => classifyToolCall("Write", { file_path: join(ws, f), content: "x" }, ctx);
    await refreshRepoIndex([ws], { hooks: hooksOptionsFor(ctx) });
    // Frozen clock: the throttled mtime re-check (every 5 s) mustn't depend on how fast the runner is.
    vi.useFakeTimers({ toFake: ["Date"] });
    // Warm-up: the first call builds the union (reads the 200 repos' configs once).
    counting = true;
    expect(write("group3/repo13/hooks-13/pre-commit").tier).toBe("HIGH");
    expect(write("group4/repo14/hooks-14/pre-commit").tier).toBe("HIGH");

    const n = 500;
    const loop = () => {
      for (let i = 0; i < n; i++) write(`group${i % 10}/repo${i % 200}/src/file${i}.ts`);
    };
    // Warm-up of the per-folder repo lookup (each new folder once).
    loop();
    const warm = { ...calls };
    for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k] = 0;
    for (let b = 0; b < 5; b++) loop();
    counting = false;

    // The counter sees the warm-up's per-folder lookups, so the zeros below are real.
    expect(warm.statSync).toBeGreaterThan(0);
    // 2,500 calls over 200 repos: no folder walk, no config read, no stat of any kind.
    expect(calls).toEqual({ readdirSync: 0, statSync: 0, readFileSync: 0, lstatSync: 0 });
    expect(write("group9/repo199/hooks-199/x").tier).toBe("HIGH");
    expect(write("group9/repo199/src/hooks/useX.ts").tier).toBe("MED");
  });
});
