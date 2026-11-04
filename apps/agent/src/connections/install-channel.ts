import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import { stableAgentPath } from "../native/stable-bin.js";

// A user-scope MCP entry `chalito_team` in each AI tool's own config; same safety rules as native/connectors.ts.

/** Tools whose user MCP config Chalito knows how to edit, by their FoundTool id. */
export const CHANNEL_TOOLS = ["claude-code", "codex", "cursor", "cursor-cli", "grok", "gemini"] as const;
export type ChannelTool = (typeof CHANNEL_TOOLS)[number];
export const isChannelTool = (id: string): id is ChannelTool => (CHANNEL_TOOLS as readonly string[]).includes(id);

/** One config file; Cursor's desktop app and its CLI share ~/.cursor/mcp.json. */
type Target = "claude" | "codex" | "cursor" | "grok" | "gemini";
const TARGET: Record<ChannelTool, Target> = {
  "claude-code": "claude",
  codex: "codex",
  cursor: "cursor",
  "cursor-cli": "cursor",
  grok: "grok",
  gemini: "gemini",
};
// Aldo 2026-11-03 — must match push detection, tool names and docs (`mcp__chalito_team__*`); old `chalito` entries migrate.
export const SERVER_NAME = "chalito_team";
export const LEGACY_SERVER_NAME = "chalito";

export const CHANNEL_ERRORS = [
  "unknown_tool",
  "unsafe_path",
  "invalid_config",
  "config_too_large",
  "config_changed",
  "config_layout",
  "name_taken",
  "channel_unavailable",
  "unstable_path",
  "cli_unavailable",
  "not_installed",
] as const;
export type ChannelError = (typeof CHANNEL_ERRORS)[number];
export const channelErrorCode = (error: unknown): ChannelError | "internal" => {
  if (error instanceof SyntaxError) return "invalid_config";
  const message = error instanceof Error ? error.message : "";
  return (CHANNEL_ERRORS as readonly string[]).includes(message) ? (message as ChannelError) : "internal";
};

export interface ChannelView {
  /** Our `chalito_team` entry is in the tool's config. */
  connected: boolean;
  /** "ready": Connect works; "needs_update": this agent build has no `team mcp` for the tool yet. */
  channel: "ready" | "needs_update";
  configPath: string;
  error?: ChannelError | "internal";
}

export interface ChannelDeps {
  home: string;
  /** ~/.chalito: backups go to its channel-backups folder. */
  dir: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** How a tool starts this agent, without the subcommand (daemon: the stable hook binary). */
  command: string[];
  /** false when the agent runs from a path that vanishes (AppImage mount, DMG): never write it into configs. */
  stable?: boolean;
  /** The `team mcp` tools this build serves; default asks the agent binary's own `help`. */
  teamTools?: () => Promise<ReadonlySet<string>>;
  log?: (event: string, meta: Record<string, unknown>) => void;
}

// ~/.claude.json also holds Claude Code's per-project history, so it grows far past a hooks file.
const MAX_BYTES: Record<Target, number> = {
  claude: 32 * 1024 * 1024,
  codex: 1024 * 1024,
  cursor: 1024 * 1024,
  grok: 1024 * 1024,
  gemini: 1024 * 1024,
};
const BACKUPS_KEPT = 3;
const digest = (text: string | null) => (text === null ? "missing" : createHash("sha256").update(text).digest("hex"));
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The `team mcp` providers listed by `<agent> help`, e.g. `team mcp <claude|codex|grok|cursor>`. */
export const parseTeamTools = (help: string): Set<string> => {
  const m = /^\s*team mcp <([a-z|-]+)>/m.exec(help);
  return new Set(m ? m[1]!.split("|") : []);
};

