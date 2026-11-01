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

describe("native app connector installation", () => {
  it.each(["codex", "claude", "cursor"] as const)(
    "adds and removes only Chalito's %s hooks, preserving other settings",
    async (provider) => {
      const s = setup();
      const path = s.manager.path(provider);
      mkdirSync(join(path, ".."), { recursive: true });
      const event = provider === "cursor" ? "preToolUse" : "PreToolUse";
      const unrelated =
        provider === "cursor"
          ? { command: "existing-policy" }
          : { matcher: "Bash", hooks: [{ type: "command", command: "existing-policy" }] };
      const original = { env: { PRIVATE_TEST_SETTING: "dummy-secret-do-not-export" }, hooks: { [event]: [unrelated] } };
      writeFileSync(path, JSON.stringify(original));
      const before = await s.manager.view(provider);
      expect(before.configured).toBe(false);
      await s.manager.set(provider, true, before.hash);
      const installed = JSON.parse(readFileSync(path, "utf8"));
      expect(installed.env).toEqual(original.env);
      expect(installed.hooks[event]).toHaveLength(2);
      expect(installed.hooks[event][0]).toEqual(unrelated);
      expect(JSON.stringify(installed.hooks[event][1])).toContain("native-hook");
      expect(s.manager.enabled(provider)).toBe(true);
      const after = await s.manager.view(provider);
      expect(after).toMatchObject({ configured: true, connected: false });
      expect(JSON.stringify(after)).not.toContain("dummy-secret");
      expect(readdirSync(join(s.dir, "native-backups"))).toHaveLength(1);
      installed.newUserSetting = "keep-me";
      writeFileSync(path, JSON.stringify(installed));
      await s.manager.set(provider, false, (await s.manager.view(provider)).hash);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        env: original.env,
        newUserSetting: "keep-me",
        hooks: { [event]: [unrelated] },
      });
      expect(s.manager.enabled(provider)).toBe(false);
      expect(s.onDisconnect).toHaveBeenCalledWith(provider);
      expect(s.verify).toHaveBeenCalledTimes(2);
    },
  );

  it("does not modify a file changed after the preview", async () => {
    const s = setup();
    const before = await s.manager.view("codex");
    mkdirSync(join(s.home, ".codex"));
    writeFileSync(before.path, '{"newSetting":true}');
    await expect(s.manager.set("codex", true, before.hash)).rejects.toThrow("config_changed");
    expect(readFileSync(before.path, "utf8")).toBe('{"newSetting":true}');
  });

  it("does not install anything when system confirmation fails", async () => {
    const s = setup(false);
    const before = await s.manager.view("codex");
    await expect(s.manager.set("codex", true, before.hash)).rejects.toThrow("os_auth_failed");
    expect((await s.manager.view("codex")).hash).toBe("missing");
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
    await expect(s.manager.set("claude", true, "missing")).rejects.toThrow();
    rmSync(path);
    const elsewhere = join(s.home, "elsewhere.json");
    writeFileSync(elsewhere, "{}");
    symlinkSync(elsewhere, path);
    expect(await s.manager.view("claude")).toMatchObject({ error: "unsafe_path", configured: false, hash: "" });
    await expect(s.manager.set("claude", true, "missing")).rejects.toThrow("unsafe_path");
    expect(readFileSync(elsewhere, "utf8")).toBe("{}");
    rmSync(path);
    writeFileSync(path, JSON.stringify({ big: "x".repeat(1024 * 1024) }));
    expect((await s.manager.view("claude")).error).toBe("config_too_large");
  });

  it("still disconnects when Chalito's own record is corrupt or lost", async () => {
    const s = setup();
    const path = s.manager.path("claude");
    mkdirSync(join(s.home, ".claude"));
    writeFileSync(path, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } }));
    await s.manager.set("claude", true, (await s.manager.view("claude")).hash);
    writeFileSync(join(s.dir, "native-connectors.json"), "{corrupt");
    expect(s.manager.enabled("claude")).toBe(false);
    expect(s.manager.enabled("claude")).toBe(false);
    expect(s.logs.filter((l) => l.event === "native.connector_unreadable")).toHaveLength(1);
    const view = await s.manager.view("claude");
    expect(view).toMatchObject({ configured: true, connected: false, error: "state_corrupt" });
    await expect(s.manager.set("claude", true, view.hash)).rejects.toThrow("state_corrupt");
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
    expect(await s.manager.view("claude")).toMatchObject({ configured: false });
    expect((await s.manager.view("claude")).error).toBeUndefined();

    // Record lost entirely.
    await s.manager.set("claude", true, (await s.manager.view("claude")).hash);
    rmSync(join(s.dir, "native-connectors.json"));
    expect(await s.manager.view("claude")).toMatchObject({ configured: false });
    await s.manager.set("claude", false, (await s.manager.view("claude")).hash);
    expect(readFileSync(path, "utf8")).not.toContain("native-hook");
  });

  it("disconnects hooks installed from an older binary path", async () => {
    const old = setup(true, ["/old/place/chalito-agent"]);
    await old.manager.set("cursor", true, "missing");
    // Reconnecting from a moved binary replaces the old hooks instead of stacking a second set.
    const moved = setup(true, ["/new/place/chalito-agent"], old.home);
    await moved.manager.set("cursor", true, (await moved.manager.view("cursor")).hash);
    const hooks = JSON.parse(readFileSync(old.manager.path("cursor"), "utf8")).hooks.preToolUse;
    expect(hooks).toHaveLength(1);
    expect(hooks[0].command).toContain("/new/place/");
    // Even a binary path the hook no longer accepts must not block removing it.
    const broken = setup(true, ["/bad\npath"], old.home);
    await broken.manager.set("cursor", false, (await broken.manager.view("cursor")).hash);
    expect(readFileSync(old.manager.path("cursor"), "utf8")).not.toContain("native-hook");
    await expect(broken.manager.set("cursor", true, (await broken.manager.view("cursor")).hash)).rejects.toThrow(
      "unsafe_command",
    );
  });

  it.each(["codex", "claude", "cursor"] as const)(
    "repairs %s hooks left on an old agent path when the agent starts (#132)",
    async (provider) => {
      const old = setup(true, ["/tmp/.mount_ChalitOLD/usr/bin/chalito-agent"]);
      const path = old.manager.path(provider);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify({ model: "keep-me" }));
      await old.manager.set(provider, true, (await old.manager.view(provider)).hash);
      const now = setup(true, ["/home/u/.local/share/chalito/chalito-agent"], old.home);
      expect(now.manager.repair()).toEqual([provider]);
      const text = readFileSync(path, "utf8");
      expect(text).not.toContain(".mount_ChalitOLD");
      expect(text.match(/native-hook/g)).toHaveLength(5);
      expect(JSON.parse(text).model).toBe("keep-me");
      expect(now.manager.enabled(provider)).toBe(true);
      // Already current: nothing is written again, no backup piles up, no OS prompt was needed.
      const backups = readdirSync(join(old.dir, "native-backups")).length;
      expect(now.manager.repair()).toEqual([]);
      expect(readdirSync(join(old.dir, "native-backups"))).toHaveLength(backups);
      expect(now.verify).not.toHaveBeenCalled();
    },
  );

  it("does not reconnect an app whose Chalito hooks were removed by hand, nor one never connected", async () => {
    const old = setup(true, ["/tmp/.mount_ChalitOLD/usr/bin/chalito-agent"]);
    await old.manager.set("claude", true, "missing");
    const path = old.manager.path("claude");
    writeFileSync(path, JSON.stringify({ hooks: {} }));
    const now = setup(true, ["/home/u/.local/share/chalito/chalito-agent"], old.home);
    expect(now.manager.repair()).toEqual([]);
    expect(readFileSync(path, "utf8")).not.toContain("native-hook");
    expect(existsSync(now.manager.path("codex"))).toBe(false);
  });

  it("keeps repairing the other apps when one app's settings can't be read", async () => {
    const old = setup(true, ["/tmp/.mount_ChalitOLD/usr/bin/chalito-agent"]);
    for (const p of ["codex", "claude", "cursor"] as const) await old.manager.set(p, true, "missing");
    // codex is repaired first: a failure there must not stop the ones after it.
    writeFileSync(old.manager.path("codex"), "{not json");
    const now = setup(true, ["/home/u/.local/share/chalito/chalito-agent"], old.home);
    expect(now.manager.repair()).toEqual(["claude", "cursor"]);
    expect(now.logs.map((l) => l.event)).toContain("native.connector_repair_failed");
    expect(readFileSync(old.manager.path("codex"), "utf8")).toBe("{not json");
  });

  it("keeps an app's record as it was when writing its settings fails, even if a later app succeeds", async () => {
    const old = setup(true, ["/tmp/.mount_ChalitOLD/usr/bin/chalito-agent"]);
    await old.manager.set("claude", true, "missing");
    await old.manager.set("cursor", true, "missing");
    const claudeDir = join(old.home, ".claude");
    chmodSync(claudeDir, 0o500);
    try {
      const now = setup(true, ["/home/u/.local/share/chalito/chalito-agent"], old.home);
      expect(now.manager.repair()).toEqual(["cursor"]);
      expect(now.logs.find((l) => l.event === "native.connector_repair_failed")?.meta).toMatchObject({
        provider: "claude",
        errno: "EACCES",
      });
      const record = JSON.parse(readFileSync(join(old.dir, "native-connectors.json"), "utf8"));
      expect(record.providers.claude.commands[0]).toContain(".mount_ChalitOLD");
      expect(record.providers.cursor.commands[0]).toContain(".local/share/chalito");
    } finally {
      chmodSync(claudeDir, 0o700);
    }
    // Claude still reads as connected (old hooks + old record agree), so the next start retries it.
    expect(old.manager.readState("claude")).toBe(true);
  });

  it("says why when Chalito's own record can't be read, and changes nothing", async () => {
    const old = setup(true, ["/tmp/.mount_ChalitOLD/usr/bin/chalito-agent"]);
    await old.manager.set("claude", true, "missing");
    const before = readFileSync(old.manager.path("claude"), "utf8");
    writeFileSync(join(old.dir, "native-connectors.json"), "{corrupt");
    const now = setup(true, ["/home/u/.local/share/chalito/chalito-agent"], old.home);
    expect(now.manager.repair()).toEqual([]);
    expect(now.logs).toContainEqual({ event: "native.connector_repair_failed", meta: { error: "state_corrupt" } });
    expect(readFileSync(old.manager.path("claude"), "utf8")).toBe(before);
  });

  it("leaves an app with Chalito hooks but no record of connecting it untouched", async () => {
    const old = setup(true, ["/tmp/.mount_ChalitOLD/usr/bin/chalito-agent"]);
    await old.manager.set("cursor", true, "missing");
    writeFileSync(join(old.dir, "native-connectors.json"), JSON.stringify({ v: 1, providers: {} }));
    const before = readFileSync(old.manager.path("cursor"), "utf8");
    const now = setup(true, ["/home/u/.local/share/chalito/chalito-agent"], old.home);
    expect(now.manager.repair()).toEqual([]);
    expect(readFileSync(old.manager.path("cursor"), "utf8")).toBe(before);
  });

  it("never puts back a hook removed by hand: same path does nothing, a new path moves only the ones left", async () => {
    const old = setup(true, ["/tmp/.mount_ChalitOLD/usr/bin/chalito-agent"]);
    await old.manager.set("claude", true, "missing");
    const path = old.manager.path("claude");
    const data = JSON.parse(readFileSync(path, "utf8"));
    delete data.hooks.PreToolUse;
    data.hooks.Stop.push({ hooks: [{ type: "command", command: "existing-policy" }] });
    writeFileSync(path, JSON.stringify(data));
    expect(old.manager.repair()).toEqual([]);
    const now = setup(true, ["/home/u/.local/share/chalito/chalito-agent"], old.home);
    expect(now.manager.repair()).toEqual(["claude"]);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.hooks.PreToolUse ?? []).toEqual([]);
    expect(JSON.stringify(after)).not.toContain(".mount_ChalitOLD");
    expect(JSON.stringify(after).match(/native-hook/g)).toHaveLength(4);
    expect(JSON.stringify(after.hooks.Stop)).toContain("existing-policy");
  });

  it("refuses to connect from a path that vanishes, saying why on the row, but still disconnects", async () => {
    const old = setup();
    await old.manager.set("claude", true, "missing");
    const home = old.home;
    const temp = new NativeConnectors({
      home,
      dir: join(home, ".chalito"),
      command: ["/tmp/.mount_ChalitNEW/usr/bin/chalito-agent"],
      stable: false,
      platform: "linux",
      available: async () => true,
      verify: async () => true,
      onDisconnect: () => undefined,
    });
    const codex = await temp.view("codex");
    expect(codex.error).toBe("unstable_path");
    await expect(temp.set("codex", true, codex.hash)).rejects.toThrow("unstable_path");
    expect(existsSync(temp.path("codex"))).toBe(false);
    expect((await temp.view("claude")).error).toBeUndefined();
    await temp.set("claude", false, (await temp.view("claude")).hash);
    expect(readFileSync(temp.path("claude"), "utf8")).not.toContain("native-hook");
  });

  it("heals a record left behind by a kill between writing the settings and the record", async () => {
    const old = setup(true, ["/tmp/.mount_ChalitOLD/usr/bin/chalito-agent"]);
    await old.manager.set("codex", true, "missing");
    const now = setup(true, ["/home/u/.local/share/chalito/chalito-agent"], old.home);
    const file = join(old.dir, "native-connectors.json");
    const oldRecord = readFileSync(file, "utf8");
    now.manager.repair();
    writeFileSync(file, oldRecord);
    expect(now.manager.enabled("codex")).toBe(false);
    expect(now.manager.repair()).toEqual(["codex"]);
    expect(now.manager.enabled("codex")).toBe(true);
  });

  it.each(["claude", "cursor", "codex"] as const)(
    "never makes %s block when the hook can't run, and repair drops the old block flags (#132)",
    async (provider) => {
      const s = setup(true, ["/home/u/.local/share/chalito/chalito-agent"]);
      await s.manager.set(provider, true, "missing");
      const path = s.manager.path(provider);
      expect(readFileSync(path, "utf8")).not.toMatch(/onFailure|failClosed/);
      // Hooks written by an older Chalito: same path, with the flags that locked the app out.
      const data = JSON.parse(readFileSync(path, "utf8"));
      const flag = provider === "cursor" ? { failClosed: true } : { onFailure: "block" };
      for (const groups of Object.values(data.hooks) as Record<string, unknown>[][])
        for (const g of groups) {
          if (provider === "cursor") Object.assign(g, flag);
          else for (const h of g.hooks as Record<string, unknown>[]) Object.assign(h, flag);
        }
      writeFileSync(path, JSON.stringify(data));
      expect(s.manager.repair()).toEqual([provider]);
      const after = readFileSync(path, "utf8");
      expect(after).not.toMatch(/onFailure|failClosed/);
      expect(after.match(/native-hook/g)).toHaveLength(5);
      expect(s.manager.enabled(provider)).toBe(true);
      expect(s.manager.repair()).toEqual([]);
    },
  );

  it("reports an unusable agent command on the row before anyone tries to connect", async () => {
    expect((await setup(true, ["/bad\npath"]).manager.view("codex")).error).toBe("unsafe_command");
    expect((await setup(true, []).manager.view("codex")).error).toBe("cli_unavailable");
  });

  it("keeps only the newest three private backups per app", async () => {
    const s = setup();
    const path = s.manager.path("codex");
    mkdirSync(join(s.home, ".codex"));
    writeFileSync(path, JSON.stringify({ env: { OPENAI_API_KEY: "dummy-not-a-key" } }));
    for (let i = 0; i < 6; i++) {
      const view = await s.manager.view("codex");
      await s.manager.set("codex", !view.configured, view.hash);
    }
    writeFileSync(join(s.dir, "native-backups", "claude-keep.json"), "{}");
    const view = await s.manager.view("codex");
    await s.manager.set("codex", !view.configured, view.hash);
    const backups = readdirSync(join(s.dir, "native-backups"));
    expect(backups.filter((n) => n.startsWith("codex-"))).toHaveLength(3);
    expect(backups).toContain("claude-keep.json");
    if (process.platform !== "win32")
      for (const name of backups.filter((n) => n.startsWith("codex-")))
        expect(statSync(join(s.dir, "native-backups", name)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "rolls back by deleting a settings file that did not exist before",
    async () => {
      const s = setup();
      chmodSync(s.dir, 0o500);
      try {
        await expect(s.manager.set("codex", true, "missing")).rejects.toThrow();
      } finally {
        chmodSync(s.dir, 0o700);
      }
      expect(existsSync(s.manager.path("codex"))).toBe(false);
    },
  );

  it("does not treat an edited or removed connector as enabled", async () => {
    const s = setup();
    await s.manager.set("codex", true, "missing");
    expect(s.manager.enabled("codex")).toBe(true);
    writeFileSync(s.manager.path("codex"), "{}");
    expect(s.manager.enabled("codex")).toBe(false);
  });

  it("reports an unreadable app config as unreadable, not as turned off", async () => {
    const s = setup();
    await s.manager.set("claude", true, "missing");
    expect(s.manager.readState("claude")).toBe(true);
    writeFileSync(s.manager.path("claude"), "{not json");
    expect(s.manager.readState("claude")).toBe("unreadable");
    expect(s.manager.enabled("claude")).toBe(false);
    writeFileSync(s.manager.path("claude"), "{}");
    expect(s.manager.readState("claude")).toBe(false);
    expect(s.logs.filter((l) => l.event === "native.connector_unreadable")).toHaveLength(1);
  });
});
