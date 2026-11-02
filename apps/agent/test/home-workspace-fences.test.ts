// Owner 2026-11-02: `~` may be a workspace, but its fences are never auto-approved (coordinator, native).
// Runs on a real temporary home folder: real realpath, real symlinks.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AutoKind } from "@chalito/protocol";
import { coordAnswer } from "../src/coord/gate.js";
import { DEFAULT_POLICY, classifyToolCall, decide, isTighterOrEqual, type Policy } from "../src/policy/index.js";
import type { ClassifyContext } from "../src/policy/classify.js";
import { AI_CONFIG_DIRS, FENCES, SENSITIVE_DIRS, STARTUP_DIRS } from "../src/policy/persistence.js";
import { codeService } from "../src/code/service.js";
import { nativeWorkspacePaths, nativeWorkspaceStatus, writeNativeWorkspaces } from "../src/native/protocol.js";
import { addWorkspace, workspaceProblem } from "../src/workspaces.js";

const ALL: AutoKind[] = ["read", "tests", "workspace_edit", "git_local", "package_install", "coord_branch_push"];

/** A real home folder with keys, startup files, AI settings, a project and a work folder. */
const makeHome = () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "chalito-home-")));
  const file = (rel: string, text = "x") => {
    mkdirSync(dirname(join(home, rel)), { recursive: true });
    writeFileSync(join(home, rel), text);
  };
  file(".ssh/id_ed25519", "-----BEGIN OPENSSH PRIVATE KEY-----");
  file(".aws/credentials");
  file(".bashrc");
  file(".profile");
  file(".claude/settings.json", "{}");
  file(".codex/config.toml");
  file(".chalito/policy.yaml");
  file(".local/bin/tool");
  file("notes.txt");
  file("projects/x/src/a.ts");
  file("wayak/repo/README.md");
  symlinkSync(join(home, ".ssh/id_ed25519"), join(home, "projects/x/key.txt"));
  symlinkSync(join(home, ".claude"), join(home, "projects/x/claude-cfg"));
  symlinkSync(join(home, ".ssh"), join(home, "projects/x/keys"));
  const policy: Policy = {
    ...DEFAULT_POLICY,
    workspaces: [{ label: "home", path: home }],
    workspaceExclude: [join(home, "wayak")],
  };
  const project = join(home, "projects/x");
  const ctx = (cwd = project, p = policy): ClassifyContext => ({
    policy: p,
    home,
    cwd,
    pathDirs: [join(home, ".local/bin"), "/usr/bin"],
  });
  return { home, project, policy, ctx };
};

const DEV_ALL = {
  on: true,
  toggles: ["allowSudo", "autoApproveHigh", "autoApproveCritical", "bypassStyle"] as const,
  since: 1,
};

/** Whether anything at all answers for the human: decide (any mode) or the coordinator. */
const answeredFor = (tool: string, input: Record<string, unknown>, ctx: ClassifyContext) => {
  const c = classifyToolCall(tool, input, ctx);
  const allows = [
    decide({
      classification: c,
      origin: "local",
      originAllowed: true,
      devMode: { ...DEV_ALL, toggles: [...DEV_ALL.toggles] },
      permissionMode: "acceptEdits",
    }),
    // The native hook path: local:cli, no Developer mode, default mode.
    decide({
      classification: c,
      origin: "local:cli",
      originAllowed: true,
      devMode: { on: false, toggles: [], since: null },
      permissionMode: "default",
    }),
  ].some((d) => d.action === "allow");
  const coord = coordAnswer({
    classification: c,
    toolName: tool,
    input,
    workspaceLabel: "home",
    branchPrefix: "coord/p1/",
    ceiling: ALL,
    rules: new Set(["*"]),
    hash: () => "*",
  });
  return { c, auto: allows || coord !== null, coord };
};

