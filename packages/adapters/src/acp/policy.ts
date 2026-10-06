/**
 * The generic hardening every ACP agent gets, whatever its recipe says (D-064). An agent-specific
 * preset (profiles.ts) can only add to it: name its ask mode, list more unsafe modes, allow a few
 * harmless slash commands. Nothing here ever loosens Chalito's gate:
 * - launch flags that turn approvals off are refused before the process starts;
 * - where the agent exposes session modes (or a "mode" config option), the session is held in the
 *   mode that asks, and a switch to anything that might not ask is undone or ends the session;
 * - slash commands the agent advertises are refused unless allowlisted, and commands whose name
 *   is about approvals, permissions, modes or trust are refused even when not advertised;
 * - every `session/request_permission` goes through the gate, answered with a one-time option
 *   (never `allow_always`); see adapter.ts.
 */

/**
 * Command-line switches that skip or widen approvals in the ACP agents we know of (Gemini/Qwen
 * `--yolo`, `--approval-mode yolo|auto_edit`; Grok `--always-approve`; Claude
 * `--dangerously-skip-permissions`; Codex `--full-auto`/`--dangerously-bypass-…`; Copilot
 * `--allow-all-tools`; sandbox off switches). A recipe whose command contains one is refused.
 */
const UNSAFE_FLAG =
  /^--?(?:y|yolo|always[-_]?approve|auto[-_]?approve|dangerously[-\w]*|full[-_]?auto|bypass[-\w]*|allow[-_]?all[-\w]*|skip[-_]?permissions?[-\w]*|no[-_]?(?:confirm|approval|sandbox|ask)[-\w]*|trust[-_]?all[-\w]*|accept[-_]?all[-\w]*)(?:=.*)?$/i;
/** `--approval-mode <v>` / `--approval-mode=<v>` / `--permission-mode <v>` / `--sandbox <v>` values that skip asks. */
const MODE_FLAG = /^--?(?:approval[-_]?mode|permission[-_]?mode|ask[-_]?for[-_]?approval|mode|sandbox)$/i;
const UNSAFE_MODE_VALUE =
  /^(?:yolo|auto(?:[-_]?edit)?|always|never|full[-_]?access|bypass[-\w]*|accept[-_]?edits|dont[-_]?ask|danger[-\w]*|off|none|devbox|unrestricted|trust[-\w]*)$/i;

/** The first unsafe switch in `args`, or null. */
export const unsafeLaunchArg = (args: readonly string[]): string | null => {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (UNSAFE_FLAG.test(a)) return a;
    const eq = /^(--?[\w-]+)=(.*)$/.exec(a);
    if (eq && MODE_FLAG.test(eq[1]!) && UNSAFE_MODE_VALUE.test(eq[2]!)) return a;
    if (MODE_FLAG.test(a) && args[i + 1] !== undefined && UNSAFE_MODE_VALUE.test(args[i + 1]!))
      return `${a} ${args[i + 1]}`;
  }
  return null;
};

/** Mode ids/names that mean "the agent acts without asking". */
const UNSAFE_MODE =
  /yolo|bypass|always|auto|accept|dont[-_ ]?ask|don't ask|full[-_ ]?access|skip|unrestricted|danger|trust|no[-_ ]?confirm|allow[-_ ]?all/i;
/** Mode ids that ask before acting (preferred, in this order) or only read. */
const ASK_MODES = ["default", "ask", "ask-before-edits", "manual", "approve", "normal", "suggest", "review"];
const READ_ONLY_MODES = ["plan", "read-only", "readonly", "read_only", "chat"];

export interface ModePolicy {
  /** The agent's own name for its ask mode, if it has one (Gemini: "default"). */
  readonly safeMode?: string;
  /** Extra mode ids known to skip prompts, on top of the generic pattern. */
  readonly unsafeModes: readonly string[];
}

export type ModeClass = "ask" | "read_only" | "unsafe" | "unknown";

