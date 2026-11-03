import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeConnectors, nativeHookCommands } from "../src/native/connectors.js";
import { seedOldHooks } from "./native-seed.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const setup = (verified = true, command = ["/opt/Chalito/chalito-agent"], home?: string) => {
  if (!home) {
    home = mkdtempSync(join(tmpdir(), "chalito-native-test-"));
    roots.push(home);
    mkdirSync(join(home, ".chalito"));
  }
  const dir = join(home, ".chalito");
  const verify = vi.fn().mockResolvedValue(verified);
  const onDisconnect = vi.fn();
  const logs: { event: string; meta: Record<string, unknown> }[] = [];
  const manager = new NativeConnectors({
    home,
    dir,
    command,
    platform: "linux",
    available: async () => true,
    verify,
    onDisconnect,
    log: (event, meta) => void logs.push({ event, meta }),
  });
  return { home, dir, verify, onDisconnect, manager, logs };
};

describe("Windows hook commands", () => {
  it("accepts non-ASCII user folders and still refuses cmd metacharacters", () => {
    const commands = nativeHookCommands(
      ["C:\\Users\\José Núñez\\AppData\\Local\\Chalito\\chalito-agent.exe"],
      "codex",
      "win32",
    );
    expect(commands[2]).toBe(
      '"C:\\Users\\José Núñez\\AppData\\Local\\Chalito\\chalito-agent.exe" "native-hook" "codex" "PreToolUse"',
    );
    for (const bad of ["C:\\a&b", "C:\\%PATH%", 'C:\\a"b', "C:\\a|b", "C:\\a<b", "C:\\a^b", "C:\\a!b", "C:\\a`b"])
      expect(() => nativeHookCommands([bad], "codex", "win32")).toThrow("unsafe_command");
  });
});

const PROVIDERS = ["codex", "claude", "cursor"] as const;
const preTool = (provider: (typeof PROVIDERS)[number]) => (provider === "cursor" ? "preToolUse" : "PreToolUse");
const unrelatedHook = (provider: (typeof PROVIDERS)[number]) =>
  provider === "cursor"
    ? { command: "existing-policy" }
    : { matcher: "Bash", hooks: [{ type: "command", command: "existing-policy" }] };

// Owner 2026-11-03 — Chalito is a bridge, not a gate: it never installs approval hooks, it only takes them out.
describe("connecting an AI app is retired", () => {
  it.each(PROVIDERS)("refuses to connect %s with 'retired' and changes no file", async (provider) => {
    const s = setup();
    const path = s.manager.path(provider);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, '{"keep":true}');
    await expect(s.manager.set(provider, true, (await s.manager.view(provider)).hash)).rejects.toThrow("retired");
    expect(readFileSync(path, "utf8")).toBe('{"keep":true}');
    // Missing settings stay missing; no record, no backup, no OS prompt.
    const other = setup();
    await expect(other.manager.set(provider, true, "missing")).rejects.toThrow("retired");
    expect(existsSync(other.manager.path(provider))).toBe(false);
    for (const x of [s, other]) {
      expect(existsSync(join(x.dir, "native-connectors.json"))).toBe(false);
      expect(existsSync(join(x.dir, "native-backups"))).toBe(false);
      expect(x.verify).not.toHaveBeenCalled();
    }
  });

  it("refuses even from a path that vanishes or an unusable command, naming 'retired' first", async () => {
    await expect(setup(true, ["/bad\npath"]).manager.set("codex", true, "missing")).rejects.toThrow("retired");
    await expect(setup(true, []).manager.set("codex", true, "missing")).rejects.toThrow("retired");
  });
});

