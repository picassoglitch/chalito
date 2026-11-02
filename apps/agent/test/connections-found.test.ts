import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanFound } from "../src/connections/found.js";
import { foundHandlers } from "../src/connections/ipc.js";
import { ChannelInstaller } from "../src/connections/install-channel.js";
import { tempDir } from "./rc-harness.js";

/** A fake CLI on a temp PATH: the scan only needs an executable file with that name. */
const fakeBins = (names: string[]) => {
  const bin = tempDir("chalito-found-bin-");
  for (const n of names) {
    writeFileSync(join(bin, n), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, n), 0o755);
  }
  return bin;
};

describe("scanFound", () => {
  it("finds recipe CLIs on PATH with kind, recipe and MCP capability; skips web and hosted APIs", async () => {
    const home = tempDir("chalito-found-home-");
    const bin = fakeBins(["claude", "codex", "aider", "ollama", "grok"]);
    // System folders (/usr/local/bin) are scanned too; only what this test planted is compared.
    const found = (
      await scanFound({ home, env: { HOME: home, PATH: bin }, platform: "linux", connected: (id) => id === "codex" })
    ).filter((f) => f.path?.startsWith(bin));
    const byId = Object.fromEntries(found.map((f) => [f.id, f]));
    expect(Object.keys(byId).sort()).toEqual(["aider", "claude-code", "codex", "grok", "ollama"]);
    expect(byId["claude-code"]).toEqual({
      id: "claude-code",
      name: "Claude Code",
      kind: "agent",
      path: join(bin, "claude"),
      recipeId: "claude-code",
      mcpCapable: true,
      connected: false,
    });
    expect(byId.codex!.connected).toBe(true);
    expect(byId.aider!.mcpCapable).toBe(false);
    expect(byId.ollama!.kind).toBe("llm");
    expect(found.some((f) => f.id === "chatgpt" || f.id === "openrouter")).toBe(false);
  });

  it("finds a CLI in a known install folder even with a bare PATH (login services start the agent that way)", async () => {
    const home = tempDir("chalito-found-home-");
    const local = join(home, ".local", "bin");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "gemini"), "#!/bin/sh\n");
    chmodSync(join(local, "gemini"), 0o755);
    const found = await scanFound({ home, env: { HOME: home, PATH: "" }, platform: "linux" });
    expect(found.find((f) => f.id === "gemini")?.path).toBe(join(local, "gemini"));
  });

  it("ignores a non-executable file with a CLI's name", async () => {
    const home = tempDir("chalito-found-home-");
    const bin = tempDir("chalito-found-bin-");
    writeFileSync(join(bin, "codex"), "not a program");
    chmodSync(join(bin, "codex"), 0o644);
    const found = await scanFound({ home, env: { HOME: home, PATH: bin }, platform: "linux" });
    expect(found.find((f) => f.id === "codex")).toBeUndefined();
  });

  it.each([
    ["linux", ".config/Claude/claude_desktop_config.json"],
    ["darwin", "Library/Application Support/Claude/claude_desktop_config.json"],
  ] as const)("finds Claude desktop by its MCP config on %s", async (platform, rel) => {
    const home = tempDir("chalito-found-home-");
    const file = join(home, ...rel.split("/"));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{}");
    const found = await scanFound({ home, env: { HOME: home, PATH: "" }, platform });
    expect(found.find((f) => f.id === "claude-desktop")).toMatchObject({
      kind: "mcp-client",
      mcpCapable: true,
      path: file,
    });
  });

  it("finds Windows MCP clients under %APPDATA% and the profile", async () => {
    const home = tempDir("chalito-found-home-");
    const appData = join(home, "AppData", "Roaming");
    mkdirSync(join(appData, "Claude"), { recursive: true });
    writeFileSync(join(appData, "Claude", "claude_desktop_config.json"), "{}");
    mkdirSync(join(appData, "Code", "User"), { recursive: true });
    writeFileSync(join(appData, "Code", "User", "mcp.json"), "{}");
    const found = await scanFound({
      home,
      env: { USERPROFILE: home, APPDATA: appData, PATH: "" },
      platform: "win32",
    });
    expect(found.map((f) => f.id).sort()).toEqual(["claude-desktop", "vscode"]);
  });

  it("finds MCP clients that have no recipe by their config (Kiro, Amazon Q, Continue, Zed)", async () => {
    const home = tempDir("chalito-found-home-");
    for (const rel of [".kiro/settings/mcp.json", ".aws/amazonq/mcp.json", ".config/zed/settings.json"]) {
      const file = join(home, ...rel.split("/"));
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "{}");
    }
    mkdirSync(join(home, ".continue"));
    const found = (await scanFound({ home, env: { HOME: home, PATH: "" }, platform: "linux" })).filter((f) =>
      f.path?.startsWith(home),
    );
    expect(found.map((f) => f.id).sort()).toEqual(["amazon-q", "continue", "kiro", "zed"]);
    expect(found.every((f) => f.kind === "mcp-client" && f.mcpCapable && !f.recipeId)).toBe(true);
  });

  it("an empty PC finds nothing", async () => {
    const home = tempDir("chalito-found-home-");
    const found = await scanFound({ home, env: { HOME: home, PATH: "" }, platform: "linux" });
    expect(found.filter((f) => f.path?.startsWith(home))).toEqual([]);
  });
});

describe("found IPC handlers", () => {
  const rig = () => {
    const home = tempDir("chalito-found-ipc-");
    const bin = fakeBins(["codex", "aider"]);
    const installer = new ChannelInstaller({
      home,
      dir: join(home, ".chalito"),
      env: {},
      platform: "linux",
      command: ["/opt/Chalito/chalito-agent"],
      teamTools: async () => new Set(["codex"]),
    });
    const h = foundHandlers({ installer, scan: { home, env: { HOME: home, PATH: bin }, platform: "linux" } });
    const call = async (m: string, p?: unknown) => {
      try {
        return await h[m]!(p);
      } catch (e) {
        return { code: (e as { code?: string }).code };
      }
    };
    return { h, call, installer };
  };

  it("scan → connect → scan shows it connected → disconnect", async () => {
    const r = rig();
    const rows = (await r.call("connectionsFound")) as {
      id: string;
      connected: boolean;
      channel?: { channel: string };
    }[];
    expect(rows.find((x) => x.id === "codex")).toMatchObject({ connected: false, channel: { channel: "ready" } });
    expect(rows.find((x) => x.id === "aider")!.channel).toBeUndefined();
    expect(await r.call("connectionsConnect", { id: "codex" })).toEqual({ ok: true });
    const after = (await r.call("connectionsFound")) as { id: string; connected: boolean }[];
    expect(after.find((x) => x.id === "codex")!.connected).toBe(true);
    expect(await r.call("connectionsDisconnect", { id: "codex" })).toEqual({ ok: true });
    expect((await r.installer.view("codex")).connected).toBe(false);
  });

  it("answers clear codes", async () => {
    const r = rig();
    expect(await r.call("connectionsConnect", { id: "aider" })).toEqual({ code: "unknown_tool" });
    // Gemini isn't on this fake PC: Connect never creates a config for an absent tool.
    expect(await r.call("connectionsConnect", { id: "gemini" })).toEqual({ code: "not_installed" });
    expect(await r.call("connectionsConnect", {})).toEqual({ code: "bad_params" });
    expect(await r.call("connectionsConnect", { id: "codex", extra: 1 })).toEqual({ code: "bad_params" });
    const none = foundHandlers(undefined);
    await expect(none.connectionsFound!(undefined)).rejects.toMatchObject({ code: "unavailable" });
  });
});
