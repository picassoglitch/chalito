import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  CHANNEL_ERRORS,
  CHANNEL_TOOLS,
  ChannelInstaller,
  connectTool,
  disconnectTool,
  parseTeamTools,
  type ChannelTool,
} from "../src/connections/install-channel.js";
import { tempDir } from "./rc-harness.js";

const AGENT = "/opt/Chalito/chalito-agent";
const ALL = new Set(["claude", "codex", "cursor", "grok", "gemini"]);

const rig = (opts: { team?: Set<string>; stable?: boolean; command?: string[]; env?: Record<string, string> } = {}) => {
  const home = tempDir("chalito-channel-");
  const dir = join(home, ".chalito");
  const logs: string[] = [];
  const installer = new ChannelInstaller({
    home,
    dir,
    env: opts.env ?? {},
    platform: "linux",
    command: opts.command ?? [AGENT],
    ...(opts.stable !== undefined ? { stable: opts.stable } : {}),
    teamTools: async () => opts.team ?? ALL,
    log: (event) => void logs.push(event),
  });
  const put = (tool: ChannelTool, text: string) => {
    const file = installer.path(tool);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  const read = (tool: ChannelTool) => readFileSync(installer.path(tool), "utf8");
  const backups = () => (existsSync(join(dir, "channel-backups")) ? readdirSync(join(dir, "channel-backups")) : []);
  return { home, dir, installer, put, read, backups, logs };
};

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as Error).message;
  }
};

/** The tools' real config shapes, each with someone else's server already in it. */
const SEED: Record<"json" | "toml", string> = {
  json: JSON.stringify(
    { numStartups: 7, mcpServers: { github: { command: "npx", args: ["-y", "gh-mcp"], env: { TOKEN: "x" } } } },
    null,
    2,
  ),
  toml: `# my codex settings\nmodel = "gpt-5"\n\n[mcp_servers.github]\ncommand = "npx" # keep\nargs = ["-y", "gh-mcp"]\n\n[mcp_servers.github.env]\nTOKEN = "x"\n\n[profiles.fast]\nmodel = "mini"\n`,
};
const isToml = (t: ChannelTool) => t === "codex" || t === "grok";
const parsed = (t: ChannelTool, text: string): Record<string, unknown> =>
  isToml(t) ? (parseToml(text) as Record<string, unknown>) : (JSON.parse(text) as Record<string, unknown>);
const servers = (t: ChannelTool, text: string) =>
  (parsed(t, text)[isToml(t) ? "mcp_servers" : "mcpServers"] ?? {}) as Record<string, Record<string, unknown>>;
const arg: Record<ChannelTool, string> = {
  "claude-code": "claude",
  codex: "codex",
  cursor: "cursor",
  "cursor-cli": "cursor",
  grok: "grok",
  gemini: "gemini",
};

describe.each(CHANNEL_TOOLS)("channel for %s on a real temp home", (tool) => {
  it("writes the documented file, keeps other entries, is idempotent, and disconnect removes only ours", async () => {
    const r = rig();
    const before = SEED[isToml(tool) ? "toml" : "json"];
    r.put(tool, before);
    await r.installer.connect(tool);
    const after = r.read(tool);
    const s = servers(tool, after);
    expect(s.chalito_team).toMatchObject({ command: AGENT, args: ["team", "mcp", arg[tool]] });
    if (tool === "claude-code") expect(s.chalito_team!.type).toBe("stdio");
    expect(s.github).toEqual(servers(tool, before).github);
    if (isToml(tool)) {
      // Comments and the person's layout survive: our table is appended, not re-serialized.
      expect(after.startsWith(before.trimEnd())).toBe(true);
      expect(after).toContain('command = "npx" # keep');
    } else expect(parsed(tool, after).numStartups).toBe(7);
    expect((await r.installer.view(tool)).connected).toBe(true);
    expect(r.backups()).toHaveLength(1);

    await r.installer.connect(tool);
    expect(r.read(tool)).toBe(after);
    expect(r.backups()).toHaveLength(1);

    await r.installer.disconnect(tool);
    const off = r.read(tool);
    expect(servers(tool, off).chalito_team).toBeUndefined();
    expect(servers(tool, off).github).toEqual(servers(tool, before).github);
    if (isToml(tool)) expect(off.trimEnd()).toBe(before.trimEnd());
    expect((await r.installer.view(tool)).connected).toBe(false);
    await r.installer.disconnect(tool);
    expect(r.read(tool)).toBe(off);
  });

  it("creates the config when the tool has none yet", async () => {
    const r = rig();
    await r.installer.connect(tool);
    expect(servers(tool, r.read(tool)).chalito_team).toMatchObject({ args: ["team", "mcp", arg[tool]] });
    expect(r.backups()).toHaveLength(0);
  });

  it("never writes over a broken config and says why", async () => {
    const r = rig();
    const broken = isToml(tool) ? "[mcp_servers.github\ncommand = " : "{ broken";
    r.put(tool, broken);
    expect(await code(r.installer.connect(tool))).toBe("invalid_config");
    expect(await code(r.installer.disconnect(tool))).toBe("invalid_config");
    expect(r.read(tool)).toBe(broken);
    expect((await r.installer.view(tool)).error).toBe("invalid_config");
    expect(r.backups()).toHaveLength(0);
  });

  it("leaves someone else's server named chalito_team alone", async () => {
    const r = rig();
    const theirs = isToml(tool)
      ? `[mcp_servers.chalito_team]\ncommand = "my-own"\nargs = []\n`
      : JSON.stringify({ mcpServers: { chalito_team: { command: "my-own", args: [] } } });
    r.put(tool, theirs);
    expect(await code(r.installer.connect(tool))).toBe("name_taken");
    expect(await code(r.installer.disconnect(tool))).toBe("name_taken");
    expect(r.read(tool)).toBe(theirs);
    expect((await r.installer.view(tool)).error).toBe("name_taken");
  });
});