/** The agent's `help` text, or why it couldn't be read (a failed probe is never cached). */
const runHelp = (
  command: string[],
  env: Record<string, string | undefined>,
): Promise<{ out: string } | { failed: string }> =>
  new Promise((done) => {
    if (!command.length) return done({ failed: "no_command" });
    let out = "";
    let timedOut = false;
    const child = spawn(command[0]!, [...command.slice(1), "help"], {
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (out.length < 64 * 1024) out += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done({ failed: error.code ?? "spawn_error" });
    });
    child.on("close", () => {
      clearTimeout(timer);
      // `help` without a command exits 1 but still prints the usage: the text decides, not the code.
      done(timedOut ? { failed: "timeout" } : out ? { out } : { failed: "no_output" });
    });
  });

const tomlKey = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
/** Plain TOML for what an MCP entry holds (strings, numbers, booleans, arrays, flat tables); anything else is refused. */
const tomlValue = (v: unknown): string => {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (object(v))
    return `{ ${Object.entries(v)
      .map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`)
      .join(", ")} }`;
  throw new Error("config_layout");
};

/** Our entry: a Chalito binary (or node + Chalito's script) running `team mcp <tool>`, whatever its path. */
const isOurs = (entry: unknown, arg: string): boolean => {
  if (!object(entry) || typeof entry.command !== "string" || !Array.isArray(entry.args)) return false;
  const args = entry.args.map(String);
  const at = args.indexOf("team");
  if (at < 0 || args[at + 1] !== "mcp" || args[at + 2] !== arg) return false;
  const name = (p: string) => p.split(/[\\/]/).pop()!.toLowerCase();
  return /chalito/.test(name(entry.command)) || args.slice(0, at).some((a) => /chalito/i.test(a));
};

type Parsed = { raw: string | null; servers: Record<string, unknown> };

export class ChannelInstaller {
  #team: Promise<ReadonlySet<string>> | null = null;
  #lastUnreadable = "";
  constructor(private readonly d: ChannelDeps) {}

  /** Each tool's documented user-scope MCP file (CLAUDE_CONFIG_DIR / CODEX_HOME honored like the tools do). */
  path(tool: ChannelTool): string {
    const h = this.d.home;
    switch (TARGET[tool]) {
      case "claude":
        return join(this.d.env.CLAUDE_CONFIG_DIR || h, ".claude.json");
      case "codex":
        return join(this.d.env.CODEX_HOME || join(h, ".codex"), "config.toml");
      case "cursor":
        return join(h, ".cursor", "mcp.json");
      case "grok":
        return join(h, ".grok", "config.toml");
      case "gemini":
        return join(h, ".gemini", "settings.json");
    }
  }

  /** The `team mcp` argument for the tool: the team channel names apps, not recipes. */
  teamArg(tool: ChannelTool): string {
    return TARGET[tool];
  }

  #teamTools(): Promise<ReadonlySet<string>> {
    if (this.d.teamTools) return this.d.teamTools();
    return (this.#team ??= runHelp(this.d.command, this.d.env).then((r) => {
      if ("out" in r) return parseTeamTools(r.out);
      this.#team = null;
      this.d.log?.("connections.team_probe_failed", { reason: r.failed });
      return new Set<string>();
    }));
  }

  #toml(tool: ChannelTool) {
    return TARGET[tool] === "codex" || TARGET[tool] === "grok";
  }

  #assertFile(file: string): void {
    let at = resolve(file);
    const root = resolve(this.d.home);
    // Windows and macOS paths are case-insensitive: C:\users\ana is inside C:\Users\Ana.
    const fold = (p: string) => (this.d.platform === "win32" || this.d.platform === "darwin" ? p.toLowerCase() : p);
    if (fold(at) !== fold(root) && !fold(at).startsWith(fold(root) + (this.d.platform === "win32" ? "\\" : "/")))
      throw new Error("unsafe_path");
    for (;;) {
      try {
        const stat = lstatSync(at);
        if (stat.isSymbolicLink() || (at === resolve(file) && !stat.isFile())) throw new Error("unsafe_path");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (fold(at) === fold(root)) break;
      const parent = dirname(at);
      if (parent === at) throw new Error("unsafe_path");
      at = parent;
    }
  }

  #readRaw(tool: ChannelTool): string | null {
    const file = this.path(tool);
    this.#assertFile(file);
    if (!existsSync(file)) return null;
    if (lstatSync(file).size > MAX_BYTES[TARGET[tool]]) throw new Error("config_too_large");
    return readFileSync(file, "utf8");
  }

  #parse(tool: ChannelTool, raw: string | null): Parsed {
    if (raw === null || raw.trim() === "") return { raw, servers: {} };
    if (this.#toml(tool)) {
      let doc: Record<string, unknown>;
      try {
        doc = parseToml(raw) as Record<string, unknown>;
      } catch {
        throw new Error("invalid_config");
      }
      if (doc.mcp_servers !== undefined && !object(doc.mcp_servers)) throw new Error("invalid_config");
      return { raw, servers: (doc.mcp_servers as Record<string, unknown> | undefined) ?? {} };
    }
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new Error("invalid_config");
    }
    if (!object(doc)) throw new Error("invalid_config");
    if (doc.mcpServers !== undefined && !object(doc.mcpServers)) throw new Error("invalid_config");
    return { raw, servers: (doc.mcpServers as Record<string, unknown> | undefined) ?? {} };
  }

  #write(file: string, data: string): void {
    this.#assertFile(file);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, data, { mode: 0o600, flag: "wx" });
    try {
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  /** Backups hold the whole config, which may include other servers' keys: few, private, newest kept. */
  #backup(tool: ChannelTool, raw: string): void {
    const dir = join(this.d.dir, "channel-backups");
    const target = TARGET[tool];
    this.#write(join(dir, `${target}-${Date.now()}-${randomUUID()}.${this.#toml(tool) ? "toml" : "json"}`), raw);
    const old = readdirSync(dir)
      .filter((name) => name.startsWith(`${target}-`))
      .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
      .slice(BACKUPS_KEPT);
    for (const { name } of old) rmSync(join(dir, name), { force: true });
  }

  #entry(tool: ChannelTool): { command: string; args: string[] } {
    if (!this.d.command.length) throw new Error("cli_unavailable");
    const [command, ...rest] = this.d.command;
    return { command: command!, args: [...rest, "team", "mcp", this.teamArg(tool)] };
  }

  /** The config text with our entry set to `entry` (null: removed); everything else stays as it was. */
  #edit(
    tool: ChannelTool,
    current: Parsed,
    entry: { command: string; args: string[] } | null,
    name = SERVER_NAME,
    carry: Record<string, unknown> = {},
  ): string {
    if (this.#toml(tool)) return this.#editToml(current, entry, name, carry);
    const doc: Record<string, unknown> = current.raw && current.raw.trim() ? JSON.parse(current.raw) : {};
    const servers = { ...current.servers };
    // Fields the person added to our entry (env, timeout) survive a path repair or the rename.
    const kept = object(servers[name]) ? servers[name] : carry;
    if (entry)
      servers[name] = TARGET[tool] === "claude" ? { type: "stdio", env: {}, ...kept, ...entry } : { ...kept, ...entry };
    else delete servers[name];
    return JSON.stringify({ ...doc, mcpServers: servers }, null, 2) + "\n";
  }

  /** TOML keeps the person's comments and layout: our table is cut and appended as text, then re-parsed to prove it. */
  #editToml(
    current: Parsed,
    entry: { command: string; args: string[] } | null,
    name = SERVER_NAME,
    carry: Record<string, unknown> = {},
  ): string {
    const raw = current.raw ?? "";
    // Fields the person added (env, timeouts) are rewritten with the table, never dropped.
    const own = current.servers[name];
    const extra: Record<string, unknown> = { ...carry };
    if (object(own)) for (const [k, v] of Object.entries(own)) if (k !== "command" && k !== "args") extra[k] = v;
    // Plain objects: the TOML parser's null-prototype ones never compare equal below.
    Object.assign(extra, JSON.parse(JSON.stringify(extra)) as Record<string, unknown>);
    const header = new RegExp(
      `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${name}|"${name}"|'${name}')\\s*(?:\\.[^\\]]*)?\\]\\s*(?:#.*)?$`,
    );
    const lines = raw.split(/\r?\n/);
    const kept: string[] = [];
    let skipping = false;
    for (const line of lines) {
      if (/^\s*\[/.test(line)) skipping = header.test(line);
      if (!skipping) kept.push(line);
    }
    let text = kept.join("\n").replace(/\n{3,}$/, "\n\n");
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    if (entry) {
      // JSON string escapes are valid TOML basic-string escapes.
      const extraLines = Object.entries(extra).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}\n`);
      const block = `[mcp_servers.${name}]\ncommand = ${JSON.stringify(entry.command)}\nargs = [${entry.args
        .map((a) => JSON.stringify(a))
        .join(", ")}]\n${extraLines.join("")}`;
      text = text.trim() ? `${text.replace(/\s*$/, "")}\n\n${block}` : block;
    } else if (text.trim()) text = `${text.replace(/\s*$/, "")}\n`;
    else text = "";
    if (eol !== "\n") text = text.replace(/\n/g, eol);
    let before: Record<string, unknown>;
    let after: Record<string, unknown>;
    try {
      // Round-tripped to plain objects: smol-toml returns null-prototype ones.
      before = raw.trim() ? (JSON.parse(JSON.stringify(parseToml(raw))) as Record<string, unknown>) : {};
      after = text.trim() ? (JSON.parse(JSON.stringify(parseToml(text))) as Record<string, unknown>) : {};
    } catch {
      throw new Error("config_layout");
    }
    const strip = (doc: Record<string, unknown>) => {
      const copy = structuredClone(doc);
      if (object(copy.mcp_servers)) {
        delete copy.mcp_servers[name];
        if (!Object.keys(copy.mcp_servers).length) delete copy.mcp_servers;
      }
      return copy;
    };
    const ours = object(after.mcp_servers) ? after.mcp_servers[name] : undefined;
    // Inline or dotted-key forms aren't cut by the text edit: refuse rather than guess.
    if (
      !isDeepStrictEqual(strip(before), strip(after)) ||
      (entry ? !isDeepStrictEqual(ours, { ...entry, ...extra }) : ours !== undefined)
    )
      throw new Error("config_layout");
    return text;
  }

  async view(tool: ChannelTool): Promise<ChannelView> {
    const configPath = this.path(tool);
    const team = await this.#teamTools();
    const channel = team.has(this.teamArg(tool)) ? "ready" : "needs_update";
    try {
      const current = this.#parse(tool, this.#readRaw(tool));
      const existing = current.servers[SERVER_NAME];
      // An old `chalito` entry still connects; repair() renames it on the next agent start.
      const connected =
        isOurs(existing, this.teamArg(tool)) ||
        (existing === undefined && isOurs(current.servers[LEGACY_SERVER_NAME], this.teamArg(tool)));
      const error: ChannelError | undefined =
        existing !== undefined && !connected
          ? "name_taken"
          : !connected && this.d.stable === false
            ? "unstable_path"
            : !connected && !this.d.command.length
              ? "cli_unavailable"
              : undefined;
      return { connected, channel, configPath, ...(error ? { error } : {}) };
    } catch (e) {
      const error = channelErrorCode(e);
      // The panel can only say "try again" for these: the cause belongs in the log, once per change.
      const seen = `${tool}:${error}:${(e as NodeJS.ErrnoException).code ?? ""}`;
      if (error === "internal" && this.#lastUnreadable !== seen) {
        this.#lastUnreadable = seen;
        this.d.log?.("connections.channel_unreadable", { tool, errno: (e as NodeJS.ErrnoException).code ?? "error" });
      }
      return { connected: false, channel, configPath, error };
    }
  }

  async connect(tool: ChannelTool): Promise<void> {
    if (this.d.stable === false) throw new Error("unstable_path");
    if (!(await this.#teamTools()).has(this.teamArg(tool))) throw new Error("channel_unavailable");
    this.#apply(tool, this.#entry(tool));
  }

  async disconnect(tool: ChannelTool): Promise<void> {
    this.#apply(tool, null);
  }

  #apply(tool: ChannelTool, entry: { command: string; args: string[] } | null): void {
    const raw = this.#readRaw(tool);
    const current = this.#parse(tool, raw);
    const existing = current.servers[SERVER_NAME];
    if (existing !== undefined && !isOurs(existing, this.teamArg(tool))) throw new Error("name_taken");
    const legacy = current.servers[LEGACY_SERVER_NAME];
    const legacyOurs = isOurs(legacy, this.teamArg(tool));
    if (!legacyOurs && (entry ? isDeepStrictEqual(this.#plain(existing), entry) : existing === undefined)) return;
    let next = raw ?? "";
    let carry: Record<string, unknown> = {};
    if (legacyOurs) {
      // Our old entry goes in the same write, so the tool never has two team servers.
      const { command: _c, args: _a, ...rest } = legacy as Record<string, unknown>;
      carry = rest;
      next = this.#edit(tool, current, null, LEGACY_SERVER_NAME);
    }
    const afterLegacy = legacyOurs ? this.#parse(tool, next) : current;
    next = this.#edit(tool, afterLegacy, entry, SERVER_NAME, carry);
    // The tool may have saved its config while we built ours: never write over that.
    if (digest(this.#readRaw(tool)) !== digest(raw)) throw new Error("config_changed");
    if (raw !== null) this.#backup(tool, raw);
    this.#write(this.path(tool), next);
    this.d.log?.(entry ? "connections.channel_connected" : "connections.channel_disconnected", { tool });
  }

  #plain(existing: unknown) {
    return object(existing) ? { command: existing.command, args: existing.args } : existing;
  }

  /** On agent start: our entries that name an old agent path get the current one; nothing else changes. */
  repair(): ChannelTool[] {
    if (this.d.stable === false || !this.d.command.length) return [];
    const fixed: ChannelTool[] = [];
    const seen = new Set<Target>();
    for (const tool of CHANNEL_TOOLS) {
      if (seen.has(TARGET[tool])) continue;
      seen.add(TARGET[tool]);
      try {
        const servers = this.#parse(tool, this.#readRaw(tool)).servers;
        const existing = servers[SERVER_NAME];
        const legacy = isOurs(servers[LEGACY_SERVER_NAME], this.teamArg(tool));
        if (!isOurs(existing, this.teamArg(tool)) && !legacy) continue;
        // Someone else's `chalito_team` blocks the rename: leave the old entry working.
        if (existing !== undefined && !isOurs(existing, this.teamArg(tool))) continue;
        const want = this.#entry(tool);
        if (!legacy && isDeepStrictEqual(this.#plain(existing), want)) continue;
        this.#apply(tool, want);
        fixed.push(tool);
        this.d.log?.("connections.channel_repaired", { tool });
      } catch (error) {
        this.d.log?.("connections.channel_repair_failed", { tool, error: channelErrorCode(error) });
      }
    }
    return fixed;
  }
}

const defaultInstaller = (): ChannelInstaller => {
  const home = homedir();
  return new ChannelInstaller({
    home,
    dir: join(home, ".chalito"),
    env: process.env,
    platform: process.platform,
    command: [stableAgentPath(home)],
  });
};

/** The contract's entry points; the daemon passes its own installer (with `stable`), callers outside it get the stable copy. */
export const connectTool = async (id: string, installer?: ChannelInstaller): Promise<void> => {
  if (!isChannelTool(id)) throw new Error("unknown_tool");
  await (installer ?? defaultInstaller()).connect(id);
};

export const disconnectTool = async (id: string, installer?: ChannelInstaller): Promise<void> => {
  if (!isChannelTool(id)) throw new Error("unknown_tool");
  await (installer ?? defaultInstaller()).disconnect(id);
};
