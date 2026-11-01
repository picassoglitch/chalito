import { createHash, randomUUID } from "node:crypto";
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
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { NativeProvider, type NativeProvider as Provider } from "./protocol.js";

const RecordFile = z.object({
  v: z.literal(1),
  providers: z.record(z.string(), z.object({ commands: z.array(z.string()) })),
});
type Records = z.infer<typeof RecordFile>;
export interface NativeConnectorView {
  provider: Provider;
  available: boolean;
  configured: boolean;
  connected: boolean;
  path: string;
  hash: string;
  events: string[];
  /** Why this row can't be read or changed as shown; the rest of the list still loads. */
  error?: NativeConnectorError;
}
export const NATIVE_CONNECTOR_ERRORS = [
  "unsafe_path",
  "invalid_config",
  "config_too_large",
  "state_corrupt",
  "app_unavailable",
  "unsafe_command",
  "cli_unavailable",
  "other",
] as const;
export type NativeConnectorError = (typeof NATIVE_CONNECTOR_ERRORS)[number];
const errorCode = (error: unknown): NativeConnectorError => {
  if (error instanceof SyntaxError) return "invalid_config";
  const message = error instanceof Error ? error.message : "";
  return (NATIVE_CONNECTOR_ERRORS as readonly string[]).includes(message) ? (message as NativeConnectorError) : "other";
};
const BACKUPS_KEPT = 3;
const EVENTS = {
  codex: ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "SessionEnd"],
  claude: ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "SessionEnd"],
  cursor: ["sessionStart", "beforeSubmitPrompt", "preToolUse", "stop", "sessionEnd"],
} as const;
const digest = (text: string | null) => (text === null ? "missing" : createHash("sha256").update(text).digest("hex"));
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** Chalito's hook for this app and event, whatever path the agent binary had when it was installed. */
const isChalitoHook = (provider: Provider, event: string, command: unknown): boolean =>
  typeof command === "string" &&
  new RegExp(`["']native-hook["'] ["']${provider}["'] ["']${event}["']\\s*$`).test(command);

/** Hook command lines for one app; Windows paths may hold any letter but no cmd metacharacters. */
export const nativeHookCommands = (command: string[], provider: Provider, platform: NodeJS.Platform): string[] => {
  const quote = (arg: string) => {
    if (/[\r\n\0]/.test(arg)) throw new Error("unsafe_command");
    if (platform === "win32") {
      if (!/^[\p{L}\p{N}_ .\\/:@+()=-]+$/u.test(arg)) throw new Error("unsafe_command");
      return `"${arg}"`;
    }
    return `'${arg.replace(/'/g, "'\\''")}'`;
  };
  if (!command.length) throw new Error("cli_unavailable");
  return EVENTS[provider].map((event) => [...command, "native-hook", provider, event].map(quote).join(" "));
};

