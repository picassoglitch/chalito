import { mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ChildProcess from "node:child_process";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/** First Run C (ADR 0028): the classifier finds a repo's hooks folder by reading git's files, never by running git. */

const spawned: string[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcess>();
  const spy =
    <F extends (...a: never[]) => unknown>(name: string, f: F) =>
    (...a: Parameters<F>) => {
      spawned.push(name);
      return f(...a);
    };
  return {
    ...real,
    exec: spy("exec", real.exec),
    execSync: spy("execSync", real.execSync),
    execFile: spy("execFile", real.execFile),
    execFileSync: spy("execFileSync", real.execFileSync),
    spawn: spy("spawn", real.spawn),
    spawnSync: spy("spawnSync", real.spawnSync),
    fork: spy("fork", real.fork),
  };
});

const { classifyToolCall, DEFAULT_POLICY } = await import("../src/policy/index.js");
const { clearHooksCache, parseGitConfig, resolveHooks } = await import("../src/policy/git-hooks.js");

beforeEach(() => clearHooksCache());
afterAll(() => expect(spawned).toEqual([]));

const root = () => realpathSync(mkdtempSync(join(tmpdir(), "chalito-gitfs-")));
/** A repo made by hand: `.git/` with a config (no git binary involved). */
const repo = (home: string, name = "app", config = "[core]\n\trepositoryformatversion = 0\n") => {
  const ws = join(home, name);
  mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
  writeFileSync(join(ws, ".git", "config"), config);
  return ws;
};
const ctx = (ws: string, home: string, o: Record<string, unknown> = {}) => ({
  policy: { ...DEFAULT_POLICY, workspaces: [{ label: "app", path: ws }] },
  home,
  cwd: ws,
  realpath: (x: string) => x,
  ...o,
});
const write = (ws: string, home: string, f: string, o: Record<string, unknown> = {}) =>
  classifyToolCall("Write", { file_path: join(ws, f), content: "x" }, ctx(ws, home, o));
const bump = (f: string) => utimesSync(f, new Date(), new Date(Date.now() + 10_000));

describe("the parser", () => {
  it("reads sections, subsections, quotes, escapes and comments", () => {
    expect(
      parseGitConfig(
        '# c\n[core] hooksPath = "a b" ; trailing\n[includeIf "gitdir:~/w/"]\n  path = x.cfg # c\n[Core]\nHOOKSPATH=c\\"d\n[x.Y]\nflag\n',
      ),
    ).toEqual([
      { section: "core", sub: null, key: "hookspath", value: "a b" },
      { section: "includeif", sub: "gitdir:~/w/", key: "path", value: "x.cfg" },
      { section: "core", sub: null, key: "hookspath", value: 'c"d' },
      { section: "x", sub: "y", key: "flag", value: true },
    ]);
  });

  it("refuses what it can't be sure of", () => {
    for (const bad of [
      "[core\nx=1",
      "x = 1",
      '[core]\nhooksPath = "open',
      "[core]\nhooksPath = a\\\n b",
      "[core]\nhooksPath = a\\q",
    ])
      expect(() => parseGitConfig(bad), bad).toThrow();
  });
});

