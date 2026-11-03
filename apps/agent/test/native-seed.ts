import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nativeHookCommands } from "../src/native/connectors.js";
import type { NativeProvider } from "../src/native/protocol.js";

/** Settings path of each app, as NativeConnectors.path() names it. */
export const nativeSettingsPath = (home: string, provider: NativeProvider): string =>
  provider === "claude"
    ? join(home, ".claude", "settings.json")
    : join(home, provider === "codex" ? ".codex" : ".cursor", "hooks.json");

/** An app's settings as an older Chalito's "Connect" left them: its hooks on every event, plus its record. */
export const seedOldHooks = (opts: {
  home: string;
  dir: string;
  provider: NativeProvider;
  command?: string[];
  settings?: Record<string, unknown>;
  record?: boolean;
  /** Extra fields old versions put on each hook (e.g. the block-on-failure flags). */
  flags?: Record<string, unknown>;
}): { path: string; commands: string[] } => {
  const { home, dir, provider } = opts;
  const commands = nativeHookCommands(opts.command ?? ["/opt/Chalito/chalito-agent"], provider, "linux");
  const settings = structuredClone(opts.settings ?? {});
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const events =
    provider === "cursor"
      ? ["sessionStart", "beforeSubmitPrompt", "preToolUse", "stop", "sessionEnd"]
      : ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "SessionEnd"];
  events.forEach((event, i) => {
    const hook = { type: "command", command: commands[i], timeout: 10, ...opts.flags };
    (hooks[event] ??= []).push(provider === "cursor" ? hook : { hooks: [hook] });
  });
  const path = nativeSettingsPath(home, provider);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...settings, ...(provider === "cursor" ? { version: 1 } : {}), hooks }));
  if (opts.record !== false) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "native-connectors.json");
    let record: { v: 1; providers: Record<string, { commands: string[] }> } = { v: 1, providers: {} };
    try {
      record = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      // No record yet.
    }
    record.providers[provider] = { commands };
    writeFileSync(file, JSON.stringify(record));
  }
  return { path, commands };
};