describe("workspaceProblem with the home folder allowed", () => {
  const linux = { home: "/home/ana", chalitoDir: "/home/ana/.chalito", platform: "linux" as const };
  const mac = { home: "/Users/ana", chalitoDir: "/Users/ana/.chalito", platform: "darwin" as const };
  const win = { home: "C:\\Users\\ana", chalitoDir: "C:\\Users\\ana\\.chalito", platform: "win32" as const };

  it("the home folder itself is allowed, on every OS (case-folded where the OS folds)", () => {
    expect(workspaceProblem("/home/ana", linux)).toBeNull();
    expect(workspaceProblem("/Users/ana", mac)).toBeNull();
    expect(workspaceProblem("/users/ANA", mac)).toBeNull();
    expect(workspaceProblem("C:\\Users\\ana", win)).toBeNull();
    expect(workspaceProblem("c:\\users\\ana", win)).toBeNull();
  });

  it("root, above home, /home and /Users themselves, other homes and system folders stay refused", () => {
    for (const p of ["/", "/home", "/home/beto", "/home/beto/code", "/etc", "/usr/local/x", "/var/www"])
      expect(workspaceProblem(p, linux), p).toBe("too_broad");
    for (const p of ["/", "/Users", "/Users/beto", "/System/Library", "/Library/x"])
      expect(workspaceProblem(p, mac), p).toBe("too_broad");
    for (const p of ["C:\\", "C:\\Users", "C:\\Users\\beto", "C:\\Windows\\System32"])
      expect(workspaceProblem(p, win), p).toBe("too_broad");
    // A home folder that is the disk root never makes the disk root a workspace.
    expect(workspaceProblem("/", { ...linux, home: "/" })).toBe("too_broad");
  });

  it("every fence folder, and every folder inside one, is still refused as a workspace on its own", () => {
    const pathDirs = ["/home/ana/.local/bin"];
    for (const rel of [".chalito", ...SENSITIVE_DIRS, ...STARTUP_DIRS, ...AI_CONFIG_DIRS])
      for (const p of [`/home/ana/${rel}`, `/home/ana/${rel}/sub`])
        expect(workspaceProblem(p, { ...linux, pathDirs }), p).not.toBeNull();
    // Every fence is in the one exported list.
    for (const rel of [".chalito", ...SENSITIVE_DIRS, ...STARTUP_DIRS, ...AI_CONFIG_DIRS])
      expect(FENCES).toContain(rel);
    expect(workspaceProblem("/home/ana/.ssh", linux)).toBe("sensitive");
    expect(workspaceProblem("/home/ana/.chalito", linux)).toBe("chalito_folder");
    expect(workspaceProblem("/home/ana/.claude/projects", linux)).toBe("ai_config");
    expect(workspaceProblem("/home/ana/.config/systemd/user", linux)).toBe("startup");
    expect(workspaceProblem("/home/ana/.local/bin", { ...linux, pathDirs })).toBe("startup");
    // Folders above a fence (other than home) are refused too: ~/.config holds ~/.config/gcloud.
    expect(workspaceProblem("/home/ana/.config", linux)).toBe("sensitive");
    // Projects in the home folder are fine.
    expect(workspaceProblem("/home/ana/projects/x", linux)).toBeNull();
  });

  it("an excluded folder (workspaceExclude), anything in it, or above it, is refused", () => {
    const exclude = ["/home/ana/wayak"];
    expect(workspaceProblem("/home/ana/wayak", { ...linux, exclude })).toBe("excluded");
    expect(workspaceProblem("/home/ana/wayak/repo", { ...linux, exclude })).toBe("excluded");
    expect(workspaceProblem("/home/ana", { ...linux, exclude })).toBeNull();
    expect(workspaceProblem("/home/ana/projects", { ...linux, exclude })).toBeNull();
  });

  it("addWorkspace: the real home folder is added (marked home); a symlink into ~/.ssh is refused", async () => {
    const h = makeHome();
    let policy: Policy = { ...DEFAULT_POLICY, workspaces: [], workspaceExclude: [join(h.home, "wayak")] };
    const d = {
      policy: { get: () => policy, set: async (p: Policy) => void (policy = p) },
      osAuth: { verify: async () => true },
      locale: "en" as const,
      chalitoDir: join(h.home, ".chalito"),
      home: h.home,
      platform: "linux" as const,
      pathDirs: [join(h.home, ".local/bin")],
      emit: () => undefined,
    };
    expect(await addWorkspace(d as never, join(h.home, "projects/x/keys"))).toEqual({ ok: false, reason: "sensitive" });
    // ~/.claude holds ~/.claude/.credentials.json, so it's refused as a credentials folder.
    expect(await addWorkspace(d as never, join(h.home, "projects/x/claude-cfg"))).toMatchObject({ ok: false });
    expect(await addWorkspace(d as never, join(h.home, "wayak/repo"))).toEqual({ ok: false, reason: "excluded" });
    expect(await addWorkspace(d as never, join(h.home, "projects", ".."))).toMatchObject({
      ok: true,
      added: true,
      home: true,
    });
    expect(policy.workspaces.map((w) => w.path)).toEqual([h.home]);
    expect(await addWorkspace(d as never, dirname(h.home))).toEqual({ ok: false, reason: "too_broad" });
  });
});

