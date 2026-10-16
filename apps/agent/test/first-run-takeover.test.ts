import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppConnectionDoc } from "@chalito/protocol";
import { checkClaudePin, pinClaude, sha256Fd, type ClaudePin } from "../src/claude-pin.js";
import { BUILTIN_CATALOG, type CatalogEntry } from "../src/apps/catalog.js";
import { AppManager, knownBinDirs } from "../src/apps/manager.js";
import { ipcHandlers } from "../src/ipc-handlers.js";
import { DEFAULT_POLICY, classifyToolCall, type Policy } from "../src/policy/index.js";
import { SENSITIVE_FILES, USER_BIN_DIRS } from "../src/policy/persistence.js";
import { createLogger } from "../src/redact.js";
import { MemorySecretStore } from "../src/secrets.js";
import { addWorkspace, labelFor, removeWorkspace, workspaceProblem } from "../src/workspaces.js";
import { fakeProviderProcs } from "./fake-provider-procs.js";

/** First Run C (ADR 0028): agents found and trusted from the panel, workspaces from a folder picker. */

const exe = (dir: string, name: string, body = "") => {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n# ${name} ${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
const curated = (id: string): CatalogEntry => ({
  recipe: BUILTIN_CATALOG.recipes.find((r) => r.id === id)!,
  custom: false,
  enabled: true,
});

const setup = (o: { pathDirs?: string[] } = {}) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "chalito-fr-c-")));
  const dir = join(home, ".chalito");
  mkdirSync(dir, { recursive: true });
  const pins = new Map<string, ClaudePin>();
  const reports: [string, AppConnectionDoc][] = [];
  let changes = 0;
  const m = new AppManager({
    dir,
    // A login service's short PATH: nothing of the person's own folders.
    env: { PATH: (o.pathDirs ?? [join(home, "empty")]).join(":"), HOME: home },
    platform: "linux",
    secrets: new MemorySecretStore(),
    procs: fakeProviderProcs().procs,
    entries: () => [curated("aider")],
    signinAllowed: () => false,
    pins: { get: (a) => pins.get(a), set: async (a, pin) => void pins.set(a, pin) },
    report: async (a, doc) => void reports.push([a, AppConnectionDoc.parse(doc)]),
    onChange: () => void changes++,
    now: () => 1_790_000_000_000,
    log: createLogger(() => undefined),
  });
  return { m, home, dir, pins, reports, changes: () => changes };
};

describe("agent auto-detect: the installers' own folders, not only PATH", () => {
  it("lists Homebrew, ~/.local/bin, npm's and the vendors' folders per OS", () => {
    const env = {
      HOME: "/h",
      APPDATA: "C:\\U\\a\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\U\\a\\AppData\\Local",
      ProgramFiles: "C:\\Program Files",
      USERPROFILE: "C:\\U\\a",
    };
    expect(knownBinDirs("darwin", env)).toEqual(
      expect.arrayContaining([
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/h/.local/bin",
        "/h/.claude/local",
        "/h/.npm-global/bin",
      ]),
    );
    expect(knownBinDirs("linux", env)).toEqual(
      expect.arrayContaining(["/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", "/h/.local/bin"]),
    );
    expect(knownBinDirs("win32", env)).toEqual(
      expect.arrayContaining([
        "C:\\U\\a\\AppData\\Roaming\\npm",
        "C:\\U\\a\\AppData\\Local\\Microsoft\\WinGet\\Links",
        "C:\\Program Files\\nodejs",
        "C:\\U\\a\\.local\\bin",
      ]),
    );
    // Missing variables just drop their folders.
    expect(knownBinDirs("win32", {}).some((d) => d.includes("undefined"))).toBe(false);
  });

  it("finds a CLI in ~/.local/bin when the service's PATH doesn't have it, and shows it as not trusted yet", async () => {
    const s = setup();
    const aider = exe(join(s.home, ".local", "bin"), "aider");
    expect(await s.m.findCli("aider")).toBe(aider);
    expect(await s.m.pinView("aider")).toEqual({
      state: "not_pinned",
      path: null,
      detected: aider,
      sha256: await sha256Fd(aider),
    });
    expect((await s.m.view())[0]!.pin?.state).toBe("not_pinned");
  });

  it('nothing installed: not pinned and nothing detected; "Usar" fails cleanly', async () => {
    const s = setup();
    expect(await s.m.pinView("aider")).toEqual({ state: "not_pinned", path: null, detected: null, sha256: null });
    expect(await s.m.pin("aider", "0".repeat(64))).toEqual({ ok: false, reason: "pin_failed" });
    expect(s.pins.size).toBe(0);
  });
});

