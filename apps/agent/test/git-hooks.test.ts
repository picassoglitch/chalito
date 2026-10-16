import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
const { clearRepoIndex, refreshRepoIndexSync, scanReposSync } = await import("../src/policy/repo-index.js");
const { clearHooksCache, envConfig, parseGitConfig, resolveHooks, systemConfigs } =
  await import("../src/policy/git-hooks.js");

beforeEach(() => {
  clearHooksCache();
  clearRepoIndex();
});
afterAll(() => expect(spawned).toEqual([]));

const NOSYS = { GIT_CONFIG_NOSYSTEM: "1" };
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
  // The machine's own /etc/gitconfig stays out of these tests (it gets its own below).
  env: NOSYS,
  ...o,
});
/** Classifies a write after a (sync, test-only) repo scan: the classifier itself never scans. */
const write = (ws: string, home: string, f: string, o: Record<string, unknown> = {}) => {
  const { repoScanLimit, ...rest } = o as { repoScanLimit?: number };
  refreshRepoIndexSync([ws], repoScanLimit ? { max: repoScanLimit } : {});
  return classifyToolCall("Write", { file_path: join(ws, f), content: "x" }, ctx(ws, home, rest));
};
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
    expect(resolveHooks(ws, { home, env: NOSYS }).dir).toBe(join(ws, "tools/git-hooks"));
    expect(write(ws, home, "tools/git-hooks/pre-push").tier).toBe("HIGH");
    expect(write(ws, home, ".git/config").tier).toBe("HIGH");
    expect(write(ws, home, ".git/info/exclude").tier).toBe("HIGH");
    expect(write(ws, home, "sub/.git").tier).toBe("HIGH");
    expect(write(ws, home, "tools/other/x.sh").tier).toBe("MED");
  });

  it("no hooksPath: the common dir's hooks", () => {
    const home = root();
    const ws = repo(home);
    expect(resolveHooks(ws, { home, env: NOSYS }).dir).toBe(join(ws, ".git", "hooks"));
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
    const info = resolveHooks(wt, { home, env: NOSYS });
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
    expect(resolveHooks(ws, { home, env: NOSYS }).dir).toBe(join(ws, "inc-hooks"));
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
    expect(resolveHooks(ws, { home, env: NOSYS }).dir).toBe(join(ws, "if-hooks"));

    clearHooksCache();
    // onbranch: can't be evaluated: its target is read anyway and its hooksPath counts too.
    const ws2 = repo(home, "app2", `[includeIf "onbranch:main"]\n\tpath = branch.cfg\n`);
    writeFileSync(join(ws2, ".git", "branch.cfg"), "[core]\n\thooksPath = ci-hooks\n");
    const info = resolveHooks(ws2, { home, env: NOSYS });
    expect(info.dir).toBe(join(ws2, ".git", "hooks"));
    expect(info.extraDirs).toEqual([join(ws2, "ci-hooks")]);
    expect(write(ws2, home, "ci-hooks/pre-commit").tier).toBe("HIGH");
    expect(write(ws2, home, ".githooks/x").tier).toBe("HIGH");
    expect(write(ws2, home, ".husky/pre-push").tier).toBe("HIGH");
    // No broad "hooks" rule: React hooks stay ordinary source.
    expect(write(ws2, home, "src/hooks/useThing.ts").tier).toBe("MED");
    expect(write(ws2, home, "hooks/pre-commit").tier).toBe("MED");
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
    expect(resolveHooks(ws, { home, xdgConfigHome: xdg, env: NOSYS }).dir).toBe(join(ws, "xdg-hooks"));
    // The repo's own value wins over the global one.
    writeFileSync(join(ws, ".git", "config"), "[core]\n\thooksPath = repo-hooks\n");
    clearHooksCache();
    expect(resolveHooks(ws, { home, xdgConfigHome: xdg, env: NOSYS }).dir).toBe(join(ws, "repo-hooks"));
  });

  it("a config it can't parse fails closed", () => {
    const home = root();
    const ws = repo(home, "app", "[core]\n\thooksPath = a\\\n\tb\n");
    expect(resolveHooks(ws, { home, env: NOSYS }).dir).toBe("unknown");
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

describe("system config, the environment, and values we can't resolve", () => {
  it("system config comes first; GIT_CONFIG_SYSTEM picks the file, GIT_CONFIG_NOSYSTEM skips it", () => {
    const home = root();
    const ws = repo(home);
    const sys = join(home, "system.cfg");
    writeFileSync(sys, "[core]\n\thooksPath = sys-hooks\n");
    expect(resolveHooks(ws, { home, env: { GIT_CONFIG_SYSTEM: sys } }).dir).toBe(join(ws, "sys-hooks"));
    expect(write(ws, home, "sys-hooks/x", { env: { GIT_CONFIG_SYSTEM: sys } }).tier).toBe("HIGH");
    // The system file is in the chain: writing it is HIGH even if it were in a workspace.
    expect(resolveHooks(ws, { home, env: { GIT_CONFIG_SYSTEM: sys } }).chain).toContain(sys);
    expect(resolveHooks(ws, { home, env: { GIT_CONFIG_SYSTEM: sys, GIT_CONFIG_NOSYSTEM: "1" } }).dir).toBe(
      join(ws, ".git", "hooks"),
    );
    // Global and repo values override the system one.
    writeFileSync(join(home, ".gitconfig"), "[core]\n\thooksPath = global-hooks\n");
    expect(resolveHooks(ws, { home, env: { GIT_CONFIG_SYSTEM: sys } }).dir).toBe(join(ws, "global-hooks"));
  });

  it("the known system files per OS; missing Windows variables fail closed", () => {
    expect(systemConfigs("linux", {}, "/home/ana")).toEqual({
      files: [
        "/etc/gitconfig",
        "/opt/homebrew/etc/gitconfig",
        "/usr/local/etc/gitconfig",
        "/home/linuxbrew/.linuxbrew/etc/gitconfig",
        "/home/ana/.linuxbrew/etc/gitconfig",
      ],
      unsure: false,
    });
    const winEnv = {
      ProgramData: "C:\\ProgramData",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local",
    };
    expect(systemConfigs("win32", winEnv, "C:\\Users\\ana")).toEqual({
      files: [
        "C:\\ProgramData\\Git\\config",
        "C:\\Program Files\\Git\\etc\\gitconfig",
        "C:\\Program Files\\Git\\mingw64\\etc\\gitconfig",
        "C:\\Program Files (x86)\\Git\\etc\\gitconfig",
        "C:\\Users\\ana\\AppData\\Local\\Programs\\Git\\etc\\gitconfig",
      ],
      unsure: false,
    });
    for (const k of ["ProgramData", "ProgramFiles", "LOCALAPPDATA"] as const) {
      const env = { ...winEnv, [k]: undefined };
      expect(systemConfigs("win32", env, "C:\\Users\\ana").unsure, k).toBe(true);
      const home = root();
      const ws = repo(home);
      expect(resolveHooks(ws, { home, env, platform: "win32" }).dir, k).toBe("unknown");
    }
  });

  it("every known system config is in the chain, even when not read; a per-user one is HIGH to write", () => {
    const home = root();
    const ws = repo(home);
    const own = join(home, ".linuxbrew", "etc", "gitconfig");
    const info = resolveHooks(ws, { home, env: NOSYS, platform: "linux" });
    expect(info.chain).toEqual(expect.arrayContaining(["/etc/gitconfig", own]));
    // A per-user git install's system config read for real: its hooksPath counts.
    mkdirSync(dirname(own), { recursive: true });
    writeFileSync(own, "[core]\n\thooksPath = brew-hooks\n");
    clearHooksCache();
    // Only files under this temp home exist for this check (the machine's /etc/gitconfig stays out).
    const onlyHome = {
      read: (p: string) => readFileSync(p, "utf8"),
      mtime: (p: string) => {
        if (!p.startsWith(home)) return -1;
        try {
          return statSync(p).mtimeMs;
        } catch {
          return -1;
        }
      },
      isDir: (p: string) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return null;
        }
      },
      realpath: (p: string) => realpathSync(p),
    };
    expect(resolveHooks(ws, { home, platform: "linux", fs: onlyHome }).dir).toBe(join(ws, "brew-hooks"));
  });

  it("GIT_CONFIG_GLOBAL replaces the user's files", () => {
    const home = root();
    const ws = repo(home);
    writeFileSync(join(home, ".gitconfig"), "[core]\n\thooksPath = ignored\n");
    const g = join(home, "g.cfg");
    writeFileSync(g, "[core]\n\thooksPath = env-global\n");
    expect(resolveHooks(ws, { home, env: { ...NOSYS, GIT_CONFIG_GLOBAL: g } }).dir).toBe(join(ws, "env-global"));
  });

  it("config given in the environment is parsed: GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT", () => {
    const home = root();
    const ws = repo(home);
    writeFileSync(join(ws, "inc.cfg"), "[core]\n\thooksPath = from-inc\n");
    expect(envConfig({ GIT_CONFIG_PARAMETERS: "'core.hooksPath'='it'\\''s' 'user.name'='x'" })).toEqual([
      { section: "core", sub: null, key: "hookspath", value: "it's" },
      { section: "user", sub: null, key: "name", value: "x" },
    ]);
    // Order isn't modelled: environment values are extra hooks folders, on top of the files' answer.
    const p = resolveHooks(ws, { home, env: { ...NOSYS, GIT_CONFIG_PARAMETERS: "'core.hooksPath'='p-hooks'" } });
    expect(p.dir).toBe(join(ws, ".git", "hooks"));
    expect(p.extraDirs).toEqual([join(ws, "p-hooks")]);
    clearHooksCache();
    expect(
      resolveHooks(ws, { home, env: { ...NOSYS, GIT_CONFIG_PARAMETERS: "'include.path'='inc.cfg'" } }).extraDirs,
    ).toEqual([join(ws, "from-inc")]);
    clearHooksCache();
    const counted = {
      ...NOSYS,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "x",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "count-hooks",
    };
    expect(resolveHooks(ws, { home, env: counted }).extraDirs).toEqual([join(ws, "count-hooks")]);
    // Several values: all of them count, whichever git would end up using.
    clearHooksCache();
    const both = { ...counted, GIT_CONFIG_PARAMETERS: "'core.hooksPath'='p-hooks'" };
    expect(resolveHooks(ws, { home, env: both }).extraDirs.sort()).toEqual(
      [join(ws, "count-hooks"), join(ws, "p-hooks")].sort(),
    );
    expect(write(ws, home, "p-hooks/x", { env: both }).tier).toBe("HIGH");
    expect(write(ws, home, "count-hooks/x", { env: counted }).tier).toBe("HIGH");
    expect(write(ws, home, "src/hooks/useX.ts", { env: counted }).tier).toBe("MED");
  });

  it.each([
    { GIT_CONFIG_COUNT: "1" },
    { GIT_CONFIG_COUNT: "lots" },
    { GIT_CONFIG_PARAMETERS: "core.hooksPath=unquoted" },
    { GIT_CONFIG_PARAMETERS: "'core.hooksPath'='open" },
  ])("unparseable environment config fails closed (narrowly): %o", (bad) => {
    const home = root();
    const ws = repo(home);
    const env = { ...NOSYS, ...bad };
    expect(resolveHooks(ws, { home, env }).dir).toBe("unknown");
    expect(write(ws, home, "hooks/x", { env }).tier).toBe("HIGH");
    expect(write(ws, home, ".githooks/x", { env }).tier).toBe("HIGH");
    expect(write(ws, home, "src/hooks/useX.ts", { env }).tier).toBe("MED");
  });

  it("GIT_CONFIG names a config file, which is read too", () => {
    const home = root();
    const ws = repo(home);
    writeFileSync(join(home, "extra.cfg"), "[core]\n\thooksPath = gc-hooks\n");
    expect(resolveHooks(ws, { home, env: { ...NOSYS, GIT_CONFIG: join(home, "extra.cfg") } }).dir).toBe(
      join(ws, "gc-hooks"),
    );
  });

  it("~user/… and %(prefix) in hooksPath or include paths fail closed", () => {
    const home = root();
    for (const cfg of [
      "[core]\n\thooksPath = ~bob/hooks\n",
      "[core]\n\thooksPath = %(prefix)/hooks\n",
      "[include]\n\tpath = ~bob/x.cfg\n",
      '[includeIf "gitdir:/x/"]\n\tpath = %(prefix)/x.cfg\n',
    ]) {
      clearHooksCache();
      const ws = repo(home, `r${Math.random().toString(36).slice(2)}`, cfg);
      expect(resolveHooks(ws, { home, env: NOSYS }).dir, cfg).toBe("unknown");
    }
  });

  it("includeIf gitdir matches the git dir's realpath too, and fails closed if it can't resolve it", () => {
    const home = root();
    const realHome = join(home, "real");
    mkdirSync(realHome);
    const ws = repo(realHome, "app", `[includeIf "gitdir:${realHome}/"]\n\tpath = ${join(home, "inc.cfg")}\n`);
    writeFileSync(join(home, "inc.cfg"), "[core]\n\thooksPath = via-real\n");
    // The workspace is reached through a symlink; the pattern names the real path.
    symlinkSync(realHome, join(home, "link"));
    const linked = join(home, "link", "app");
    expect(resolveHooks(linked, { home, env: NOSYS }).dir).toBe(join(linked, "via-real"));
    // A realpath that fails: unknown.
    clearHooksCache();
    const failing = {
      read: (p: string) => readFileSync(p, "utf8"),
      mtime: (p: string) => {
        try {
          return statSync(p).mtimeMs;
        } catch {
          return -1;
        }
      },
      isDir: (p: string) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return null;
        }
      },
      realpath: () => {
        throw new Error("EACCES");
      },
    };
    // Can't evaluate the condition: the target is read anyway, its hooksPath counts as well.
    const info = resolveHooks(ws, { home, env: NOSYS, fs: failing });
    expect(info.dir).not.toBe("unknown");
    expect(info.extraDirs).toEqual([join(ws, "via-real")]);
  });
});