describe("fences inside a home-folder workspace: nothing answers for the human", () => {
  const h = makeHome();
  const H = h.home;

  const fenced: [string, string, Record<string, unknown>, string?][] = [
    ["edit ~/.bashrc", "Edit", { file_path: `${H}/.bashrc`, old_string: "a", new_string: "b" }],
    ["write ~/.chalito/policy.yaml", "Write", { file_path: `${H}/.chalito/policy.yaml`, content: "x" }],
    ["read ~/.ssh/id_ed25519", "Read", { file_path: `${H}/.ssh/id_ed25519` }],
    [
      "edit ~/.claude/settings.json",
      "Edit",
      { file_path: `${H}/.claude/settings.json`, old_string: "a", new_string: "b" },
    ],
    ["edit ~/.codex/config.toml", "Edit", { file_path: `${H}/.codex/config.toml`, old_string: "a", new_string: "b" }],
    ["cat ~/.aws/credentials", "Bash", { command: "cat ~/.aws/credentials" }],
    ["echo x >> ~/.profile", "Bash", { command: "echo x >> ~/.profile" }],
    ["read a key through a symlink in a project", "Read", { file_path: `${H}/projects/x/key.txt` }],
    [
      "edit AI settings through a symlinked folder",
      "Edit",
      { file_path: `${H}/projects/x/claude-cfg/settings.json`, old_string: "a", new_string: "b" },
    ],
    ["cat a key through a symlinked folder", "Bash", { command: "cat keys/id_ed25519" }],
    ["read ~/.bashrc", "Read", { file_path: `${H}/.bashrc` }],
    ["read ~/.claude/settings.json", "Read", { file_path: `${H}/.claude/settings.json` }],
    ["cat ~/.bashrc", "Bash", { command: "cat ~/.bashrc" }],
    ["read a PATH folder's file", "Read", { file_path: `${H}/.local/bin/tool` }],
    ["Grep over the whole home folder", "Grep", { pattern: "PRIVATE KEY", path: H }],
    ["Glob over the whole home folder", "Glob", { pattern: "**/*", path: H }],
    ["grep -r over home", "Bash", { command: "grep -r 'PRIVATE KEY' ~" }],
    ["grep -r with $HOME", "Bash", { command: 'grep -r token "$HOME"' }],
    ["dot-glob over home", "Bash", { command: "cat ~/.*/*" }],
    ["dot-glob relative to home", "Bash", { command: "cat ../../.*/*" }],
    ["tar of home", "Bash", { command: "tar czf /tmp/x.tgz ~" }],
    ["copy into home (could overwrite a startup file)", "Bash", { command: "cp -r src/ ~/" }],
    ["cd home then search", "Bash", { command: "cd ~ && grep -r token ." }],
    ["git -C home", "Bash", { command: "git -C ~ status" }],
    ["read in the excluded work folder", "Read", { file_path: `${H}/wayak/repo/README.md` }],
    [
      "edit in the excluded work folder",
      "Edit",
      { file_path: `${H}/wayak/repo/README.md`, old_string: "a", new_string: "b" },
    ],
    ["cat in the excluded work folder", "Bash", { command: "cat ~/wayak/repo/README.md" }],
  ];

  for (const [name, tool, input] of fenced)
    it(`${name}: never auto-approved (coordinator, Developer mode, acceptEdits, native)`, () => {
      const r = answeredFor(tool, input, h.ctx());
      expect(r.auto, JSON.stringify(r.c)).toBe(false);
      expect(r.c.fenced || r.c.hardFloor, JSON.stringify(r.c)).toBe(true);
      expect(["HIGH", "CRITICAL"]).toContain(r.c.tier);
    });

  it("a session running in the home folder itself asks for every command (it can reach any fence)", () => {
    for (const command of ["ls", "grep -r token", "git status", "pnpm test", "rg PRIVATE"]) {
      const r = answeredFor("Bash", { command }, h.ctx(H));
      expect(r.auto, command).toBe(false);
      expect(r.c.fenced, command).toBe(true);
    }
    expect(answeredFor("Grep", { pattern: "x" }, h.ctx(H)).auto).toBe(false);
  });

  it("a session whose cwd is inside a fence asks too", () => {
    expect(answeredFor("Bash", { command: "ls" }, h.ctx(`${H}/.claude`)).auto).toBe(false);
  });

  it("normal work in ~/projects/x still auto-approves within the coordinator ceiling", () => {
    const edit = answeredFor("Edit", { file_path: `${h.project}/src/a.ts`, old_string: "a", new_string: "b" }, h.ctx());
    expect(edit.coord).toEqual({ via: "coordinator_auto", kind: "workspace_edit" });
    expect(answeredFor("Read", { file_path: `${h.project}/src/a.ts` }, h.ctx()).coord).toEqual({
      via: "coordinator_auto",
      kind: "read",
    });
    expect(answeredFor("Bash", { command: "pnpm test" }, h.ctx()).coord).toEqual({
      via: "coordinator_auto",
      kind: "tests",
    });
    expect(answeredFor("Bash", { command: "git add -A && git commit -m wip" }, h.ctx()).coord).toEqual({
      via: "coordinator_auto",
      kind: "git_local",
    });
    // Plain files in the home folder are workspace files too.
    expect(answeredFor("Read", { file_path: `${H}/notes.txt` }, h.ctx()).c).toMatchObject({ tier: "LOW" });
    expect(answeredFor("Bash", { command: "cd ~/projects/x && pnpm test" }, h.ctx(H)).c.fenced).toBeUndefined();
  });

  it("a dotfiles repo at the home folder: git there is fenced, a project's own repo is not", () => {
    const d = makeHome();
    mkdirSync(join(d.home, ".git"));
    const git = (cwd: string) => answeredFor("Bash", { command: "git add -A && git commit -m wip" }, d.ctx(cwd));
    expect(git(d.project).auto).toBe(false);
    expect(git(d.project).c.fenced).toBe(true);
    expect(answeredFor("Bash", { command: "git diff" }, d.ctx()).auto).toBe(false);
    mkdirSync(join(d.project, ".git"));
    expect(git(d.project).coord).toEqual({ via: "coordinator_auto", kind: "git_local" });
    expect(answeredFor("Bash", { command: "git -C ../.. diff" }, d.ctx()).auto).toBe(false);
  });

  it("a session started in the excluded folder has no workspace", () => {
    expect(classifyToolCall("Read", { file_path: "README.md" }, h.ctx(`${H}/wayak/repo`)).noWorkspace).toBe(true);
  });

  it("an ordinary project workspace keeps its behaviour (no fence inside it)", () => {
    const p: Policy = { ...DEFAULT_POLICY, workspaces: [{ label: "x", path: h.project }] };
    const c = classifyToolCall("Bash", { command: "grep -r token ." }, h.ctx(h.project, p));
    expect(c).toMatchObject({ tier: "LOW", readOnly: true });
    expect(c.fenced).toBeUndefined();
  });
});