describe('"Usar" and "se actualizó: confirmar" (local pin of what the panel showed)', () => {
  const shown = async (s: ReturnType<typeof setup>) => (await s.m.pinView("aider"))!.sha256!;

  it("pins the detected CLI (path + sha256) when it still hashes to what was shown", async () => {
    const s = setup();
    const aider = exe(join(s.home, ".local", "bin"), "aider");
    expect(await s.m.pin("aider", await shown(s))).toEqual({ ok: true });
    expect(s.pins.get("aider")).toEqual({ path: aider, sha256: await sha256Fd(aider) });
    expect(await s.m.pinView("aider")).toEqual({ state: "pinned", path: aider, detected: null, sha256: null });
    expect(s.changes()).toBe(1);
    expect(s.reports.some(([a]) => a === "aider")).toBe(true);
  });

  it("refuses when the file changed between showing it and the click", async () => {
    const s = setup();
    const aider = exe(join(s.home, ".local", "bin"), "aider");
    const seen = await shown(s);
    writeFileSync(aider, "#!/bin/sh\n# swapped after the panel showed it\n");
    expect(await s.m.pin("aider", seen)).toEqual({ ok: false, reason: "pin_mismatch" });
    expect(s.pins.size).toBe(0);
    // The panel re-reads: it now shows the new hash, and that one pins.
    expect(await s.m.pin("aider", await shown(s))).toEqual({ ok: true });
  });

  it("a self-updated binary shows as changed until the person confirms the version shown", async () => {
    const s = setup();
    const aider = exe(join(s.home, ".local", "bin"), "aider");
    await s.m.pin("aider", await shown(s));
    const before = s.pins.get("aider")!.sha256;
    writeFileSync(aider, "#!/bin/sh\n# aider 2.0, a longer file\n");
    const v = (await s.m.pinView("aider"))!;
    expect(v).toEqual({ state: "changed", path: aider, detected: aider, sha256: await sha256Fd(aider) });
    expect(await s.m.pin("aider", before)).toEqual({ ok: false, reason: "pin_mismatch" });
    expect(await s.m.pin("aider", v.sha256!)).toEqual({ ok: true });
    expect(s.pins.get("aider")!.sha256).toBe(v.sha256);
  });

  it("refuses a world-writable binary or folder, like `chalito <tool> pin`", async () => {
    const s = setup();
    const dir = join(s.home, ".local", "bin");
    const aider = exe(dir, "aider");
    const seen = await shown(s);
    chmodSync(aider, 0o777);
    expect(await s.m.pin("aider", seen)).toEqual({ ok: false, reason: "pin_failed" });
    chmodSync(aider, 0o755);
    chmodSync(dir, 0o777);
    expect(await s.m.pin("aider", seen)).toEqual({ ok: false, reason: "pin_failed" });
    await expect(pinClaude(aider)).rejects.toThrow(/world-writable/);
    chmodSync(dir, 0o755);
    expect(s.pins.size).toBe(0);
  });

  it("the exec-path check reads afresh: a world-writable folder or file fails it", async () => {
    const s = setup();
    const dir = join(s.home, ".local", "bin");
    const aider = exe(dir, "aider");
    const pin = await pinClaude(aider);
    expect(await checkClaudePin(pin)).toEqual({ ok: true });
    chmodSync(dir, 0o777);
    expect(await checkClaudePin(pin)).toEqual({ ok: false, reason: "world_writable" });
    chmodSync(dir, 0o755);
    chmodSync(aider, 0o777);
    expect(await checkClaudePin(pin)).toEqual({ ok: false, reason: "world_writable" });
    chmodSync(aider, 0o755);
    // Same size, same mtime, different bytes: a cache keyed on size+mtime would miss this; the check doesn't.
    const { statSync, utimesSync } = await import("node:fs");
    const st = statSync(aider);
    writeFileSync(aider, readFileSync(aider, "utf8").replace("aider", "xxxxx"));
    utimesSync(aider, st.atime, st.mtime);
    expect(await checkClaudePin(pin)).toEqual({ ok: false, reason: "hash_mismatch" });
    expect(await checkClaudePin({ path: join(dir, "gone"), sha256: pin.sha256 })).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("a pinned file that became world-writable is unsafe, a deleted one is missing", async () => {
    const s = setup();
    const aider = exe(join(s.home, ".local", "bin"), "aider");
    await s.m.pin("aider", await shown(s));
    chmodSync(aider, 0o777);
    expect((await s.m.pinView("aider"))?.state).toBe("unsafe");
    chmodSync(aider, 0o755);
    rmSync(aider);
    expect(await s.m.pinView("aider")).toEqual({ state: "missing", path: aider, detected: null, sha256: null });
  });

  it("a remote connect never replaces a pin: a changed binary still needs the local yes", async () => {
    const s = setup();
    const aider = exe(join(s.home, ".local", "bin"), "aider");
    await s.m.pin("aider", await shown(s));
    const pinned = s.pins.get("aider")!;
    writeFileSync(aider, "#!/bin/sh\n# swapped by someone else\n");
    // The remote app.connect path (a key from the phone) goes through connectKey.
    await s.m.connectKey("aider", "sk-remote-123");
    expect(s.pins.get("aider")).toEqual(pinned);
    expect((await s.m.pinView("aider"))?.state).toBe("changed");
  });

  it("the panel's pinApp needs the hash it showed", async () => {
    const s = setup();
    exe(join(s.home, ".local", "bin"), "aider");
    const h = ipcHandlers({ apps: s.m } as never);
    await expect(h.pinApp!({ appId: "aider" })).rejects.toThrow("bad_params");
    await expect(h.pinApp!({ appId: "aider", sha256: "f".repeat(64) })).rejects.toThrow("pin_mismatch");
    expect(await h.pinApp!({ appId: "aider", sha256: await shown(s) })).toEqual({ ok: true });
    await expect(h.pinApp!({ appId: "goose", sha256: "f".repeat(64) })).rejects.toThrow("unknown_app");
  });
});

describe("workspaces from the OS folder picker (local, OS-checked)", () => {
  const ws = (o: { auth?: boolean } = {}) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "chalito-ws-")));
    const chalitoDir = join(home, ".chalito");
    mkdirSync(chalitoDir);
    let policy: Policy = { ...DEFAULT_POLICY, workspaces: [] };
    const sets: [Policy, string][] = [];
    const asked: string[] = [];
    const events: string[] = [];
    const d = {
      policy: {
        get: () => policy,
        set: async (p: Policy, via: "local") => {
          sets.push([p, via]);
          policy = p;
        },
      },
      osAuth: {
        verify: async (reason: string) => {
          asked.push(reason);
          return o.auth ?? true;
        },
      },
      locale: "es" as const,
      chalitoDir,
      home,
      platform: "linux" as const,
      emit: (type: string) => void events.push(type),
    };
    return { d, home, chalitoDir, sets, asked, events, policy: () => policy };
  };
  const linux = { home: "/home/ana", chalitoDir: "/home/ana/.chalito", platform: "linux" as const };
  const mac = { home: "/Users/ana", chalitoDir: "/Users/ana/.chalito", platform: "darwin" as const };
  const win = { home: "C:\\Users\\ana", chalitoDir: "C:\\Users\\ana\\.chalito", platform: "win32" as const };

  it("adds the chosen folder after the OS check, signed as a local change, labelled by its name", async () => {
    const w = ws();
    const proj = join(w.home, "code", "mi-proyecto");
    mkdirSync(proj, { recursive: true });
    expect(await addWorkspace(w.d as never, proj)).toEqual({ ok: true, label: "mi-proyecto", added: true });
    expect(w.asked).toEqual(["Chalito: permitir trabajar en la carpeta «mi-proyecto»"]);
    expect(w.sets).toHaveLength(1);
    expect(w.sets[0]![1]).toBe("local");
    expect(w.policy().workspaces).toEqual([{ label: "mi-proyecto", path: proj }]);
    expect(w.events).toEqual(["workspace.added"]);
  });

  it("a refused OS check changes nothing", async () => {
    const w = ws({ auth: false });
    const proj = join(w.home, "p");
    mkdirSync(proj);
    expect(await addWorkspace(w.d as never, proj)).toEqual({ ok: false, reason: "os_auth_failed" });
    expect(w.sets).toHaveLength(0);
  });

  it("the same folder twice is not added again (and needs no OS check)", async () => {
    const w = ws();
    const proj = join(w.home, "p");
    mkdirSync(proj);
    await addWorkspace(w.d as never, proj);
    expect(await addWorkspace(w.d as never, proj)).toEqual({ ok: true, label: "p", added: false });
    expect(w.asked).toHaveLength(1);
  });

  it("two folders with the same name get distinct labels", async () => {
    const w = ws();
    for (const p of ["a/app", "b/app"]) mkdirSync(join(w.home, p), { recursive: true });
    await addWorkspace(w.d as never, join(w.home, "a/app"));
    expect(await addWorkspace(w.d as never, join(w.home, "b/app"))).toMatchObject({ label: "app-2" });
    expect(labelFor("/x/app", ["app", "app-2"], "linux")).toBe("app-3");
  });

  it("refuses the home folder, the disk root, Chalito's own folder and anything inside it", async () => {
    const w = ws();
    expect(await addWorkspace(w.d as never, w.home)).toEqual({ ok: false, reason: "too_broad" });
    expect(await addWorkspace(w.d as never, "/")).toEqual({ ok: false, reason: "too_broad" });
    expect(await addWorkspace(w.d as never, w.chalitoDir)).toEqual({ ok: false, reason: "chalito_folder" });
    mkdirSync(join(w.chalitoDir, "logs"));
    expect(await addWorkspace(w.d as never, join(w.chalitoDir, "logs"))).toEqual({
      ok: false,
      reason: "chalito_folder",
    });
    expect(w.asked).toHaveLength(0);
  });

  it("a symlink into ~/.chalito, or a `..` path that lands in it, is refused", async () => {
    const w = ws();
    mkdirSync(join(w.home, "code"));
    symlinkSync(w.chalitoDir, join(w.home, "code", "innocent"));
    expect(await addWorkspace(w.d as never, join(w.home, "code", "innocent"))).toEqual({
      ok: false,
      reason: "chalito_folder",
    });
    expect(await addWorkspace(w.d as never, join(w.home, "code", "..", ".chalito"))).toEqual({
      ok: false,
      reason: "chalito_folder",
    });
    expect(await addWorkspace(w.d as never, join(w.home, "code", ".."))).toEqual({ ok: false, reason: "too_broad" });
    expect(w.asked).toHaveLength(0);
  });

  it("case variants can't get around the refusals on macOS and Windows", () => {
    expect(workspaceProblem("/USERS/ANA", mac)).toBe("too_broad");
    expect(workspaceProblem("/Users/ana/.CHALITO", mac)).toBe("chalito_folder");
    expect(workspaceProblem("/users/ana/.Ssh/keys", mac)).toBe("sensitive");
    expect(workspaceProblem("/SYSTEM/Library", mac)).toBe("too_broad");
    expect(workspaceProblem("c:\\users\\ANA\\.chalito\\logs", win)).toBe("chalito_folder");
    expect(workspaceProblem("C:\\WINDOWS\\system32", win)).toBe("too_broad");
    expect(workspaceProblem("c:\\program files\\app", win)).toBe("too_broad");
    // NFC: a decomposed "é" is the same folder as the composed one.
    expect(workspaceProblem("/Users/ana/proyecto-cafe\u0301", mac)).toBeNull();
    // Linux file systems are case-sensitive: a different case is a different folder.
    expect(workspaceProblem("/home/ana/.CHALITO", linux)).toBeNull();
  });

  it("Windows 8.3 short names are resolved by the OS before the check (PROGRA~1, CHALIT~1)", async () => {
    const short: Record<string, string> = {
      "C:\\PROGRA~1\\Vendor": "C:\\Program Files\\Vendor",
      "C:\\Users\\ana\\CHALIT~1": "C:\\Users\\ana\\.chalito",
      "C:\\Users\\ana\\CODE~1\\web": "C:\\Users\\ana\\code\\web",
    };
    const policyState = { workspaces: [] as { label: string; path: string }[] };
    const d = {
      policy: {
        get: () => ({ ...DEFAULT_POLICY, ...policyState }),
        set: async (p: Policy) => void (policyState.workspaces = p.workspaces),
      },
      osAuth: { verify: async () => true },
      locale: "en" as const,
      chalitoDir: win.chalitoDir,
      home: win.home,
      platform: "win32" as const,
      realpath: (p: string) => short[p] ?? p,
      isDirectory: () => true,
      emit: () => undefined,
    };
    expect(await addWorkspace(d as never, "C:\\PROGRA~1\\Vendor")).toEqual({ ok: false, reason: "too_broad" });
    expect(await addWorkspace(d as never, "C:\\Users\\ana\\CHALIT~1")).toEqual({
      ok: false,
      reason: "chalito_folder",
    });
    expect(await addWorkspace(d as never, "C:\\Users\\ana\\CODE~1\\web")).toEqual({
      ok: true,
      label: "web",
      added: true,
    });
    expect(policyState.workspaces).toEqual([{ label: "web", path: "C:\\Users\\ana\\code\\web" }]);
  });

  it("refuses system folders and everything under them, on every OS", () => {
    for (const p of [
      "/etc",
      "/etc/nginx/sites",
      "/usr/local/src/app",
      "/var/www/site",
      "/private/var/x",
      "/opt/homebrew/Cellar/x",
      "/proc/1",
      "/sys/class",
      "/dev/shm/x",
      "/boot/efi",
      "/bin",
      "/sbin/x",
    ])
      expect(workspaceProblem(p, linux), p).toBe("too_broad");
    for (const p of ["/System/Library/x", "/Library/Application Support/x", "/Applications/Xcode.app"])
      expect(workspaceProblem(p, mac), p).toBe("too_broad");
    for (const p of [
      "C:\\Windows",
      "C:\\Windows\\System32\\drivers",
      "C:\\Program Files (x86)\\x",
      "D:\\ProgramData\\x",
    ])
      expect(workspaceProblem(p, win), p).toBe("too_broad");
    // Mount points as a whole are too broad; a project on a drive is fine.
    expect(workspaceProblem("/mnt", linux)).toBe("too_broad");
    expect(workspaceProblem("/mnt/data/projects/app", linux)).toBeNull();
    expect(workspaceProblem("/Volumes/Work/app", mac)).toBeNull();
    expect(workspaceProblem("/srv/projects/app", linux)).toBeNull();
    expect(workspaceProblem("D:\\code\\app", win)).toBeNull();
  });

  it("refuses another person's home folder", () => {
    expect(workspaceProblem("/home/beto/code", linux)).toBe("too_broad");
    expect(workspaceProblem("/home", linux)).toBe("too_broad");
    expect(workspaceProblem("/Users/beto/code", mac)).toBe("too_broad");
    expect(workspaceProblem("C:\\Users\\beto\\code", win)).toBe("too_broad");
    expect(workspaceProblem("C:\\Users", win)).toBe("too_broad");
    expect(workspaceProblem("/home/ana/code/app", linux)).toBeNull();
  });

  it("refuses credential folders in the home folder, and any folder above them", () => {
    for (const p of [
      ".ssh",
      ".ssh/keys",
      ".gnupg",
      ".aws",
      ".kube",
      ".docker",
      ".config/gcloud",
      ".config/gcloud/x",
      ".config",
    ])
      expect(workspaceProblem(`/home/ana/${p}`, linux), p).toBe("sensitive");
    expect(workspaceProblem("/Users/ana/Library/Keychains", mac)).toBe("sensitive");
    expect(workspaceProblem("/Users/ana/Library", mac)).toBe("sensitive");
    expect(workspaceProblem("/home/ana/.config-backup", linux)).toBeNull();
    expect(workspaceProblem("/home/ana/code/.ssh-tools", linux)).toBeNull();
  });

  it("refuses files, relative paths and missing folders", async () => {
    const w = ws();
    writeFileSync(join(w.home, "f.txt"), "x");
    expect(await addWorkspace(w.d as never, join(w.home, "f.txt"))).toEqual({ ok: false, reason: "not_a_folder" });
    expect(await addWorkspace(w.d as never, "relative/dir")).toEqual({ ok: false, reason: "not_a_folder" });
    expect(await addWorkspace(w.d as never, join(w.home, "nope"))).toEqual({ ok: false, reason: "not_a_folder" });
  });

  it("removing one only tightens: no OS check", async () => {
    const w = ws();
    mkdirSync(join(w.home, "p"));
    await addWorkspace(w.d as never, join(w.home, "p"));
    expect(await removeWorkspace(w.d, "p")).toBe(true);
    expect(await removeWorkspace(w.d, "p")).toBe(false);
    expect(w.policy().workspaces).toEqual([]);
    expect(w.asked).toHaveLength(1);
  });

  it("the panel handlers: list, add (OS-checked) and remove; without ~/.chalito they're unavailable", async () => {
    const w = ws();
    const proj = join(w.home, "deep", "proj");
    mkdirSync(proj, { recursive: true });
    const audit: string[] = [];
    const h = ipcHandlers({
      policy: w.d.policy,
      osAuth: () => w.d.osAuth,
      locale: () => "es",
      audit: (t: string) => void audit.push(t),
      chalitoDir: w.chalitoDir,
      home: w.home,
    } as never);
    expect(await h.addWorkspace!({ path: proj })).toEqual({ ok: true, label: "proj", added: true });
    expect(await h.workspaces!({})).toEqual({ workspaces: [{ label: "proj", path: proj }] });
    expect(await h.removeWorkspace!({ label: "proj" })).toEqual({ removed: true });
    expect(audit).toEqual(["workspace.added", "workspace.removed"]);
    await expect(h.addWorkspace!({})).rejects.toThrow("bad_params");
    const bare = ipcHandlers({ policy: w.d.policy } as never);
    await expect(bare.addWorkspace!({ path: proj })).rejects.toThrow("unavailable");
  });
});