describe("disconnecting hooks an older Chalito installed", () => {
  it.each(PROVIDERS)("removes only Chalito's %s hooks, preserving other settings", async (provider) => {
    const s = setup();
    const unrelated = unrelatedHook(provider);
    const original = {
      env: { PRIVATE_TEST_SETTING: "dummy-secret-do-not-export" },
      hooks: { [preTool(provider)]: [unrelated] },
    };
    const { path } = seedOldHooks({ home: s.home, dir: s.dir, provider, settings: original });
    expect(s.manager.enabled(provider)).toBe(true);
    const view = await s.manager.view(provider);
    expect(view).toMatchObject({ configured: true, connected: false });
    expect(JSON.stringify(view)).not.toContain("dummy-secret");
    const seeded = JSON.parse(readFileSync(path, "utf8"));
    seeded.newUserSetting = "keep-me";
    writeFileSync(path, JSON.stringify(seeded));
    await s.manager.set(provider, false, (await s.manager.view(provider)).hash);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after).toMatchObject({ env: original.env, newUserSetting: "keep-me" });
    expect(after.hooks[preTool(provider)]).toEqual([unrelated]);
    expect(JSON.stringify(after)).not.toContain("native-hook");
    expect(s.manager.enabled(provider)).toBe(false);
    expect((await s.manager.view(provider)).configured).toBe(false);
    expect(s.onDisconnect).toHaveBeenCalledWith(provider);
    expect(s.verify).toHaveBeenCalledTimes(1);
    expect(readdirSync(join(s.dir, "native-backups"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(s.dir, "native-connectors.json"), "utf8")).providers[provider]).toBeUndefined();
  });

  it("does not modify a file changed after the preview", async () => {
    const s = setup();
    const { path } = seedOldHooks({ home: s.home, dir: s.dir, provider: "codex" });
    const before = await s.manager.view("codex");
    writeFileSync(path, '{"newSetting":true}');
    await expect(s.manager.set("codex", false, before.hash)).rejects.toThrow("config_changed");
    expect(readFileSync(path, "utf8")).toBe('{"newSetting":true}');
  });

  it("does not change anything when system confirmation fails", async () => {
    const s = setup(false);
    const { path } = seedOldHooks({ home: s.home, dir: s.dir, provider: "codex" });
    const before = readFileSync(path, "utf8");
    await expect(s.manager.set("codex", false, (await s.manager.view("codex")).hash)).rejects.toThrow("os_auth_failed");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(s.onDisconnect).not.toHaveBeenCalled();
  });

  it("refuses malformed settings and symlinked targets, reporting them on that row only", async () => {
    const s = setup();
    const path = s.manager.path("claude");
    mkdirSync(join(s.home, ".claude"));
    writeFileSync(path, "invalid JSON");
    const rows = await s.manager.list();
    expect(rows.map((r) => [r.provider, r.error])).toEqual([
      ["codex", undefined],
      ["claude", "invalid_config"],
      ["cursor", undefined],
    ]);
    await expect(s.manager.set("claude", false, "missing")).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("invalid JSON");
    rmSync(path);
    const elsewhere = join(s.home, "elsewhere.json");
    writeFileSync(elsewhere, "{}");
    symlinkSync(elsewhere, path);
    expect(await s.manager.view("claude")).toMatchObject({ error: "unsafe_path", configured: false, hash: "" });
    await expect(s.manager.set("claude", false, "missing")).rejects.toThrow("unsafe_path");
    expect(readFileSync(elsewhere, "utf8")).toBe("{}");
    rmSync(path);
    writeFileSync(path, JSON.stringify({ big: "x".repeat(1024 * 1024) }));
    expect((await s.manager.view("claude")).error).toBe("config_too_large");
  });

  it("still disconnects when Chalito's own record is corrupt or lost", async () => {
    const s = setup();
    const mine = { hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } };
    const { path } = seedOldHooks({ home: s.home, dir: s.dir, provider: "claude", settings: mine });
    writeFileSync(join(s.dir, "native-connectors.json"), "{corrupt");
    expect(s.manager.enabled("claude")).toBe(false);
    expect(s.manager.enabled("claude")).toBe(false);
    expect(s.logs.filter((l) => l.event === "native.connector_unreadable")).toHaveLength(1);
    const view = await s.manager.view("claude");
    expect(view).toMatchObject({ configured: true, connected: false, error: "state_corrupt" });
    await s.manager.set("claude", false, view.hash);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      hooks: {
        SessionStart: [],
        UserPromptSubmit: [],
        PreToolUse: [],
        Stop: [{ hooks: [{ type: "command", command: "mine" }] }],
        SessionEnd: [],
      },
    });
    expect((await s.manager.view("claude")).configured).toBe(false);

    // Record lost entirely: the hooks are still found by their signature.
    seedOldHooks({ home: s.home, dir: s.dir, provider: "claude", record: false });
    rmSync(join(s.dir, "native-connectors.json"));
    await s.manager.set("claude", false, (await s.manager.view("claude")).hash);
    expect(readFileSync(path, "utf8")).not.toContain("native-hook");
  });

  it("disconnects hooks installed from an older binary path, even when the current command is unusable", async () => {
    const s = setup(true, ["/bad\npath"]);
    const { path } = seedOldHooks({
      home: s.home,
      dir: s.dir,
      provider: "cursor",
      command: ["/old/place/chalito-agent"],
    });
    await s.manager.set("cursor", false, (await s.manager.view("cursor")).hash);
    expect(readFileSync(path, "utf8")).not.toContain("native-hook");
  });

  it("keeps only the newest three private backups per app", async () => {
    const s = setup();
    for (let i = 0; i < 6; i++) {
      seedOldHooks({ home: s.home, dir: s.dir, provider: "codex", settings: { env: { OPENAI_API_KEY: "dummy" } } });
      await s.manager.set("codex", false, (await s.manager.view("codex")).hash);
    }
    writeFileSync(join(s.dir, "native-backups", "claude-keep.json"), "{}");
    const backups = readdirSync(join(s.dir, "native-backups"));
    expect(backups.filter((n) => n.startsWith("codex-"))).toHaveLength(3);
    expect(backups).toContain("claude-keep.json");
    if (process.platform !== "win32")
      for (const name of backups.filter((n) => n.startsWith("codex-")))
        expect(statSync(join(s.dir, "native-backups", name)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "rolls back the settings when Chalito's record can't be written",
    async () => {
      const s = setup();
      const { path } = seedOldHooks({ home: s.home, dir: s.dir, provider: "codex" });
      const before = readFileSync(path, "utf8");
      const hash = (await s.manager.view("codex")).hash;
      chmodSync(s.dir, 0o500);
      try {
        await expect(s.manager.set("codex", false, hash)).rejects.toThrow();
      } finally {
        chmodSync(s.dir, 0o700);
      }
      expect(readFileSync(path, "utf8")).toBe(before);
    },
  );

  it("does not treat an edited or removed connector as enabled", async () => {
    const s = setup();
    const { path } = seedOldHooks({ home: s.home, dir: s.dir, provider: "codex" });
    expect(s.manager.enabled("codex")).toBe(true);
    writeFileSync(path, "{}");
    expect(s.manager.enabled("codex")).toBe(false);
  });

  it("reports an unreadable app config as unreadable, not as turned off", async () => {
    const s = setup();
    const { path } = seedOldHooks({ home: s.home, dir: s.dir, provider: "claude" });
    expect(s.manager.readState("claude")).toBe(true);
    writeFileSync(path, "{not json");
    expect(s.manager.readState("claude")).toBe("unreadable");
    expect(s.manager.enabled("claude")).toBe(false);
    writeFileSync(path, "{}");
    expect(s.manager.readState("claude")).toBe(false);
    expect(s.logs.filter((l) => l.event === "native.connector_unreadable")).toHaveLength(1);
  });
});

describe("retire(): approval hooks come out of every app when the agent starts", () => {
  it("removes Chalito's hooks from all three apps, keeping env, unrelated hooks and other settings", async () => {
    const s = setup(true, ["/home/u/.local/share/chalito/chalito-agent"]);
    const seeded = PROVIDERS.map((provider) => ({
      provider,
      unrelated: unrelatedHook(provider),
      // Hooks from an old AppImage mount, with the old block-on-failure flags: still Chalito's.
      ...seedOldHooks({
        home: s.home,
        dir: s.dir,
        provider,
        command: ["/tmp/.mount_ChalitOLD/usr/bin/chalito-agent"],
        flags: provider === "cursor" ? { failClosed: true } : { onFailure: "block" },
        settings: {
          env: { KEEP: "1" },
          model: "keep-me",
          hooks: { [preTool(provider)]: [unrelatedHook(provider)] },
        },
      }),
    }));
    expect(s.manager.retire()).toEqual(["codex", "claude", "cursor"]);
    for (const { provider, path, unrelated } of seeded) {
      const after = JSON.parse(readFileSync(path, "utf8"));
      expect(JSON.stringify(after)).not.toMatch(/native-hook|onFailure|failClosed|mount_Chalit/);
      expect(after).toMatchObject({ env: { KEEP: "1" }, model: "keep-me" });
      expect(after.hooks[preTool(provider)]).toEqual([unrelated]);
      expect(s.manager.enabled(provider)).toBe(false);
      expect((await s.manager.view(provider)).configured).toBe(false);
      expect(readdirSync(join(s.dir, "native-backups")).filter((n) => n.startsWith(`${provider}-`))).toHaveLength(1);
    }
    expect(JSON.parse(readFileSync(join(s.dir, "native-connectors.json"), "utf8")).providers).toEqual({});
    expect(s.logs.filter((l) => l.event === "native.connector_retired").map((l) => l.meta.provider)).toEqual([
      "codex",
      "claude",
      "cursor",
    ]);
    // No OS prompt at start; a second start has nothing left to do.
    expect(s.verify).not.toHaveBeenCalled();
    expect(s.manager.retire()).toEqual([]);
    expect(readdirSync(join(s.dir, "native-backups"))).toHaveLength(3);
  });

  it("does not write, back up or create anything for apps without Chalito hooks", () => {
    const s = setup();
    const claude = s.manager.path("claude");
    mkdirSync(join(claude, ".."), { recursive: true });
    const text = JSON.stringify({ hooks: { PreToolUse: [unrelatedHook("claude")] }, env: { A: "b" } });
    writeFileSync(claude, text);
    expect(s.manager.retire()).toEqual([]);
    expect(readFileSync(claude, "utf8")).toBe(text);
    expect(existsSync(s.manager.path("codex"))).toBe(false);
    expect(existsSync(s.manager.path("cursor"))).toBe(false);
    expect(existsSync(join(s.dir, "native-backups"))).toBe(false);
    expect(existsSync(join(s.dir, "native-connectors.json"))).toBe(false);
  });

  it("removes hooks Chalito has no record of, and works with a corrupt record", () => {
    const s = setup();
    const cursor = seedOldHooks({ home: s.home, dir: s.dir, provider: "cursor", record: false });
    const claude = seedOldHooks({ home: s.home, dir: s.dir, provider: "claude" });
    writeFileSync(join(s.dir, "native-connectors.json"), "{corrupt");
    expect(s.manager.retire()).toEqual(["claude", "cursor"]);
    for (const { path } of [cursor, claude]) expect(readFileSync(path, "utf8")).not.toContain("native-hook");
  });

  it("keeps going when one app's settings are unreadable or symlinked, leaving those untouched", () => {
    const s = setup();
    const codex = s.manager.path("codex");
    mkdirSync(join(codex, ".."), { recursive: true });
    writeFileSync(codex, "{not json");
    const elsewhere = join(s.home, "elsewhere.json");
    const { path: claudeTarget } = seedOldHooks({ home: s.home, dir: s.dir, provider: "claude" });
    const linked = readFileSync(claudeTarget, "utf8");
    writeFileSync(elsewhere, linked);
    rmSync(claudeTarget);
    symlinkSync(elsewhere, claudeTarget);
    const { path: cursor } = seedOldHooks({ home: s.home, dir: s.dir, provider: "cursor" });
    expect(s.manager.retire()).toEqual(["cursor"]);
    expect(readFileSync(codex, "utf8")).toBe("{not json");
    expect(readFileSync(elsewhere, "utf8")).toBe(linked);
    expect(readFileSync(cursor, "utf8")).not.toContain("native-hook");
    expect(s.logs.filter((l) => l.event === "native.connector_retire_failed").map((l) => l.meta)).toEqual([
      { provider: "codex", error: "invalid_config" },
      { provider: "claude", error: "unsafe_path" },
    ]);
  });
});
