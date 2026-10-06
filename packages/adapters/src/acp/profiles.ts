import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RemotePermissionMode } from "@chalito/protocol";
import { allowedEnv } from "../env.js";

/**
 * How Chalito launches and authenticates each ACP agent (D-022). One generic ACP client
 * (adapter.ts) serves every profile; a profile only knows its CLI's flags, auth method ids and
 * the switches that keep every tool call on Chalito's gate.
 */

export type AcpKind = "grok" | "gemini";

export interface AcpConfig {
  /** The user's own CLI, pinned by `chalito <kind> pin` (never bundled, never a PATH lookup here). */
  binPath?: string;
  /** BYO provider API key from the OS keychain. Wins over sign-in when both are there. */
  apiKey?: string;
  /**
   * Use the CLI's own sign-in, done by the person in the official tool (`grok login`, `gemini`'s
   * "Log in with Google"). Chalito never starts that login and never reads its tokens; the daemon
   * sets this only when `providers.yaml: <provider>.subscriptionLocal` allows it.
   */
  signIn?: boolean;
  /**
   * Chalito's own state dir for this CLI (default ~/.chalito/<kind>). With an API key it is the
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

export interface AcpProfile {
  readonly kind: AcpKind;
  /** Product name, for error messages. */
  readonly title: string;
  /** What to tell a person whose CLI sign-in is missing or expired. */
  readonly signInHint: string;
  /** Builds the command line and environment, and writes any file the CLI needs first. */
  launch(config: AcpConfig, mode: RemotePermissionMode): AcpLaunch;
  /** The `authenticate` request, or null to rely on the CLI's own cached sign-in. */
  authenticate(config: AcpConfig): { methodId: string; _meta?: Record<string, unknown> } | null;
  /**
   * ACP session modes that skip prompts. If the agent reports one, the adapter switches back to
   * `safeMode` (the gate must see every call).
   */
  readonly unsafeModes: readonly string[];
  readonly safeMode?: string;
  /**
   * Slash commands a prompt may run. Any other command the agent advertises is refused before it
   * reaches the agent: some flip approvals off (Grok's `/always-approve`).
   */
  readonly allowedCommands: readonly string[];
}

const stateDir = (config: AcpConfig, kind: AcpKind) => config.home ?? join(homedir(), ".chalito", kind);

const baseEnv = (config: AcpConfig) => {
  // An allowlist, never the daemon's whole environment (review R-L12).
  const env = allowedEnv(config.env ?? process.env);
  // Marks everything the CLI runs as inside a Chalito session: the `chalito` CLI refuses to
  // change keys, trust, policy or Developer mode from here.
  env.CHALITO_SESSION = "1";
  return env;
};

const needsAuth = (config: AcpConfig, title: string) => {
  if (!config.apiKey && !config.signIn) throw new Error(`${title} needs an API key or the CLI's own sign-in`);
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
 *   1.0.46 agent accepts the id without advertising it). Sign-in: no `authenticate` call; the
 *   agent uses the person's `grok login` session. The advertised `grok.com` method starts an
 *   interactive login, which Chalito never does.
 */
export const grokProfile: AcpProfile = {
  kind: "grok",
  title: "Grok Build",
  signInHint: "Sign in to Grok Build on this computer with `grok login`, or save an xAI API key.",
  launch(config, mode) {
    needsAuth(config, this.title);
    const env = baseEnv(config);
    for (const k of GROK_COMPAT_OFF) env[k] = "false";
    if (config.apiKey) {
      env.XAI_API_KEY = config.apiKey;
      const home = stateDir(config, "grok");
      privateDir(home);
      writeFileSync(join(home, "requirements.toml"), GROK_REQUIREMENTS, { mode: 0o600 });
      env.GROK_HOME = home;
    }
    return {
      command: config.binPath ?? "grok",
      args: ["--no-auto-update", "--sandbox", grokSandboxFor(mode), "agent", "--no-leader", "stdio"],
      env,
    };
  },
  authenticate: (config) => (config.apiKey ? { methodId: "xai.api_key" } : null),
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
 * Gemini CLI: `gemini --acp` (gemini-cli 0.61.0 `--help`; `--experimental-acp` is the deprecated
 * alias).
 * - `--approval-mode default`, never `yolo` or `auto_edit`; `--admin-policy` adds GEMINI_POLICY.
 * - API key: `authenticate {methodId: "gemini-api-key", _meta: {"api-key": key}}`, so the key
 *   is never in the environment Gemini's tools inherit, and GEMINI_CLI_HOME is Chalito's own dir
 *   (authenticate persists the auth type to the home's settings and clears other cached
 *   credentials there, which must never be the person's own ~/.gemini).
 * - Sign-in: no `authenticate` call; `session/new` uses the person's saved "Log in with Google".
 */
export const geminiProfile: AcpProfile = {
  kind: "gemini",
  title: "Gemini CLI",
  signInHint:
    "Sign in to Gemini CLI on this computer (run `gemini` and choose Log in with Google), or save a Gemini API key.",
  launch(config) {
    needsAuth(config, this.title);
    const env = baseEnv(config);
    const dir = stateDir(config, "gemini");
    const policyDir = join(dir, "chalito-policy");
    privateDir(policyDir);
    writeFileSync(join(policyDir, "chalito.toml"), GEMINI_POLICY, { mode: 0o600 });
    if (config.apiKey) {
      const home = join(dir, "home");
      privateDir(home);
      env.GEMINI_CLI_HOME = home;
    }
    return {
      command: config.binPath ?? "gemini",
      args: ["--acp", "--approval-mode", "default", "--admin-policy", policyDir],
      env,
    };
  },
  authenticate: (config) =>
    config.apiKey ? { methodId: "gemini-api-key", _meta: { "api-key": config.apiKey } } : null,
  unsafeModes: ["yolo", "autoEdit"],
  safeMode: "default",
  allowedCommands: ["compress", "stats"],
};

export const ACP_PROFILES: Record<AcpKind, AcpProfile> = { grok: grokProfile, gemini: geminiProfile };