describe("startup, autostart and PATH folders: never a workspace, and CRITICAL even inside one", () => {
  const linux = { home: "/home/ana", chalitoDir: "/home/ana/.chalito", platform: "linux" as const };
  const mac = { home: "/Users/ana", chalitoDir: "/Users/ana/.chalito", platform: "darwin" as const };
  const win = { home: "C:\\Users\\ana", chalitoDir: "C:\\Users\\ana\\.chalito", platform: "win32" as const };

  it("refuses the classifier's startup and PATH folders, and any folder above them", () => {
    for (const p of [
      ".local/bin",
      "bin",
      ".config/systemd/user",
      ".config/systemd",
      ".config/autostart",
      ".config/fish",
      ".cargo/bin",
      ".cargo",
      ".claude/local",
      "go",
    ])
      expect(workspaceProblem(`/home/ana/${p}`, linux), p).toBe("startup");
    expect(workspaceProblem("/Users/ana/Library/LaunchAgents", mac)).toBe("startup");
    expect(
      workspaceProblem("C:\\Users\\ana\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup", win),
    ).toBe("startup");
    expect(workspaceProblem("C:\\Users\\ana\\Documents\\PowerShell", win)).toBe("startup");
    expect(workspaceProblem("C:\\Users\\ana\\Documents", win)).toBe("startup");
    // The agent's own PATH folders too, wherever they are.
    expect(workspaceProblem("/home/ana/tools/bin", { ...linux, pathDirs: ["/home/ana/tools/bin"] })).toBe("startup");
    expect(workspaceProblem("/home/ana/tools", { ...linux, pathDirs: ["/home/ana/tools/bin"] })).toBe("startup");
    expect(workspaceProblem("/home/ana/code/app", { ...linux, pathDirs: ["/home/ana/tools/bin"] })).toBeNull();
    expect(workspaceProblem("/home/ana/code/app", linux)).toBeNull();
    expect(workspaceProblem("/home/ana/.localized-notes", linux)).toBeNull();
  });

  it("addWorkspace refuses a PATH folder from the agent's environment", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "chalito-ws-path-")));
    const tools = join(home, "tools", "bin");
    mkdirSync(tools, { recursive: true });
    mkdirSync(join(home, ".chalito"));
    const d = {
      policy: { get: () => ({ ...DEFAULT_POLICY }), set: async () => undefined },
      osAuth: { verify: async () => true },
      locale: "es" as const,
      chalitoDir: join(home, ".chalito"),
      home,
      platform: "linux" as const,
      pathDirs: [tools, "relative/bin"],
      emit: () => undefined,
    };
    expect(await addWorkspace(d as never, tools)).toEqual({ ok: false, reason: "startup" });
    expect(await addWorkspace(d as never, join(home, "tools"))).toEqual({ ok: false, reason: "startup" });
  });

  const HOME = "/home/ana";
  const withWorkspaces = (paths: string[], pathDirs: string[] = []) => ({
    policy: { ...DEFAULT_POLICY, workspaces: paths.map((p, i) => ({ label: `w${i}`, path: p })) },
    home: HOME,
    cwd: paths[0]!,
    realpath: (x: string) => x,
    pathDirs,
  });
  const write = (file_path: string, c: ReturnType<typeof withWorkspaces>) =>
    classifyToolCall("Write", { file_path, content: "x" }, c);

  it("a write to a startup folder or file is CRITICAL even when a (hand-edited) workspace covers it", () => {
    const home = withWorkspaces([HOME]);
    for (const f of [
      `${HOME}/.local/bin/git`,
      `${HOME}/.bashrc`,
      `${HOME}/.config/autostart/x.desktop`,
      `${HOME}/.config/systemd/user/x.service`,
      `${HOME}/Library/LaunchAgents/x.plist`,
      `${HOME}/.cargo/bin/cargo`,
    ]) {
      const c = write(f, home);
      expect(c.tier, f).toBe("CRITICAL");
      expect(c.reasons, f).toContain("startup file or PATH directory");
    }
    expect(classifyToolCall("Bash", { command: `cp x ${HOME}/.local/bin/ls` }, home).tier).toBe("CRITICAL");
    // An ordinary file in that workspace is not.
    expect(write(`${HOME}/notes/todo.md`, home).tier).not.toBe("CRITICAL");
  });

  it("a PATH folder inside a home-wide workspace stays CRITICAL; a project's own node_modules/.bin doesn't", () => {
    const c = withWorkspaces([HOME], [`${HOME}/tools/bin`]);
    expect(write(`${HOME}/tools/bin/node`, c).tier).toBe("CRITICAL");
    const project = withWorkspaces([`${HOME}/code/app`], [`${HOME}/code/app/node_modules/.bin`]);
    expect(write(`${HOME}/code/app/node_modules/.bin/tool`, project).tier).not.toBe("CRITICAL");
  });
});

