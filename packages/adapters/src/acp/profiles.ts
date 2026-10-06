import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AuthMethod } from "@agentclientprotocol/sdk";
import type { RemotePermissionMode } from "@chalito/protocol";
import { allowedEnv } from "../env.js";
import { type ModePolicy, keyEnvAllowed, unsafeLaunchArg } from "./policy.js";
import { type AcpRecipe, BUILTIN_ACP_RECIPES, acpRecipeProblem } from "./recipe.js";

/**
 * How Chalito launches and authenticates an ACP agent (D-022, D-065). Any recipe with a
 * `driver.acp` gets a profile: its command and auth method ids come from the recipe, the generic
 * hardening from policy.ts, and agents with extra switches (Grok's sandbox and always-approve
 * lock, Gemini's admin policy, …) add them through a preset keyed by recipe id. A preset can only
 * add restrictions.
 */

/** The recipes with a dedicated `AdapterKind` (older daemons and stored sessions use these). */
export type AcpKind = "grok" | "gemini";

export interface AcpConfig {
  /** The user's own CLI, pinned by Chalito (never bundled, never a PATH lookup here). */
  binPath?: string;
  /** BYO provider API key from the OS keychain. Wins over sign-in when both are there. */
  apiKey?: string;
  /**
   * Use the CLI's own sign-in, done by the person in the official tool (`grok login`, `gemini`'s
   * "Log in with Google"). Chalito never starts that login and never reads its tokens; the daemon
   * sets this only when the recipe's `signin.planSignin` (providers.yaml) allows it.
   */
  signIn?: boolean;
  /**
   * Chalito's own state dir for this CLI (default ~/.chalito/<recipe id>). With an API key it is the
   * CLI's home, so the key session never reads or writes the user's own config, MCP servers,
   * remembered grants or hooks. Also holds files Chalito hands the CLI (Gemini's admin policy).
   */
  home?: string;
  /** Reported in `initialize.clientInfo.version`. */
  clientVersion?: string;
  /** Base environment (defaults to process.env); only allowlisted variables reach the CLI. */
  env?: Record<string, string | undefined>;
}

export interface AcpLaunch {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

export type AcpAuthenticate = { methodId: string; _meta?: Record<string, unknown> };

export interface AcpProfile extends ModePolicy {
  /** The recipe id. */
  readonly id: string;
  /** Product name, for error messages. */
  readonly title: string;
  /** What to tell a person whose CLI sign-in is missing or expired. */
  readonly signInHint: string;
  /** Builds the command line and environment, and writes any file the CLI needs first. */
  launch(config: AcpConfig, mode: RemotePermissionMode): AcpLaunch;
  /**
   * The `authenticate` request, or null to rely on the CLI's own cached sign-in (or a key in its
   * environment). `advertised` is what `initialize` returned: an interactive (`terminal`) method
   * is never sent.
   */
  authenticate(config: AcpConfig, advertised?: readonly AuthMethod[]): AcpAuthenticate | null;
  /**
   * Slash commands a prompt may run. Any other command the agent advertises is refused before it
   * reaches the agent: some flip approvals off (Grok's `/always-approve`).
   */
  readonly allowedCommands: readonly string[];
}

/** What an agent-specific preset adds to the generic profile. */
export interface AcpPreset {
  readonly signInHint?: string;
  /** Extra args, env and files (runs after the generic launch is built). */
  harden?(launch: AcpLaunch, ctx: { config: AcpConfig; mode: RemotePermissionMode; home: string }): void;
  /** False: the key never goes in the environment (the preset's `authenticate` carries it). */
  readonly keyInEnv?: boolean;
  authenticate?(config: AcpConfig, recipe: AcpRecipe): AcpAuthenticate | null;
  readonly safeMode?: string;
  readonly unsafeModes?: readonly string[];
  readonly allowedCommands?: readonly string[];
}

const stateDir = (config: AcpConfig, id: string) => config.home ?? join(homedir(), ".chalito", id);

const baseEnv = (config: AcpConfig) => {
  // An allowlist, never the daemon's whole environment (review R-L12).
  const env = allowedEnv(config.env ?? process.env);
  // Marks everything the CLI runs as inside a Chalito session: the `chalito` CLI refuses to
  // change keys, trust, policy or Developer mode from here.
  env.CHALITO_SESSION = "1";
  return env;
};

const privateDir = (dir: string) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort (Windows) */
  }
};

/**
 * Grok Build's vendor-compatibility switches (Grok docs, "Harness compatibility"; env beats
 * config.toml). Off: MCP servers and hooks from ~/.claude.json, ~/.claude/settings.json and
 * ~/.cursor, which would add tools and hooks Chalito never sees.
 */
export const GROK_COMPAT_OFF = [
  "GROK_CLAUDE_MCPS_ENABLED",
  "GROK_CLAUDE_HOOKS_ENABLED",
  "GROK_CURSOR_MCPS_ENABLED",
  "GROK_CURSOR_HOOKS_ENABLED",
] as const;