describe("channel safety", () => {
  it("refuses Connect while this build has no team channel for the tool", async () => {
    const r = rig({ team: new Set(["claude"]) });
    expect(await code(r.installer.connect("gemini"))).toBe("channel_unavailable");
    expect(existsSync(r.installer.path("gemini"))).toBe(false);
    expect((await r.installer.view("gemini")).channel).toBe("needs_update");
    expect((await r.installer.view("claude-code")).channel).toBe("ready");
  });

  it("never writes a vanishing agent path, but still lets the person disconnect", async () => {
    const r = rig();
    await r.installer.connect("codex");
    const s = rig({ stable: false });
    expect(await code(s.installer.connect("codex"))).toBe("unstable_path");
    s.put("codex", r.read("codex"));
    await s.installer.disconnect("codex");
    expect(servers("codex", s.read("codex")).chalito_team).toBeUndefined();
  });

  it("refuses a symlinked config (it could point anywhere)", async () => {
    const r = rig();
    const real = join(r.home, "elsewhere.json");
    writeFileSync(real, "{}");
    mkdirSync(join(r.home, ".cursor"));
    symlinkSync(real, r.installer.path("cursor"));
    expect(await code(r.installer.connect("cursor"))).toBe("unsafe_path");
    expect(readFileSync(real, "utf8")).toBe("{}");
  });

  it("refuses a config outside the home folder (CODEX_HOME elsewhere)", async () => {
    const outside = tempDir("chalito-codex-home-");
    const r = rig({ env: { CODEX_HOME: outside } });
    expect(r.installer.path("codex")).toBe(join(outside, "config.toml"));
    expect(await code(r.installer.connect("codex"))).toBe("unsafe_path");
  });

  it("honors CLAUDE_CONFIG_DIR inside home", async () => {
    const r = rig({ env: { CLAUDE_CONFIG_DIR: "" } });
    expect(r.installer.path("claude-code")).toBe(join(r.home, ".claude.json"));
  });

  it("refuses a TOML entry it can't cut cleanly (inline table) instead of guessing", async () => {
    const r = rig();
    const inline = `mcp_servers = { chalito_team = { command = "${AGENT}", args = ["team", "mcp", "codex"] } }\n`;
    r.put("codex", inline);
    expect(await code(r.installer.disconnect("codex"))).toBe("config_layout");
    expect(r.read("codex")).toBe(inline);
  });

  it("keeps Windows line endings in a TOML config", async () => {
    const r = rig();
    const crlf = SEED.toml.replace(/\n/g, "\r\n");
    r.put("codex", crlf);
    await r.installer.connect("codex");
    expect(r.read("codex").replace(/\r\n/g, "")).not.toContain("\n");
    await r.installer.disconnect("codex");
    expect(r.read("codex")).toBe(crlf);
  });

  it("Cursor's app and CLI share one entry", async () => {
    const r = rig();
    await r.installer.connect("cursor-cli");
    expect((await r.installer.view("cursor")).connected).toBe(true);
  });

  it("keeps three backups at most", async () => {
    const r = rig();
    r.put("gemini", "{}");
    for (let i = 0; i < 4; i++) {
      await r.installer.connect("gemini");
      await r.installer.disconnect("gemini");
    }
    expect(r.backups()).toHaveLength(3);
  });

  it("escapes a Windows-style path in TOML so the tool reads it back exactly", async () => {
    const path = 'C:\\Users\\Ana "A"\\AppData\\Local\\Chalito\\chalito-agent.exe';
    const r = rig({ command: [path] });
    await r.installer.connect("grok");
    expect(servers("grok", r.read("grok")).chalito_team).toEqual({ command: path, args: ["team", "mcp", "grok"] });
  });

  it("repair moves our entries to the current agent path and touches nothing else", async () => {
    const old = rig({ command: ["/tmp/.mount_x/chalito-agent"] });
    old.put("codex", SEED.toml);
    old.put("claude-code", SEED.json);
    await old.installer.connect("codex");
    await old.installer.connect("claude-code");
    const now = new ChannelInstaller({ home: old.home, dir: old.dir, env: {}, platform: "linux", command: [AGENT] });
    expect(now.repair().sort()).toEqual(["claude-code", "codex"]);
    expect(servers("codex", old.read("codex")).chalito_team!.command).toBe(AGENT);
    expect(servers("claude-code", old.read("claude-code")).github).toBeTruthy();
    expect(now.repair()).toEqual([]);
  });
});