describe("follow-up: one shared list, resolved like the folder being added", () => {
  const linux = { home: "/home/ana", chalitoDir: "/home/ana/.chalito", platform: "linux" as const };
  const win = { home: "C:\\Users\\ana", chalitoDir: "C:\\Users\\ana\\.chalito", platform: "win32" as const };

  const dotfiles = () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "chalito-dotfiles-")));
    mkdirSync(join(home, ".chalito"));
    mkdirSync(join(home, "dotfiles", "ssh"), { recursive: true });
    mkdirSync(join(home, "dotfiles", "fish"), { recursive: true });
    mkdirSync(join(home, ".config"));
    symlinkSync(join(home, "dotfiles", "ssh"), join(home, ".ssh"));
    symlinkSync(join(home, "dotfiles", "fish"), join(home, ".config", "fish"));
    mkdirSync(join(home, "code", "app"), { recursive: true });
    const d = {
      policy: { get: () => ({ ...DEFAULT_POLICY }), set: async () => undefined },
      osAuth: { verify: async () => true },
      locale: "es" as const,
      chalitoDir: join(home, ".chalito"),
      home,
      platform: "linux" as const,
      pathDirs: [],
      emit: () => undefined,
    };
    return { home, d };
  };

  it("a symlinked ~/.ssh (dotfiles manager) blocks its target and every folder above it", async () => {
    const { home, d } = dotfiles();
    expect(await addWorkspace(d as never, join(home, "dotfiles", "ssh"))).toEqual({ ok: false, reason: "sensitive" });
    expect(await addWorkspace(d as never, join(home, "dotfiles"))).toEqual({ ok: false, reason: "sensitive" });
    expect(await addWorkspace(d as never, join(home, "code", "app"))).toMatchObject({ ok: true });
  });

  it("a symlinked ~/.config/fish blocks its target too", async () => {
    const { home, d } = dotfiles();
    rmSync(join(home, ".ssh"));
    expect(await addWorkspace(d as never, join(home, "dotfiles", "fish"))).toEqual({ ok: false, reason: "startup" });
    expect(await addWorkspace(d as never, join(home, "dotfiles"))).toEqual({ ok: false, reason: "startup" });
  });

  it("the classifier's credential list is the workspaces' list", () => {
    for (const p of [".password-store", ".local/share/keyrings", ".local", ".codex", ".config/gh", ".claude"])
      expect(workspaceProblem(`/home/ana/${p}`, linux), p).toBe("sensitive");
    for (const f of [".npmrc", ".pypirc", ".git-credentials", ".claude/.credentials.json"]) {
      const c = classifyToolCall(
        "Read",
        { file_path: `/home/ana/${f}` },
        {
          policy: { ...DEFAULT_POLICY, workspaces: [] },
          home: "/home/ana",
          cwd: "/home/ana",
          realpath: (x: string) => x,
        },
      );
      expect(c.tier, f).toBe("CRITICAL");
    }
    for (const f of SENSITIVE_FILES.filter((x) => x.includes("/")))
      expect(workspaceProblem(`/home/ana/${f.split("/")[0]}`, linux), f).toBe("sensitive");
  });

  it("every installer bin folder is refused, on PATH or not, and the agent looks in all of them", () => {
    for (const p of [
      "AppData\\Roaming\\npm",
      "AppData\\Local\\Microsoft\\WinGet\\Links",
      "AppData\\Local\\Microsoft\\WindowsApps",
      "AppData\\Local",
    ])
      expect(workspaceProblem(`C:\\Users\\ana\\${p}`, win), p).toBe("startup");
    expect(workspaceProblem("/home/ana/.linuxbrew/bin", linux)).toBe("startup");
    expect(workspaceProblem("/home/ana/.linuxbrew", linux)).toBe("startup");
    const env = {
      HOME: "/h",
      USERPROFILE: "C:\\U\\a",
      APPDATA: "C:\\U\\a\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\U\\a\\AppData\\Local",
    };
    expect(knownBinDirs("win32", env)).toEqual(
      expect.arrayContaining(["C:\\U\\a\\AppData\\Local\\Microsoft\\WindowsApps", "C:\\U\\a\\.cargo\\bin"]),
    );
    expect(knownBinDirs("linux", env)).toEqual(expect.arrayContaining(["/h/.linuxbrew/bin", "/h/.volta/bin"]));
    for (const d of USER_BIN_DIRS.filter((x) => !x.startsWith("AppData/")))
      expect(knownBinDirs("linux", env), d).toContain(`/h/${d}`);
  });
});