describe("the sessions' HOME, XDG and PATH", () => {
  it("global config comes from the sessions' HOME and XDG; both XDG paths are in the chain", () => {
    const agentHome = root();
    const sessionHome = root();
    const ws = repo(agentHome);
    writeFileSync(join(sessionHome, ".gitconfig"), "[core]\n\thooksPath = session-hooks\n");
    writeFileSync(join(agentHome, ".gitconfig"), "[core]\n\thooksPath = agent-hooks\n");
    const xdg = join(sessionHome, "xdg");
    const info = resolveHooks(ws, { home: agentHome, env: { ...NOSYS, HOME: sessionHome, XDG_CONFIG_HOME: xdg } });
    expect(info.dir).toBe(join(ws, "session-hooks"));
    expect(info.chain).toEqual(
      expect.arrayContaining([join(xdg, "git", "config"), join(sessionHome, ".config", "git", "config")]),
    );
    expect(write(ws, agentHome, "session-hooks/x", { env: { ...NOSYS, HOME: sessionHome } }).tier).toBe("HIGH");
    // The daemon's own global files are in the chain and watched too (HOME ≠ the daemon's home).
    for (const f of [join(agentHome, ".gitconfig"), join(agentHome, ".config", "git", "config")]) {
      expect(info.chain, f).toContain(f);
      expect(info.watched, f).toContain(f);
    }
    expect(new Set(info.chain).size).toBe(info.chain.length);
    expect(
      classifyToolCall(
        "Write",
        { file_path: join(agentHome, ".gitconfig"), content: "x" },
        ctx(agentHome, agentHome, { env: { ...NOSYS, HOME: sessionHome } }),
      ).tier,
    ).toBe("HIGH");
  });

  it("a git on the sessions' PATH brings its prefix's etc/gitconfig (existence only, never run)", () => {
    const home = root();
    const ws = repo(home);
    const prefix = join(home, "opt", "git");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    mkdirSync(join(prefix, "etc"));
    writeFileSync(join(prefix, "bin", "git"), "#!/bin/sh\nexit 99\n");
    writeFileSync(join(prefix, "etc", "gitconfig"), "[core]\n\thooksPath = prefix-hooks\n");
    const onlyHome = {
      read: (p: string) => readFileSync(p, "utf8"),
      mtime: (p: string) => {
        if (!p.startsWith(home)) return -1;
        try {
          return statSync(p).mtimeMs;
        } catch {
          return -1;
        }
      },
      isDir: (p: string) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return null;
        }
      },
      realpath: (p: string) => realpathSync(p),
    };
    const info = resolveHooks(ws, {
      home,
      platform: "linux",
      fs: onlyHome,
      env: { PATH: `/nope:${join(prefix, "bin")}` },
    });
    expect(info.dir).toBe(join(ws, "prefix-hooks"));
    expect(info.chain).toContain(join(prefix, "etc", "gitconfig"));
    // A PATH dir without git adds nothing.
    clearHooksCache();
    expect(
      resolveHooks(ws, { home, platform: "linux", fs: onlyHome, env: { PATH: join(home, "opt") } }).chain,
    ).not.toContain(join(home, "etc", "gitconfig"));
  });

  it("Windows: git's mingw64/mingw32 etc too; 64-bit without ProgramFiles(x86) fails closed", () => {
    const files: Record<string, string> = {
      "D:\\Tools\\Git\\cmd\\git.exe": "",
      "D:\\Tools\\Git\\mingw64\\etc\\gitconfig": "[core]\n\thooksPath = mingw-hooks\n",
      // The repo side is joined with the host's path module (this test runs on Linux too).
      [join("W:\\app", ".git", "config")]: "",
    };
    const fs = {
      read: (p: string) => {
        if (!(p in files)) throw new Error("ENOENT");
        return files[p]!;
      },
      mtime: (p: string) => (p in files ? 1 : -1),
      isDir: (p: string) => (p === join("W:\\app", ".git") ? true : p in files ? false : null),
      realpath: (p: string) => p,
    };
    const base = {
      ProgramData: "C:\\ProgramData",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local",
      PATH: "C:\\Windows;D:\\Tools\\Git\\cmd",
      PROCESSOR_ARCHITECTURE: "AMD64",
    };
    const info = resolveHooks("W:\\app", { home: "C:\\Users\\ana", platform: "win32", fs, env: base });
    expect(info.chain).toEqual(
      expect.arrayContaining([
        "D:\\Tools\\Git\\etc\\gitconfig",
        "D:\\Tools\\Git\\mingw64\\etc\\gitconfig",
        "D:\\Tools\\Git\\mingw32\\etc\\gitconfig",
      ]),
    );
    expect(info.dir).not.toBe("unknown");
    clearHooksCache();
    const { "ProgramFiles(x86)": _drop, ...no86 } = base;
    expect(resolveHooks("W:\\app", { home: "C:\\Users\\ana", platform: "win32", fs, env: no86 }).dir).toBe("unknown");
  });
});