describe("review follow-ups", () => {
  it("refuses a config over the size limit without writing", async () => {
    const r = rig();
    const big = JSON.stringify({ mcpServers: {}, pad: "x".repeat(1024 * 1024) });
    r.put("cursor", big);
    expect(await code(r.installer.connect("cursor"))).toBe("config_too_large");
    expect(r.read("cursor")).toBe(big);
  });

  it("a third-party server that happens to run `team mcp` is not ours", async () => {
    const r = rig();
    const theirs = JSON.stringify({
      mcpServers: { chalito_team: { command: "npx", args: ["other-pkg", "team", "mcp", "claude"] } },
    });
    r.put("claude-code", theirs);
    expect(await code(r.installer.disconnect("claude-code"))).toBe("name_taken");
    expect(r.read("claude-code")).toBe(theirs);
  });

  it("a dev run (node + Chalito's script) still counts as ours", async () => {
    const r = rig({ command: ["/usr/bin/node", "--import", "tsx", "/src/chalito/apps/agent/src/cli.ts"] });
    await r.installer.connect("codex");
    expect((await r.installer.view("codex")).connected).toBe(true);
  });

  it("compares paths case-insensitively on macOS and Windows", async () => {
    const home = tempDir("chalito-channel-case-");
    const installer = new ChannelInstaller({
      home,
      dir: join(home, ".chalito"),
      env: { CODEX_HOME: join(home.toUpperCase(), ".codex") },
      platform: "darwin",
      command: [AGENT],
      teamTools: async () => ALL,
    });
    // An all-caps copy of a real path only exists on a case-insensitive disk; the check itself must not refuse it.
    expect(await code(installer.connect("codex"))).not.toBe("unsafe_path");
  });

  it("repair keeps fields the person added to our entry", async () => {
    const old = rig({ command: ["/tmp/.mount_x/chalito-agent"] });
    await old.installer.connect("cursor");
    const file = old.read("cursor");
    const doc = JSON.parse(file);
    doc.mcpServers.chalito_team.env = { DEBUG: "1" };
    old.put("cursor", JSON.stringify(doc));
    const now = new ChannelInstaller({ home: old.home, dir: old.dir, env: {}, platform: "linux", command: [AGENT] });
    expect(now.repair()).toEqual(["cursor"]);
    expect(servers("cursor", old.read("cursor")).chalito_team).toEqual({
      command: AGENT,
      args: ["team", "mcp", "cursor"],
      env: { DEBUG: "1" },
    });
  });

  it.each(CHANNEL_TOOLS)(
    "%s: an old `chalito` entry is renamed to chalito_team in one write, keeping env and every other entry",
    (tool) => {
      const r = rig();
      const before = isToml(tool)
        ? `${SEED.toml}\n[mcp_servers.chalito]\ncommand = "/tmp/.mount_x/chalito-agent"\nargs = ["team", "mcp", "${arg[tool]}"]\nenv = { CHALITO_TEAM_CODEX_QUEUE = "1" }\n`
        : JSON.stringify({
            ...JSON.parse(SEED.json),
            mcpServers: {
              ...(JSON.parse(SEED.json).mcpServers ?? {}),
              chalito: {
                command: "/tmp/.mount_x/chalito-agent",
                args: ["team", "mcp", arg[tool]],
                env: { CHALITO_TEAM_CODEX_QUEUE: "1" },
              },
            },
          });
      r.put(tool, before);
      // cursor and cursor-cli share one file: repair reports whichever it reached first.
      expect(r.installer.repair()).toHaveLength(1);
      const after = servers(tool, r.read(tool));
      expect(after.chalito).toBeUndefined();
      expect(after.chalito_team).toMatchObject({
        command: AGENT,
        args: ["team", "mcp", arg[tool]],
        env: { CHALITO_TEAM_CODEX_QUEUE: "1" },
      });
      // Everything else is exactly as it was.
      const { chalito: _old, ...rest } = servers(tool, before);
      const { chalito_team: _new, ...restAfter } = after;
      expect(restAfter).toEqual(rest);
      // Nothing left to do on the next start.
      expect(r.installer.repair()).toEqual([]);
    },
  );

  it("someone else's `chalito` entry is never renamed or removed; Connect adds chalito_team beside it", async () => {
    const r = rig();
    const theirs = JSON.stringify({ mcpServers: { chalito: { command: "my-own", args: [] } } });
    r.put("cursor", theirs);
    expect(r.installer.repair()).toEqual([]);
    await r.installer.connect("cursor");
    const s = servers("cursor", r.read("cursor"));
    expect(s.chalito).toEqual({ command: "my-own", args: [] });
    expect(s.chalito_team).toMatchObject({ command: AGENT, args: ["team", "mcp", "cursor"] });
  });

  it("a TOML path repair keeps fields the person added", () => {
    const old = rig({ command: ["/tmp/.mount_x/chalito-agent"] });
    old.put(
      "codex",
      `[mcp_servers.chalito_team]\ncommand = "/tmp/.mount_x/chalito-agent"\nargs = ["team", "mcp", "codex"]\nenv = { CHALITO_TEAM_CODEX_QUEUE = "1" }\nstartup_timeout_sec = 20\n`,
    );
    const now = new ChannelInstaller({ home: old.home, dir: old.dir, env: {}, platform: "linux", command: [AGENT] });
    expect(now.repair()).toEqual(["codex"]);
    expect(servers("codex", old.read("codex")).chalito_team).toEqual({
      command: AGENT,
      args: ["team", "mcp", "codex"],
      env: { CHALITO_TEAM_CODEX_QUEUE: "1" },
      startup_timeout_sec: 20,
    });
  });

  it("every agent error code has words in both languages", () => {
    for (const locale of ["en", "es"]) {
      const m = JSON.parse(readFileSync(join(__dirname, "..", "..", "desktop", "messages", `${locale}.json`), "utf8"));
      for (const c of CHANNEL_ERRORS) expect(m.connections.found.error[c], `${locale}:${c}`).toBeTruthy();
    }
  });
});