describe("the AI tools' own config folders: never a workspace, writes CRITICAL", () => {
  const linux = { home: "/home/ana", chalitoDir: "/home/ana/.chalito", platform: "linux" as const };
  const mac = { home: "/Users/ana", chalitoDir: "/Users/ana/.chalito", platform: "darwin" as const };
  const win = { home: "C:\\Users\\ana", chalitoDir: "C:\\Users\\ana\\.chalito", platform: "win32" as const };

  it("refuses ~/.claude, ~/.codex, ~/.gemini, ~/.cursor, ~/.aider*, copilot's config, and anything inside them", () => {
    for (const p of [
      ".claude/commands",
      ".claude/agents",
      ".claude/skills/x",
      ".claude/plugins",
      ".codex/prompts",
      ".gemini",
      ".gemini/extensions/x",
      ".cursor",
      ".cursor/rules",
      ".aider",
      ".aider.tags.cache.v4",
      ".config/github-copilot",
    ])
      expect(workspaceProblem(`/home/ana/${p}`, linux), p).not.toBeNull();
    expect(workspaceProblem("/home/ana/.gemini/extensions/x", linux)).toBe("ai_config");
    expect(workspaceProblem("/home/ana/.cursor/rules", linux)).toBe("ai_config");
    expect(workspaceProblem("/home/ana/.aider.tags.cache.v4", linux)).toBe("ai_config");
    expect(workspaceProblem("/home/ana/.config/github-copilot", linux)).toBe("ai_config");
    // ~/.claude/local is still refused as a bin folder.
    expect(workspaceProblem("/home/ana/.claude/local", linux)).toBe("startup");
    expect(workspaceProblem("/Users/ana/Library/Application Support/Claude", mac)).toBe("ai_config");
    expect(workspaceProblem("/Users/ana/Library/Application Support", mac)).toBe("ai_config");
    expect(workspaceProblem("C:\\Users\\ana\\AppData\\Roaming\\Claude", win)).toBe("ai_config");
    expect(workspaceProblem("C:\\Users\\ana\\.CURSOR\\x", win)).toBe("ai_config");
    // Look-alike names are fine.
    expect(workspaceProblem("/home/ana/code/.claude-notes", linux)).toBeNull();
    expect(workspaceProblem("/home/ana/claude-projects/app", linux)).toBeNull();
  });

  it("writes there are CRITICAL, even when a hand-edited workspace covers the home folder", () => {
    const home = {
      policy: { ...DEFAULT_POLICY, workspaces: [{ label: "home", path: "/home/ana" }] },
      home: "/home/ana",
      cwd: "/home/ana",
      realpath: (x: string) => x,
    };
    for (const f of [
      ".claude/settings.json",
      ".claude/commands/deploy.md",
      ".claude/agents/x.md",
      ".claude/skills/x/SKILL.md",
      ".claude/plugins/x/hooks.json",
      ".codex/config.toml",
      ".gemini/settings.json",
      ".cursor/mcp.json",
      ".aider.conf.yml",
      ".config/github-copilot/apps.json",
    ]) {
      const c = classifyToolCall("Write", { file_path: `/home/ana/${f}`, content: "x" }, home);
      expect(c.tier, f).toBe("CRITICAL");
    }
    expect(classifyToolCall("Bash", { command: "cp hook.sh ~/.claude/hooks/" }, home).tier).toBe("CRITICAL");
    expect(classifyToolCall("Write", { file_path: "/home/ana/notes/aider.md", content: "x" }, home).tier).not.toBe(
      "CRITICAL",
    );
  });

  it("Windows folder redirection: AppData checks follow the real %APPDATA% and %LOCALAPPDATA%", async () => {
    const env = {
      USERPROFILE: "C:\\Users\\ana",
      APPDATA: "\\\\server\\profiles\\ana\\Roaming",
      LOCALAPPDATA: "D:\\Local\\ana",
    };
    const o = { ...win, env };
    expect(workspaceProblem("\\\\server\\profiles\\ana\\Roaming\\Claude", o)).toBe("ai_config");
    expect(workspaceProblem("\\\\server\\profiles\\ana\\Roaming\\npm", o)).toBe("startup");
    expect(
      workspaceProblem("\\\\server\\profiles\\ana\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup", o),
    ).toBe("startup");
    expect(workspaceProblem("\\\\server\\profiles\\ana\\Roaming\\Microsoft\\Credentials", o)).toBe("sensitive");
    expect(workspaceProblem("D:\\Local\\ana\\Microsoft\\WindowsApps", o)).toBe("startup");
    expect(workspaceProblem("D:\\Local\\ana\\github-copilot", o)).toBe("ai_config");
    expect(workspaceProblem("D:\\Local\\ana", o)).toBe("startup");
    expect(workspaceProblem("D:\\code\\app", o)).toBeNull();

    // addWorkspace feeds knownBinDirs(env) in as PATH folders too.
    const d = {
      policy: { get: () => ({ ...DEFAULT_POLICY }), set: async () => undefined },
      osAuth: { verify: async () => true },
      locale: "en" as const,
      chalitoDir: win.chalitoDir,
      home: win.home,
      platform: "win32" as const,
      env,
      pathDirs: [],
      realpath: (p: string) => p,
      isDirectory: () => true,
      emit: () => undefined,
    };
    expect(await addWorkspace(d as never, "D:\\Local\\ana\\Microsoft\\WinGet\\Links")).toEqual({
      ok: false,
      reason: "startup",
    });
    expect(await addWorkspace(d as never, "\\\\server\\profiles\\ana\\Roaming\\npm")).toEqual({
      ok: false,
      reason: "startup",
    });
    expect(await addWorkspace(d as never, "D:\\code\\app")).toMatchObject({ ok: true });
  });
});