describe("hooks folder resolution, without running git", () => {
  it("core.hooksPath in the repo config is HIGH; .git and its config always are", () => {
    const home = root();
    const ws = repo(home, "app", "[core]\n\thooksPath = tools/git-hooks\n");
    expect(resolveHooks(ws, { home }).dir).toBe(join(ws, "tools/git-hooks"));
    expect(write(ws, home, "tools/git-hooks/pre-push").tier).toBe("HIGH");
    expect(write(ws, home, ".git/config").tier).toBe("HIGH");
    expect(write(ws, home, ".git/info/exclude").tier).toBe("HIGH");
    expect(write(ws, home, "sub/.git").tier).toBe("HIGH");
    expect(write(ws, home, "tools/other/x.sh").tier).toBe("MED");
  });

  it("no hooksPath: the common dir's hooks", () => {
    const home = root();
    const ws = repo(home);
    expect(resolveHooks(ws, { home }).dir).toBe(join(ws, ".git", "hooks"));
  });

  it("a worktree's gitdir file and commondir", () => {
    const home = root();
    const main = repo(home, "main", "[core]\n\thooksPath = wt-hooks\n");
    const gd = join(main, ".git", "worktrees", "wt");
    mkdirSync(gd, { recursive: true });
    writeFileSync(join(gd, "commondir"), "../..\n");
    const wt = join(home, "wt");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${gd}\n`);
    const info = resolveHooks(wt, { home });
    expect(info.dir).toBe(join(wt, "wt-hooks"));
    expect(info.gitDirs).toEqual([gd, join(main, ".git")]);
    expect(write(wt, home, "wt-hooks/pre-commit").tier).toBe("HIGH");
    expect(write(wt, home, ".git").tier).toBe("HIGH");
    expect(write(wt, home, "src/a.ts").tier).toBe("MED");
  });

  it("includes, relative and absolute, and the include targets are HIGH to write", () => {
    const home = root();
    const ws = repo(home, "app", "[include]\n\tpath = ../shared/rel.cfg\n");
    mkdirSync(join(home, "shared"));
    // Relative to the including file (.git/config → ../shared is under the workspace).
    mkdirSync(join(ws, "shared"));
    writeFileSync(join(ws, "shared", "rel.cfg"), `[include]\n\tpath = ${join(home, "shared", "abs.cfg")}\n`);
    writeFileSync(join(home, "shared", "abs.cfg"), "[core]\n\thooksPath = inc-hooks\n");
    expect(resolveHooks(ws, { home }).dir).toBe(join(ws, "inc-hooks"));
    expect(write(ws, home, "inc-hooks/x").tier).toBe("HIGH");
    // The include inside the workspace: editing it could redirect hooksPath.
    expect(write(ws, home, "shared/rel.cfg").tier).toBe("HIGH");
    expect(write(ws, home, "shared/other.cfg").tier).toBe("MED");
  });

  it("includeIf gitdir: follows only when it matches; another condition fails closed", () => {
    const home = root();
    const ws = repo(
      home,
      "app",
      `[includeIf "gitdir:${home}/"]\n\tpath = ${join(home, "yes.cfg")}\n[includeIf "gitdir:/nowhere/"]\n\tpath = ${join(home, "no.cfg")}\n`,
    );
    writeFileSync(join(home, "yes.cfg"), "[core]\n\thooksPath = if-hooks\n");
    writeFileSync(join(home, "no.cfg"), "[core]\n\thooksPath = wrong\n");
    expect(resolveHooks(ws, { home }).dir).toBe(join(ws, "if-hooks"));

    clearHooksCache();
    const ws2 = repo(home, "app2", `[includeIf "onbranch:main"]\n\tpath = x.cfg\n`);
    expect(resolveHooks(ws2, { home }).dir).toBe("unknown");
    expect(write(ws2, home, "hooks/pre-commit").tier).toBe("HIGH");
    expect(write(ws2, home, ".githooks/x").tier).toBe("HIGH");
    expect(write(ws2, home, ".husky/pre-push").tier).toBe("HIGH");
    expect(write(ws2, home, "src/a.ts").tier).toBe("MED");
  });

  it("the user's global config (temp HOME) and XDG config", () => {
    const home = root();
    const ws = repo(home);
    writeFileSync(join(home, ".gitconfig"), "[core]\n\thooksPath = global-hooks\n");
    expect(write(ws, home, "global-hooks/pre-commit").tier).toBe("HIGH");
    clearHooksCache();
    const xdg = join(home, "xdg");
    mkdirSync(join(xdg, "git"), { recursive: true });
    writeFileSync(join(xdg, "git", "config"), "[core]\n\thooksPath = xdg-hooks\n");
    writeFileSync(join(home, ".gitconfig"), "");
    expect(resolveHooks(ws, { home, xdgConfigHome: xdg }).dir).toBe(join(ws, "xdg-hooks"));
    // The repo's own value wins over the global one.
    writeFileSync(join(ws, ".git", "config"), "[core]\n\thooksPath = repo-hooks\n");
    clearHooksCache();
    expect(resolveHooks(ws, { home, xdgConfigHome: xdg }).dir).toBe(join(ws, "repo-hooks"));
  });

  it("a config it can't parse fails closed", () => {
    const home = root();
    const ws = repo(home, "app", "[core]\n\thooksPath = a\\\n\tb\n");
    expect(resolveHooks(ws, { home }).dir).toBe("unknown");
    expect(write(ws, home, "hooks/pre-commit").tier).toBe("HIGH");
  });

  it("an edit to an include invalidates the cache", () => {
    const home = root();
    const ws = repo(home, "app", `[include]\n\tpath = ${join(home, "inc.cfg")}\n`);
    writeFileSync(join(home, "inc.cfg"), "[core]\n\thooksPath = first\n");
    expect(write(ws, home, "first/x").tier).toBe("HIGH");
    writeFileSync(join(home, "inc.cfg"), "[core]\n\thooksPath = second\n");
    bump(join(home, "inc.cfg"));
    expect(write(ws, home, "second/x").tier).toBe("HIGH");
    expect(write(ws, home, "first/x").tier).toBe("MED");
    // Creating a missing include counts too.
    expect(readFileSync(join(ws, ".git", "config"), "utf8")).toContain("inc.cfg");
  });

  it("a planted git binary or a gitconfig-named file is HIGH; git is never run", () => {
    const home = root();
    const ws = repo(home);
    for (const f of ["git.exe", "bin/git", "tools/git.cmd", "git.com", "x/.gitconfig", "my.gitconfig.local"])
      expect(write(ws, home, f).tier, f).toBe("HIGH");
    expect(write(ws, home, "src/gitlab.ts").tier).toBe("MED");
    expect(spawned).toEqual([]);
  });
});