/** How Chalito treats a mode id (and, optionally, its display name). */
export const classifyMode = (policy: ModePolicy, id: string, name = ""): ModeClass => {
  if (policy.unsafeModes.includes(id) || UNSAFE_MODE.test(id) || UNSAFE_MODE.test(name)) return "unsafe";
  const norm = id.toLowerCase();
  if (id === policy.safeMode || ASK_MODES.includes(norm)) return "ask";
  if (READ_ONLY_MODES.includes(norm)) return "read_only";
  return "unknown";
};

/**
 * The mode to hold the session in, from the ones the agent offers: the preset's ask mode, else
 * the first generic ask mode, else a read-only one. Null when nothing offered is known to ask.
 */
export const askModeOf = (policy: ModePolicy, available: readonly { id: string; name?: string }[]): string | null => {
  const ids = available.map((m) => m.id);
  if (policy.safeMode && ids.includes(policy.safeMode)) return policy.safeMode;
  for (const want of ASK_MODES) {
    const m = available.find((x) => x.id.toLowerCase() === want && classifyMode(policy, x.id, x.name) === "ask");
    if (m) return m.id;
  }
  const ro = available.find((x) => classifyMode(policy, x.id, x.name) === "read_only");
  return ro?.id ?? null;
};

/** Is `mode` acceptable while the session runs (`target` is the ask mode it is held in, if any)? */
export const modeAllowed = (policy: ModePolicy, target: string | null, id: string, name = ""): boolean => {
  if (id === target) return true;
  const c = classifyMode(policy, id, name);
  // With an ask mode to go back to, only ask or read-only modes may stay; without one, anything
  // not known to skip prompts stays (permission requests still all reach the gate).
  return target ? c === "ask" || c === "read_only" : c !== "unsafe";
};

/** Boolean config options whose `true` would skip prompts ("yolo", "auto-approve", …). */
export const unsafeToggle = (id: string, name = ""): boolean => UNSAFE_MODE.test(id) || UNSAFE_MODE.test(name);

/**
 * Slash-command names refused even when the agent doesn't advertise them (its
 * `available_commands_update` can arrive after the first prompt): anything about approvals,
 * permissions, modes, sandboxing, trust, hooks, MCP servers, settings or sign-in.
 */
const RISKY_COMMAND =
  /yolo|approv|permission|always|bypass|auto|trust|mode|allow|sandbox|danger|skip|hook|mcp|polic|setting|config|login|logout|auth|extension|plugin|privacy|director|shell|terminal|exec/i;

/** The first word of a slash command ("/always-approve on" → "always-approve"), or null. */
export const slashCommand = (text: string): string | null => /^\s*\/([\w:.-]+)/.exec(text)?.[1] ?? null;

/**
 * Whether a prompt's slash command may reach the agent: allowlisted commands always, others only
 * when the agent doesn't advertise them and the name is nothing approval-related (a prompt that
 * starts with a path, "/src/a.ts: why…", is not a command).
 */
export const commandAllowed = (name: string, allowed: readonly string[], advertised: ReadonlySet<string>): boolean => {
  if (allowed.includes(name)) return true;
  if (advertised.has(name)) return false;
  return !RISKY_COMMAND.test(name);
};

/**
 * Environment variable names a recipe may ask the API key to be passed in: an upper-case name
 * ending in KEY or TOKEN, never one the loader, a runtime, the shell or Chalito reads.
 */
const KEY_ENV = /^[A-Z][A-Z0-9_]{0,62}(?:KEY|TOKEN)$/;
const RESERVED_ENV = /^(?:CHALITO_|LD_|DYLD_|NODE_|NPM_|PYTHON|GIT_|SSH_|GPG_|BASH_|PS4$)/;
export const keyEnvAllowed = (name: string): boolean => KEY_ENV.test(name) && !RESERVED_ENV.test(name);