describe("classifier parity: globs, case and redirected AppData", () => {
  const ctxFor = (o: Partial<Parameters<typeof classifyToolCall>[2]> = {}) => ({
    policy: { ...DEFAULT_POLICY, workspaces: [{ label: "app", path: "/home/ana/code/app" }] },
    home: "/home/ana",
    cwd: "/home/ana/code/app",
    realpath: (x: string) => x,
    ...o,
  });
  const sh = (command: string, c = ctxFor()) => classifyToolCall("Bash", { command }, c);

  it("a glob, brace or variable that can expand to ~/.aider* is persistence", () => {
    for (const cmd of [
      "cp evil.yml ~/.ai*",
      "cp evil.yml ~/.aider$X",
      "cp evil.yml ~/.aid{er.conf.yml,x}",
      "cp evil.yml ~/.aide?.conf.yml",
      "cp evil.yml ~/.aider.conf.yml",
      "cp hook.sh /home/ana/.aider/x",
    ]) {
      const c = sh(cmd);
      expect(c.tier, cmd).toBe("CRITICAL");
      expect(c.reasons, cmd).toContain("startup file or PATH directory");
    }
    // A plain glob can't match a leading dot.
    expect(sh("cp a.txt ~/notes/*").reasons).not.toContain("startup file or PATH directory");
  });

  it("macOS and Windows compare case-insensitively: ~/.CLAUDE/plugins and ~/.Codex are the real ones", () => {
    const mac = ctxFor({ platform: "darwin" });
    for (const f of [
      "/home/ana/.CLAUDE/plugins/x/hooks.json",
      "/home/ana/.Codex/config.toml",
      "/home/ana/.Aider.conf.yml",
    ]) {
      const c = classifyToolCall("Write", { file_path: f, content: "x" }, mac);
      expect(c.tier, f).toBe("CRITICAL");
    }
    expect(sh("cp x ~/.CLAUDE/commands/", mac).tier).toBe("CRITICAL");
    // Linux is case-sensitive: a different folder.
    expect(
      classifyToolCall("Write", { file_path: "/home/ana/.CLAUDE/plugins/x", content: "x" }, ctxFor()).reasons,
    ).not.toContain("startup file or PATH directory");
  });

  it("a redirected %APPDATA% / %LOCALAPPDATA% gets the same checks as the home-based one", () => {
    const c = ctxFor({ env: { APPDATA: "/net/profiles/ana/Roaming", LOCALAPPDATA: "/data/local/ana" } });
    for (const f of [
      "/net/profiles/ana/Roaming/Claude/claude_desktop_config.json",
      "/net/profiles/ana/Roaming/npm/claude.cmd",
      "/net/profiles/ana/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/x.lnk",
      "/data/local/ana/Microsoft/WindowsApps/python.exe",
      "/data/local/ana/github-copilot/apps.json",
    ]) {
      const r = classifyToolCall("Write", { file_path: f, content: "x" }, c);
      expect(r.tier, f).toBe("CRITICAL");
      expect(r.reasons, f).toContain("startup file or PATH directory");
    }
    expect(classifyToolCall("Read", { file_path: "/net/profiles/ana/Roaming/Microsoft/Credentials/x" }, c).tier).toBe(
      "CRITICAL",
    );
    // Without the env, those paths are just outside the workspace.
    expect(
      classifyToolCall("Write", { file_path: "/net/profiles/ana/Roaming/npm/claude.cmd", content: "x" }, ctxFor())
        .reasons,
    ).not.toContain("startup file or PATH directory");
  });
});

