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
});
