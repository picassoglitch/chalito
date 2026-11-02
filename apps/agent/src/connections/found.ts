import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Recipe } from "@chalito/protocol";
import { BUILTIN_CATALOG } from "../apps/catalog.js";
import { expandPath, isNetworkOnly, isWebOnly, knownBinDirs, platformKey } from "../apps/manager.js";
import { which } from "../runner.js";

export interface FoundTool {
  id: string;
  name: string;
  kind: "agent" | "llm" | "mcp-client";
  path?: string;
  recipeId?: string;
  mcpCapable: boolean;
  connected: boolean;
}

/** Recipes whose app reads a user MCP config (checked against each vendor's docs, 2026-11-01). */
const MCP_RECIPES: ReadonlySet<string> = new Set([
  "claude-code",
  "claude-desktop",
  "codex",
  "copilot-cli",
  "cursor",
  "cursor-cli",
  "gemini",
  "goose",
  "grok",
  "lm-studio",
  "mistral-vibe",
  "opencode",
  "qwen-code",
  "windsurf",
]);
const LLM_RECIPES: ReadonlySet<string> = new Set(["ollama", "lm-studio"]);

type Env = Record<string, string | undefined>;
type Where = (home: string, env: Env, platform: NodeJS.Platform) => string[];

const appData = (home: string, env: Env, platform: NodeJS.Platform): string =>
  platform === "win32"
    ? (env.APPDATA ?? join(home, "AppData", "Roaming"))
    : platform === "darwin"
      ? join(home, "Library", "Application Support")
      : (env.XDG_CONFIG_HOME ?? join(home, ".config"));

/** MCP clients with no recipe: found by the config file or folder they keep in the home folder. */
const CONFIG_CLIENTS: readonly { id: string; name: string; where: Where }[] = [
  { id: "vscode", name: "VS Code", where: (h, e, p) => [join(appData(h, e, p), "Code", "User", "mcp.json")] },
  {
    id: "cline",
    name: "Cline",
    where: (h, e, p) => [
      join(
        appData(h, e, p),
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      ),
    ],
  },
  {
    id: "zed",
    name: "Zed",
    where: (h, e, p) => [join(p === "darwin" ? join(h, ".config") : appData(h, e, p), "zed", "settings.json")],
  },
  { id: "continue", name: "Continue", where: (h) => [join(h, ".continue")] },
  { id: "kiro", name: "Kiro", where: (h) => [join(h, ".kiro", "settings", "mcp.json")] },
  { id: "amazon-q", name: "Amazon Q Developer", where: (h) => [join(h, ".aws", "amazonq", "mcp.json")] },
];

/** Config files that prove a recipe's desktop app is set up even when its binary is off PATH. */
const RECIPE_CONFIGS: Record<string, Where> = {
  "claude-desktop": (h, e, p) => [join(appData(h, e, p), "Claude", "claude_desktop_config.json")],
  windsurf: (h) => [join(h, ".codeium", "windsurf", "mcp_config.json")],
  "lm-studio": (h) => [join(h, ".lmstudio", "mcp.json")],
};

export interface FoundDeps {
  home: string;
  env: Env;
  platform: NodeJS.Platform;
  recipes: () => readonly Recipe[];
  /** The app's CLI (daemon: AppManager.findCli, which honors pins and npm's global bin). */
  findCli?: (recipeId: string, bin: string) => Promise<string | null>;
  connected: (id: string) => boolean;
}

const kindOf = (r: Recipe): FoundTool["kind"] =>
  LLM_RECIPES.has(r.id) ? "llm" : r.kinds.includes("desktop-app") && MCP_RECIPES.has(r.id) ? "mcp-client" : "agent";

const firstExisting = (paths: readonly string[]): string | null => paths.find((p) => existsSync(p)) ?? null;

/** What is installed on this PC: recipe apps (CLI or desktop app) plus MCP clients found by their config. */
export const scanFound = async (deps: Partial<FoundDeps> = {}): Promise<FoundTool[]> => {
  const env = deps.env ?? process.env;
  const home = deps.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const platform = deps.platform ?? process.platform;
  const recipes = deps.recipes?.() ?? BUILTIN_CATALOG.recipes;
  const connected = deps.connected ?? (() => false);
  const key = platformKey(platform);
  const lookIn = {
    ...env,
    PATH: [env.PATH ?? "", ...knownBinDirs(platform, env)].join(platform === "win32" ? ";" : ":"),
  };
  const findCli = deps.findCli ?? (async (_id: string, bin: string) => which(bin, lookIn, platform));
  const out: FoundTool[] = [];
  for (const r of recipes) {
    // Websites and hosted APIs aren't installed anywhere; the marketplace covers them.
    if (isWebOnly(r) || isNetworkOnly(r) || !key) continue;
    const detect = r.platforms[key]?.detect;
    if (!detect) continue;
    let path: string | null = null;
    for (const bin of detect.commands ?? []) {
      path = await findCli(r.id, bin);
      if (path) break;
    }
    path ??= firstExisting((detect.paths ?? []).flatMap((p) => expandPath(p, { ...env, HOME: home }) ?? []));
    path ??= firstExisting(RECIPE_CONFIGS[r.id]?.(home, env, platform) ?? []);
    if (!path) continue;
    out.push({
      id: r.id,
      name: r.name,
      kind: kindOf(r),
      path,
      recipeId: r.id,
      mcpCapable: MCP_RECIPES.has(r.id),
      connected: connected(r.id),
    });
  }
  for (const c of CONFIG_CLIENTS) {
    const path = firstExisting(c.where(home, env, platform));
    if (path)
      out.push({ id: c.id, name: c.name, kind: "mcp-client", path, mcpCapable: true, connected: connected(c.id) });
  }
  return out;
};