describe("per-repo resolution, the broad fallback, GIT_DIR, git executables", () => {
  it("an unparseable config: only the repo's hooks/ and .githooks/ (and .husky/) count; src/hooks stays MED", () => {
    const home = root();
    const ws = repo(home, "app", "[core]\n\thooksPath = a\\\n\tb\n");
    expect(resolveHooks(ws, { home, env: NOSYS }).dir).toBe("unknown");
    expect(write(ws, home, "hooks/pre-commit").tier).toBe("HIGH");
    expect(write(ws, home, ".githooks/pre-commit").tier).toBe("HIGH");
    expect(write(ws, home, ".husky/pre-push").tier).toBe("HIGH");
    expect(write(ws, home, "src/hooks/useAuth.ts").tier).toBe("MED");
    expect(write(ws, home, "packages/web/hooks/x.ts").tier).toBe("MED");
  });

  it("a workspace holding several repos resolves each one", () => {
    const home = root();
    const ws = join(home, "monorepo-of-repos");
    mkdirSync(ws);
    repo(ws, "a", "[core]\n\thooksPath = ha\n");
    repo(ws, "b", "[core]\n\thooksPath = hb\n");
    expect(write(ws, home, "a/ha/pre-commit").tier).toBe("HIGH");
    expect(write(ws, home, "b/hb/pre-commit").tier).toBe("HIGH");
    expect(write(ws, home, "a/hb/x.ts").tier).toBe("MED");
    expect(write(ws, home, "b/.git/config").tier).toBe("HIGH");
  });

  it("a workspace inside a repo uses that repo's config", () => {
    const home = root();
    const outer = repo(home, "big", "[core]\n\thooksPath = packages/app/hooks2\n");
    const ws = join(outer, "packages", "app");
    mkdirSync(ws, { recursive: true });
    expect(write(ws, home, "hooks2/pre-commit").tier).toBe("HIGH");
    expect(write(ws, home, "src/a.ts").tier).toBe("MED");
  });

  it("GIT_DIR / GIT_COMMON_DIR from the sessions' environment are used; a missing one fails closed", () => {
    const home = root();
    const ws = join(home, "plain");
    mkdirSync(ws);
    const gd = join(home, "elsewhere.git");
    mkdirSync(gd);
    writeFileSync(join(gd, "config"), "[core]\n\thooksPath = env-hooks\n");
    const env = { ...NOSYS, GIT_DIR: gd };
    expect(resolveHooks(ws, { home, env }).dir).toBe(join(ws, "env-hooks"));
    expect(write(ws, home, "env-hooks/x", { env }).tier).toBe("HIGH");
    expect(write(ws, home, "src/a.ts", { env }).tier).toBe("MED");
    clearHooksCache();
    expect(resolveHooks(ws, { home, env: { ...NOSYS, GIT_DIR: join(home, "missing") } }).dir).toBe("unknown");
    clearHooksCache();
    const common = join(home, "common.git");
    mkdirSync(common);
    writeFileSync(join(common, "config"), "[core]\n\thooksPath = common-hooks\n");
    expect(resolveHooks(ws, { home, env: { ...env, GIT_COMMON_DIR: common } }).dir).toBe(join(ws, "common-hooks"));
    clearHooksCache();
    expect(resolveHooks(ws, { home, env: { ...env, GIT_COMMON_DIR: join(home, "nope") } }).dir).toBe("unknown");
  });

  it("a write named exactly like a git executable is HIGH whatever is on disk; files inside a git/ folder aren't", () => {
    const home = root();
    const ws = repo(home);
    mkdirSync(join(ws, "src", "git"), { recursive: true });
    // No check of what's on disk (it could change between the check and the write).
    expect(write(ws, home, "src/git").tier).toBe("HIGH");
    expect(write(ws, home, "src/git/client.ts").tier).toBe("MED");
    expect(write(ws, home, "src/git/foo.ts").tier).toBe("MED");
    expect(write(ws, home, "bin/git").tier).toBe("HIGH");
    expect(write(ws, home, "tools/git.exe").tier).toBe("HIGH");
  });
});