/** Explicit local installation only. Never imports credentials or replaces unrelated hooks. */
export class NativeConnectors {
  #lastEnabledError = "";
  constructor(
    private readonly d: {
      home: string;
      dir: string;
      command: string[];
      platform: NodeJS.Platform;
      available: (provider: Provider) => Promise<boolean>;
      verify: () => Promise<boolean>;
      onDisconnect: (provider: Provider) => void;
      connected?: (provider: Provider) => boolean;
      log?: (event: string, meta: Record<string, unknown>) => void;
    },
  ) {}
  path(provider: Provider): string {
    return join(
      this.d.home,
      provider === "claude" ? ".claude" : provider === "codex" ? ".codex" : ".cursor",
      provider === "claude" ? "settings.json" : "hooks.json",
    );
  }
  #assertFile(file: string): void {
    let at = resolve(file);
    const root = resolve(this.d.home);
    if (at !== root && !at.startsWith(root + (this.d.platform === "win32" ? "\\" : "/")))
      throw new Error("unsafe_path");
    for (;;) {
      try {
        const stat = lstatSync(at);
        if (stat.isSymbolicLink() || (at === resolve(file) && !stat.isFile())) throw new Error("unsafe_path");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (at === root) break;
      const parent = dirname(at);
      if (parent === at) throw new Error("unsafe_path");
      at = parent;
    }
  }
  #read(file: string): { raw: string | null; data: Record<string, unknown> } {
    this.#assertFile(file);
    if (!existsSync(file)) return { raw: null, data: {} };
    if (lstatSync(file).size > 1024 * 1024) throw new Error("config_too_large");
    const raw = readFileSync(file, "utf8");
    const data: unknown = JSON.parse(raw);
    if (!object(data)) throw new Error("invalid_config");
    return { raw, data };
  }
  #statePath() {
    return join(this.d.dir, "native-connectors.json");
  }
  #records(): Records {
    try {
      const read = this.#read(this.#statePath());
      return read.raw === null ? { v: 1, providers: {} } : RecordFile.parse(read.data);
    } catch {
      throw new Error("state_corrupt");
    }
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
  /** Backups hold full app settings, which may include API keys: few, private, newest kept. */
  #backup(provider: Provider, raw: string): void {
    const dir = join(this.d.dir, "native-backups");
    this.#write(join(dir, `${provider}-${Date.now()}-${randomUUID()}.json`), raw);
    const old = readdirSync(dir)
      .filter((name) => name.startsWith(`${provider}-`) && name.endsWith(".json"))
      .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
      .slice(BACKUPS_KEPT);
    for (const { name } of old) rmSync(join(dir, name), { force: true });
  }
  #hasCommands(provider: Provider, data: Record<string, unknown>, commands: string[]): boolean {
    if (!object(data.hooks)) return false;
    return EVENTS[provider].every((event, index) => {
      const entries = data.hooks as Record<string, unknown>;
      const groups = entries[event];
      if (!Array.isArray(groups)) return false;
      return groups.some(
        (g: unknown) =>
          object(g) &&
          (provider === "cursor"
            ? g.command === commands[index]
            : Array.isArray(g.hooks) && g.hooks.some((h: unknown) => object(h) && h.command === commands[index])),
      );
    });
  }
  /** Any Chalito hook left in the app's settings, even without our record of installing it. */
  #hasChalitoHooks(provider: Provider, data: Record<string, unknown>): boolean {
    if (!object(data.hooks)) return false;
    const hooks = data.hooks;
    return EVENTS[provider].some((event) => {
      const groups = hooks[event];
      return (
        Array.isArray(groups) &&
        groups.some(
          (g: unknown) =>
            object(g) &&
            (provider === "cursor"
              ? isChalitoHook(provider, event, g.command)
              : Array.isArray(g.hooks) &&
                g.hooks.some((h: unknown) => object(h) && isChalitoHook(provider, event, h.command))),
        )
      );
    });
  }
  #enabledIn(records: Records, provider: Provider, data: Record<string, unknown>): boolean {
    const record = records.providers[provider];
    return (
      !!record &&
      record.commands.length === EVENTS[provider].length &&
      this.#hasCommands(provider, data, record.commands)
    );
  }
  enabled(provider: Provider): boolean {
    try {
      const on = this.#enabledIn(this.#records(), provider, this.#read(this.path(provider)).data);
      this.#lastEnabledError = "";
      return on;
    } catch (error) {
      // Called on every hook request: log a failure once, not per tool call.
      const code = `${provider}:${errorCode(error)}`;
      if (code !== this.#lastEnabledError) this.d.log?.("native.connector_unreadable", { provider, error: code });
      this.#lastEnabledError = code;
      return false;
    }
  }
  async view(provider: Provider): Promise<NativeConnectorView> {
    let error: NativeConnectorError | undefined;
    let current: { raw: string | null; data: Record<string, unknown> } | null = null;
    try {
      current = this.#read(this.path(provider));
    } catch (e) {
      error = errorCode(e);
    }
    let records: Records | null = null;
    try {
      records = this.#records();
    } catch {
      error ??= "state_corrupt";
    }
    // Lost or corrupt record: hooks found by their signature still count, so Disconnect stays possible.
    const configured = current
      ? records
        ? this.#enabledIn(records, provider, current.data)
        : this.#hasChalitoHooks(provider, current.data)
      : false;
    let available = false;
    try {
      available = await this.d.available(provider);
    } catch (e) {
      this.d.log?.("native.app_check_failed", { provider, error: e instanceof Error ? e.message : "error" });
      error ??= "app_unavailable";
    }
    if (!error && !configured)
      try {
        nativeHookCommands(this.d.command, provider, this.d.platform);
      } catch (e) {
        error = errorCode(e);
      }
    return {
      provider,
      available,
      configured,
      connected: configured && !error && (this.d.connected?.(provider) ?? false),
      path: this.path(provider),
      hash: current ? digest(current.raw) : "",
      events: [...EVENTS[provider]],
      ...(error ? { error } : {}),
    };
  }
  async list(): Promise<NativeConnectorView[]> {
    return Promise.all(NativeProvider.options.map((p) => this.view(p)));
  }

  async set(provider: Provider, enabled: boolean, expectedHash: string): Promise<void> {
    NativeProvider.parse(provider);
    if (enabled && !(await this.d.available(provider))) throw new Error("app_unavailable");
    // Disconnecting never needs the current binary path: old hooks are found by their signature.
    const commands = enabled ? nativeHookCommands(this.d.command, provider, this.d.platform) : [];
    if (!(await this.d.verify())) throw new Error("os_auth_failed");
    const path = this.path(provider);
    const current = this.#read(path);
    if (digest(current.raw) !== expectedHash) throw new Error("config_changed");
    let records: Records;
    try {
      records = this.#records();
    } catch (error) {
      if (enabled) throw error;
      records = { v: 1, providers: {} };
    }
    const previous = new Set(records.providers[provider]?.commands ?? []);
    const ours = (event: string, command: unknown) =>
      previous.has(String(command)) || isChalitoHook(provider, event, command);
    const hooks: Record<string, unknown> = object(current.data.hooks) ? structuredClone(current.data.hooks) : {};
    if (current.data.hooks !== undefined && !object(current.data.hooks)) throw new Error("invalid_config");
    for (const event of EVENTS[provider]) {
      const groups = hooks[event] ?? [];
      if (!Array.isArray(groups)) throw new Error("invalid_config");
      hooks[event] = groups.flatMap((entry: unknown) => {
        if (!object(entry)) throw new Error("invalid_config");
        if (provider === "cursor") return ours(event, entry.command) ? [] : [entry];
        if (!Array.isArray(entry.hooks)) throw new Error("invalid_config");
        const kept = entry.hooks.filter((hook: unknown) => !object(hook) || !ours(event, hook.command));
        return kept.length ? [{ ...entry, hooks: kept }] : [];
      });
    }
    if (enabled)
      for (const [index, event] of EVENTS[provider].entries()) {
        const timeout =
          event.toLowerCase() === "sessionend" ? 3 : event === "PreToolUse" || event === "preToolUse" ? 600 : 10;
        const hook = {
          type: "command",
          command: commands[index],
          timeout,
          ...(provider === "cursor"
            ? { failClosed: true }
            : provider === "claude" && event === "PreToolUse"
              ? { onFailure: "block" }
              : {}),
        };
        (hooks[event] as unknown[]).push(provider === "cursor" ? hook : { hooks: [hook] });
      }
    const next =
      JSON.stringify({ ...current.data, ...(provider === "cursor" ? { version: 1 } : {}), hooks }, null, 2) + "\n";
    if (current.raw !== null) this.#backup(provider, current.raw);
    if (enabled) records.providers[provider] = { commands };
    else delete records.providers[provider];
    this.#write(path, next);
    try {
      this.#write(this.#statePath(), JSON.stringify(records, null, 2) + "\n");
    } catch (error) {
      // Roll back only our exact write; never overwrite somebody's concurrent edit.
      if (digest(this.#read(path).raw) === digest(next)) {
        if (current.raw === null) rmSync(path, { force: true });
        else this.#write(path, current.raw);
      }
      throw error;
    }
    if (!enabled) this.d.onDisconnect(provider);
  }
}