/**
 * Written to Chalito's own GROK_HOME (API-key sessions): an org-style lock that makes
 * always-approve impossible (`/always-approve`, `_meta.yoloMode`, `defaultMode:
 * bypassPermissions` from Claude-compatible settings). Grok docs, "Disable always-approve".
 */
export const GROK_REQUIREMENTS = "disable_bypass_permissions_mode = true\n";

/** OS sandbox profile (Grok docs, "Sandbox Mode"). Never `off` or `devbox`. */
export const grokSandboxFor = (mode: RemotePermissionMode): "read-only" | "workspace" =>
  mode === "default" || mode === "acceptEdits" ? "workspace" : "read-only";

/**
 * Grok Build: `grok agent stdio` (VERIFIED_APIS §5, checked against @xai-official/grok 1.0.46).
 * - `--no-auto-update` (no self-update mid-session; the pin would break) and `--sandbox` are
 *   top-level flags and go before `agent`; `--no-leader` keeps one private agent per session.
 * - Never `--always-approve`, never `_meta.yoloMode`: the default "ask" mode sends a
 *   `session/request_permission` for edits and for shell commands that aren't on Grok's
 *   read-only list.
 * - API key: `authenticate {methodId: "xai.api_key"}` with XAI_API_KEY in the child's env (the
 *   1.0.46 agent accepts the id without advertising it), in Chalito's own GROK_HOME. Sign-in: no
 *   `authenticate` call; the agent uses the person's `grok login` session. The advertised
 *   `grok.com` method starts an interactive login, which Chalito never does.
 */
export const grokPreset: AcpPreset = {
  signInHint: "Sign in to Grok Build on this computer with `grok login`, or save an xAI API key.",
  harden(launch, { config, mode, home }) {
    launch.args.unshift("--sandbox", grokSandboxFor(mode));
    for (const k of GROK_COMPAT_OFF) launch.env[k] = "false";
    if (config.apiKey) {
      privateDir(home);
      writeFileSync(join(home, "requirements.toml"), GROK_REQUIREMENTS, { mode: 0o600 });
      launch.env.GROK_HOME = home;
    }
  },
  unsafeModes: ["bypassPermissions", "always-approve", "auto", "acceptEdits", "dontAsk"],
  allowedCommands: ["compact", "context", "session-info"],
};

/**
 * Gemini CLI admin-tier policy (Gemini docs, "Policy engine"): every tool, built-in or MCP, asks.
 * Admin rules beat user, extension and default rules, so read-only tools and the user's own
 * allow rules can't skip Chalito's gate. ACP mode is interactive, so "ask_user" becomes a
 * `session/request_permission` (gemini-cli 0.61.0, `interactive = ... || !!argv.acp`).
 */
export const GEMINI_POLICY = `# Written by Chalito. Every tool call asks, so Chalito's gate decides.
[[rule]]
toolName = "*"
decision = "ask_user"
priority = 999
`;

/**
 * Gemini CLI: `gemini --acp --approval-mode default` (gemini-cli 0.61.0 `--help`), plus
 * `--admin-policy` with GEMINI_POLICY.
 * - API key: `authenticate {methodId: "gemini-api-key", _meta: {"api-key": key}}`, so the key
 *   is never in the environment Gemini's tools inherit, and GEMINI_CLI_HOME is Chalito's own dir
 *   (authenticate persists the auth type to the home's settings and clears other cached
 *   credentials there, which must never be the person's own ~/.gemini).
 * - Sign-in: no `authenticate` call; `session/new` uses the person's saved "Log in with Google".
 */
export const geminiPreset: AcpPreset = {
  signInHint:
    "Sign in to Gemini CLI on this computer (run `gemini` and choose Log in with Google), or save a Gemini API key.",
  harden(launch, { config, home }) {
    const policyDir = join(home, "chalito-policy");
    privateDir(policyDir);
    writeFileSync(join(policyDir, "chalito.toml"), GEMINI_POLICY, { mode: 0o600 });
    launch.args.push("--admin-policy", policyDir);
    if (config.apiKey) {
      const cliHome = join(home, "home");
      privateDir(cliHome);
      launch.env.GEMINI_CLI_HOME = cliHome;
    }
  },
  keyInEnv: false,
  authenticate: (config, recipe) =>
    config.apiKey
      ? { methodId: recipe.driver.acp?.authMethods?.[0] ?? "gemini-api-key", _meta: { "api-key": config.apiKey } }
      : null,
  unsafeModes: ["yolo", "autoEdit"],
  safeMode: "default",
  allowedCommands: ["compress", "stats"],
};

/**
 * OpenCode (`opencode acp`, opencode-ai 1.18.34, VERIFIED): by default it runs edits and shell
 * commands without a `session/request_permission` ("most permissions default to allow").
 * OPENCODE_PERMISSION is merged into its config last, after managed settings, so `{"*":"ask"}`
 * makes every tool ask (run against 1.18.34). Its mode is a `mode` config option, `build` or
 * `plan`; with every tool asking, `build` is its ask mode.
 */
export const OPENCODE_PERMISSION = '{"*":"ask"}';
export const opencodePreset: AcpPreset = {
  harden(launch) {
    launch.env.OPENCODE_PERMISSION = OPENCODE_PERMISSION;
  },
  safeMode: "build",
};