describe("follow-up 2: NFC-safe globs, more AI tools, in-workspace files that run code", () => {
  const ws = "/home/ana/code/app";
  const ctx = (o: Partial<Parameters<typeof classifyToolCall>[2]> = {}) => ({
    policy: { ...DEFAULT_POLICY, workspaces: [{ label: "app", path: ws }] },
    home: "/home/ana",
    cwd: ws,
    realpath: (x: string) => x,
    ...o,
  });
  const write = (file_path: string, c = ctx()) => classifyToolCall("Write", { file_path, content: "x" }, c);

  it("a `*` glob in the home folder can't match its dot-folders, even when NFC changes the path's length", () => {
    // macOS: the home folder comes back decomposed (NFD), the command spells it composed (NFC).
    const home = "/Users/josé";
    const c = ctx({
      platform: "darwin",
      home,
      cwd: `${home}/code/app`,
      policy: { ...DEFAULT_POLICY, workspaces: [{ label: "app", path: `${home}/code/app` }] },
    });
    const r = classifyToolCall("Bash", { command: "cp notes.txt /Users/josé/*" }, c);
    // ~/.chalito is a dot-folder: `*` can't reach it (before the fix, slicing the unfolded path
    // misaligned by one and made this the hard floor). ~/Library/Keychains is not a dot-folder, so
    // "credentials path" is right here.
    expect(r.hardFloor).toBe(false);
    expect(r.reasons).not.toContain("may touch ~/.chalito or the agent's own files");
    // A prefix that does name a dot-folder still reaches it.
    expect(classifyToolCall("Bash", { command: "cp x /Users/josé/.cl*" }, c).tier).toBe("CRITICAL");
  });

  it("Continue, Codeium/Windsurf, opencode and editor extensions are AI config", () => {
    for (const f of [
      ".continue/config.json",
      ".codeium/windsurf/mcp_config.json",
      ".windsurf/x",
      ".config/opencode/opencode.json",
      ".vscode/extensions/evil/package.json",
      ".config/Code/User/mcp.json",
      ".config/Windsurf/User/settings.json",
    ])
      expect(write(`/home/ana/${f}`).reasons, f).toContain("startup file or PATH directory");
    expect(write("/home/ana/Library/Application Support/Windsurf/x", ctx({ platform: "darwin" })).tier).toBe(
      "CRITICAL",
    );
    expect(write("/net/r/Code/User/tasks.json", ctx({ env: { APPDATA: "/net/r" } })).reasons).toContain(
      "startup file or PATH directory",
    );
    expect(
      workspaceProblem("/home/ana/.continue", {
        home: "/home/ana",
        chalitoDir: "/home/ana/.chalito",
        platform: "linux",
      }),
    ).toBe("ai_config");
    expect(
      workspaceProblem("/home/ana/.vscode", { home: "/home/ana", chalitoDir: "/home/ana/.chalito", platform: "linux" }),
    ).toBe("ai_config");
  });

  it("inside a workspace, files that make code run later need approval (HIGH), not MED", () => {
    for (const f of [
      ".git/hooks/pre-commit",
      ".git/hooks/sub/x",
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".claude/settings.team.json",
      ".envrc",
      "sub/.envrc",
      ".vscode/tasks.json",
      ".vscode/launch.json",
      ".devcontainer/devcontainer.json",
      ".devcontainer/scripts/post-create.sh",
      ".devcontainer.json",
    ]) {
      const c = write(`${ws}/${f}`);
      expect(c.tier, f).toBe("HIGH");
      expect(c.reasons, f).toContain("config/CI/.env");
    }
    // Ordinary source edits stay as before.
    for (const f of ["src/index.ts", "README.md", ".vscode/settings.json", "docs/envrc.md", "lib/devcontainer.ts"])
      expect(write(`${ws}/${f}`).tier, f).toBe("MED");
  });
});