describe("team channel probe", () => {
  it("reads the tools from the agent's own help through a real process", async () => {
    const bin = join(tempDir("chalito-fake-agent-"), "chalito-agent");
    writeFileSync(
      bin,
      `#!/bin/sh\n[ "$1" = help ] && printf 'chalito <command>\\n  team mcp <claude|codex|grok|cursor> [workspace-path]\\n'\n`,
    );
    chmodSync(bin, 0o755);
    const home = tempDir("chalito-channel-probe-");
    const installer = new ChannelInstaller({
      home,
      dir: join(home, ".chalito"),
      env: process.env,
      platform: "linux",
      command: [bin],
    });
    expect((await installer.view("codex")).channel).toBe("ready");
    expect((await installer.view("gemini")).channel).toBe("needs_update");
  });

  it("a failed probe is logged and retried, not cached for the agent's lifetime", async () => {
    const home = tempDir("chalito-channel-probe-");
    const bin = join(home, "chalito-agent");
    const logs: { event: string; meta: Record<string, unknown> }[] = [];
    const installer = new ChannelInstaller({
      home,
      dir: join(home, ".chalito"),
      env: process.env,
      platform: "linux",
      command: [bin],
      log: (event, meta) => void logs.push({ event, meta }),
    });
    expect((await installer.view("codex")).channel).toBe("needs_update");
    expect(logs).toEqual([{ event: "connections.team_probe_failed", meta: { reason: "ENOENT" } }]);
    writeFileSync(bin, `#!/bin/sh\nprintf '  team mcp <claude|codex|grok|cursor> [workspace-path]\\n'\nexit 1\n`);
    chmodSync(bin, 0o755);
    expect((await installer.view("codex")).channel).toBe("ready");
  });

  it("an agent without `team` (today's main) or that can't run means needs_update", async () => {
    expect(parseTeamTools("chalito <command>\n  run   run the agent\n").size).toBe(0);
    const home = tempDir("chalito-channel-probe-");
    const installer = new ChannelInstaller({
      home,
      dir: join(home, ".chalito"),
      env: process.env,
      platform: "linux",
      command: [join(home, "missing-agent")],
    });
    expect((await installer.view("claude-code")).channel).toBe("needs_update");
    expect(await code(installer.connect("claude-code"))).toBe("channel_unavailable");
  });

  it("connectTool/disconnectTool reject ids that aren't channel tools", async () => {
    expect(await code(connectTool("aider"))).toBe("unknown_tool");
    expect(await code(disconnectTool("vscode"))).toBe("unknown_tool");
  });
});