/**
 * Goose (`goose acp`, 1.53.0, VERIFIED): modes `auto` (the default, never asks), `approve`
 * (asks for every tool), `smart_approve` (skips "read-only" ones) and `chat`. GOOSE_MODE=approve
 * starts it in `approve`; the generic policy holds it there.
 */
export const goosePreset: AcpPreset = {
  signInHint: "Set up Goose on this computer with `goose configure` (its provider and key), then try again.",
  harden(launch) {
    launch.env.GOOSE_MODE = "approve";
  },
  safeMode: "approve",
  unsafeModes: ["auto", "smart_approve"],
};

/**
 * Qwen Code (`qwen --acp --approval-mode default`, @qwen-code/qwen-code 0.25.0, VERIFIED): without
 * the flag it starts in `auto` (a classifier approves "safe" actions). Modes: plan, default,
 * auto-edit, auto, yolo. API key: `authenticate {methodId: "openai"}` with OPENAI_API_KEY.
 */
export const qwenPreset: AcpPreset = {
  harden(launch, { config }) {
    // The API-key method's own launch argument (advertised in its `_meta`); UNVERIFIED end to end.
    if (config.apiKey) launch.args.push("--auth-type", "openai");
  },
  signInHint: "Sign in to Qwen Code on this computer (run `qwen` and choose a sign-in), or save an API key.",
  safeMode: "default",
  unsafeModes: ["auto", "auto-edit", "yolo"],
};

/**
 * Mistral Vibe (`vibe-acp`, 2.25.8, VERIFIED handshake): starts in `accept-edits`; `ask` asks for
 * everything, and the generic policy switches to it.
 */
export const vibePreset: AcpPreset = { safeMode: "ask", unsafeModes: ["accept-edits", "auto-approve"] };

/**
 * Agent-specific hardening, by recipe id or CLI name (`command[0]`'s basename). Every other ACP
 * recipe gets the generic policy only.
 */
export const ACP_PRESETS: Readonly<Record<string, AcpPreset>> = {
  grok: grokPreset,
  gemini: geminiPreset,
  opencode: opencodePreset,
  goose: goosePreset,
  "qwen-code": qwenPreset,
  qwen: qwenPreset,
  "mistral-vibe": vibePreset,
  "vibe-acp": vibePreset,
};

/**
 * The profile for any recipe with `driver.acp`. Throws when the recipe can't be run safely (no
 * ACP driver, an approval-skipping flag in its command, a key variable that isn't a key).
 */
export const profileFor = (
  recipe: AcpRecipe,
  presets: Readonly<Record<string, AcpPreset>> = ACP_PRESETS,
): AcpProfile => {
  const problem = acpRecipeProblem(recipe);
  if (problem) throw new Error(problem);
  const acp = recipe.driver.acp!;
  // By recipe id, else by the CLI's name, so a custom recipe for a known agent keeps its hardening.
  const bin = basename(acp.command[0]!)
    .replace(/\.(exe|cmd|bat|ps1)$/i, "")
    .toLowerCase();
  const key = Object.hasOwn(presets, recipe.id) ? recipe.id : Object.hasOwn(presets, bin) ? bin : null;
  const preset: AcpPreset = key ? presets[key]! : {};
  const title = recipe.name;
  return {
    id: recipe.id,
    title,
    signInHint:
      preset.signInHint ?? `Sign in to ${title} on this computer with its own sign-in, or save an API key for it.`,
    launch(config, mode) {
      if (!config.apiKey && !config.signIn) throw new Error(`${title} needs an API key or the CLI's own sign-in`);
      const env = baseEnv(config);
      if (config.apiKey && preset.keyInEnv !== false && recipe.apiKey && keyEnvAllowed(recipe.apiKey.env))
        env[recipe.apiKey.env] = config.apiKey;
      const launch: AcpLaunch = { command: config.binPath ?? acp.command[0]!, args: acp.command.slice(1), env };
      preset.harden?.(launch, { config, mode, home: stateDir(config, recipe.id) });
      // Checked again after the preset: nothing may add a flag that skips approvals.
      const bad = unsafeLaunchArg(launch.args);
      if (bad) throw new Error(`${title}: refusing to launch with "${bad}"`);
      return launch;
    },
    authenticate(config, advertised = []) {
      if (preset.authenticate) return preset.authenticate(config, recipe);
      if (!config.apiKey) return null;
      const interactive = new Set(advertised.flatMap((m) => ("type" in m && m.type === "terminal" ? [m.id] : [])));
      const methodId = (acp.authMethods ?? []).find((m) => !interactive.has(m));
      return methodId ? { methodId } : null;
    },
    unsafeModes: preset.unsafeModes ?? [],
    ...(preset.safeMode ? { safeMode: preset.safeMode } : {}),
    allowedCommands: preset.allowedCommands ?? [],
  };
};

/** The built-in recipe for a dedicated adapter kind. */
export const builtinAcpRecipe = (kind: AcpKind): AcpRecipe => BUILTIN_ACP_RECIPES[kind];