describe("every repo in the workspace is known up front", () => {
  it("a sibling repo's hooksPath into another repo is HIGH, even if the sibling was never touched", () => {
    const home = root();
    const ws = join(home, "ws");
    mkdirSync(ws);
    repo(ws, "a", "[core]\n\thooksPath = ../b/from-a\n");
    repo(ws, "b");
    // The very first write, straight into B: A is found by the workspace scan.
    expect(write(ws, home, "b/from-a/pre-commit").tier).toBe("HIGH");
    expect(write(ws, home, "b/src/y.ts").tier).toBe("MED");
  });

  it("the scan skips heavy folders, stops at depth 4 and at the folder budget", () => {
    const home = root();
    const ws = join(home, "ws");
    mkdirSync(ws);
    repo(ws, "a");
    repo(join(ws, "node_modules"), "pkg");
    mkdirSync(join(ws, "d1", "d2", "d3", "d4", "d5"), { recursive: true });
    repo(join(ws, "d1", "d2", "d3"), "deep");
    repo(join(ws, "d1", "d2", "d3", "d4", "d5"), "too-deep");
    const scan = scanReposSync(ws);
    expect(scan.roots.sort()).toEqual([join(ws, "a"), join(ws, "d1", "d2", "d3", "deep")].sort());
    expect(scan.complete).toBe(true);
    // The folder budget cuts a scan short.
    expect(scanReposSync(ws, { budget: 2 }).complete).toBe(false);
  });

  it("a scan cut short protects every repo's usual hooks folders (narrowly)", () => {
    const home = root();
    const ws = join(home, "ws");
    mkdirSync(ws);
    repo(ws, "a");
    repo(ws, "b");
    const o = { repoScanLimit: 1 };
    expect(write(ws, home, "b/hooks/pre-commit", o).tier).toBe("HIGH");
    expect(write(ws, home, "a/.githooks/x", o).tier).toBe("HIGH");
    expect(write(ws, home, "b/src/hooks/useX.ts", o).tier).toBe("MED");
    // A complete scan: no fallback.
    clearHooksCache();
    expect(write(ws, home, "b/hooks/pre-commit").tier).toBe("MED");
  });
});