describe("workspaceExclude across the agent", () => {
  it("the native hook's workspace lookup and its offline file treat an excluded folder as outside", () => {
    const h = makeHome();
    const svc = codeService(
      { localCommand: async () => ({ ok: true }), tap: () => () => undefined } as never,
      () => h.policy,
      (() => ({})) as never,
      "local:cli",
      h.home,
    );
    expect(svc.workspaceFor(h.project)).toBe("home");
    expect(svc.workspaceFor(join(h.home, "wayak/repo"))).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "chalito-nw-"));
    writeNativeWorkspaces(
      dir,
      nativeWorkspacePaths(h.policy.workspaces, h.home),
      nativeWorkspacePaths(
        h.policy.workspaceExclude!.map((path) => ({ path })),
        h.home,
      ),
    );
    expect(nativeWorkspaceStatus(dir, h.project)).toBe("inside");
    expect(nativeWorkspaceStatus(dir, join(h.home, "wayak/repo"))).toBe("outside");
    expect(nativeWorkspaceStatus(dir, join(h.home, "wayak-other"))).toBe("inside");
  });

  it("a remote tighten may add an exclude but never drop one", () => {
    const h = makeHome();
    const fs = { home: h.home };
    const more = { ...h.policy, workspaceExclude: [...h.policy.workspaceExclude!, join(h.home, "notes.txt")] };
    expect(isTighterOrEqual(more, h.policy, fs)).toBe(true);
    expect(isTighterOrEqual({ ...h.policy, workspaceExclude: [] }, h.policy, fs)).toBe(false);
    const { workspaceExclude: _dropped, ...none } = h.policy;
    expect(isTighterOrEqual(none, h.policy, fs)).toBe(false);
  });
});