describe("repos the index doesn't know are still covered", () => {
  it("a repo under vendor/ (a folder the scan skips) keeps its hooksPath protected", () => {
    const home = root();
    const ws = join(home, "ws");
    mkdirSync(ws);
    const vendored = repo(join(ws, "vendor"), "lib", "[core]\n\thooksPath = lib-hooks\n");
    expect(scanReposSync(ws).roots).not.toContain(vendored);
    expect(write(ws, home, "vendor/lib/lib-hooks/pre-commit").tier).toBe("HIGH");
    expect(write(ws, home, "vendor/lib/.git/config").tier).toBe("HIGH");
    expect(write(ws, home, "vendor/lib/src/a.ts").tier).toBe("MED");
  });

  it("an unreadable folder is skipped, not fatal: the scan stays complete and other repos are protected", () => {
    const home = root();
    const ws = join(home, "ws");
    mkdirSync(ws);
    repo(ws, "a", "[core]\n\thooksPath = ../b/from-a\n");
    repo(ws, "b");
    const locked = join(ws, "locked");
    mkdirSync(join(locked, "inner"), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const scan = scanReposSync(ws);
      if (process.getuid?.() !== 0) {
        expect(scan.unreadable).toContain(locked);
        expect(scan.complete).toBe(true);
      }
      expect(write(ws, home, "b/from-a/pre-commit").tier).toBe("HIGH");
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe("one comparison key for the index and the classifier", () => {
  it.each(["hooks-a.", "hooks-a ", "Hooks-A.."])("win32: a hooksPath written as %j still protects hooks-a", (hp) => {
    const home = root();
    const ws = repo(home, "app", `[core]\n\thooksPath = "${hp}"\n`);
    const o = { platform: "win32" };
    expect(write(ws, home, "hooks-a/pre-commit", o).tier).toBe("HIGH");
    expect(write(ws, home, "HOOKS-A/pre-commit", o).tier).toBe("HIGH");
    expect(write(ws, home, "src/a.ts", o).tier).toBe("MED");
  });
});
