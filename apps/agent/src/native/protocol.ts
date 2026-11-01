import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

export const NativeProvider = z.enum(["codex", "claude", "cursor"]);
export type NativeProvider = z.infer<typeof NativeProvider>;
export const NATIVE_APPS = { codex: "codex", claude: "claude-code", cursor: "cursor-cli" } as const;
export const NativeHookRequest = z
  .object({
    provider: NativeProvider,
    event: z.enum(["start", "permission", "tool", "prompt", "stop", "end"]),
    nativeSessionId: z.string().min(1).max(256),
    cwd: z.string().min(1).max(4096).refine(isAbsolute, "absolute working directory required"),
    toolName: z.string().min(1).max(200).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    text: z.string().max(20_000).optional(),
  })
  .strict();
export type NativeHookRequest = z.infer<typeof NativeHookRequest>;
export interface NativeHookReply {
  ok: boolean;
  sid?: string;
  url?: string;
  allow?: boolean;
  /** No decision: the folder is not a Chalito workspace, so the app's own permission flow runs. */
  pass?: boolean;
  reason?: string;
}

const events = {
  SessionStart: "start",
  sessionStart: "start",
  PermissionRequest: "permission",
  PreToolUse: "tool",
  preToolUse: "tool",
  UserPromptSubmit: "prompt",
  beforeSubmitPrompt: "prompt",
  Stop: "stop",
  stop: "stop",
  SessionEnd: "end",
  sessionEnd: "end",
} as const;

export const nativeHookEvent = (event: string): boolean => Object.hasOwn(events, event);
export const nativePermissionEvent = (event: string): boolean =>
  event === "PermissionRequest" || event === "PreToolUse" || event === "preToolUse";

/** Reads only hook metadata and the requested operation. Never opens transcripts or auth files. */
export const nativeHookInput = (
  provider: NativeProvider,
  expectedEvent: string,
  raw: string,
): NativeHookRequest | null => {
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024 || !Object.hasOwn(events, expectedEvent)) return null;
  let h: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    h = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (h.hook_event_name !== undefined && h.hook_event_name !== expectedEvent) return null;
  const event = events[expectedEvent as keyof typeof events];
  const roots = Array.isArray(h.workspace_roots) ? h.workspace_roots : [];
  const cwd = h.cwd ?? roots[0];
  const input = h.tool_input;
  const text = event === "prompt" ? h.prompt : event === "stop" ? h.last_assistant_message : undefined;
  const request = NativeHookRequest.safeParse({
    provider,
    event,
    nativeSessionId: h.session_id ?? h.thread_id ?? h.conversation_id,
    cwd,
    ...(typeof text === "string"
      ? { text: text.length <= 20_000 ? text : `${text.slice(0, 19_960)}\n[Message truncated]` }
      : {}),
    ...(event === "permission" || event === "tool"
      ? {
          toolName: h.tool_name,
          input: input && typeof input === "object" && !Array.isArray(input) ? input : { value: input ?? null },
        }
      : {}),
  });
  return request.success ? request.data : null;
};

type DenyKind =
  "not_running" | "denied" | "expired" | "policy" | "busy" | "disabled" | "too_large" | "ambiguous_path" | "generic";
const DENY_KIND: Record<string, DenyKind> = {
  not_running: "not_running",
  signed_deny: "denied",
  timeout_deny: "expired",
  policy_block: "policy",
  hard_floor: "policy",
  no_workspace: "policy",
  origin_disabled: "policy",
  plan_mode: "policy",
  outside_workspace: "policy",
  busy: "busy",
  session_limit: "busy",
  too_many_pending: "busy",
  rate_limited: "busy",
  connector_disabled: "disabled",
  too_large: "too_large",
  ambiguous_path: "ambiguous_path",
};
const DENY_TEXT: Record<"es" | "en", Record<DenyKind, string>> = {
  en: {
    not_running: "Chalito isn't running on this computer. Open Chalito to approve this action.",
    denied: "You denied this action in Chalito.",
    expired: "Nobody answered this request in Chalito in time, so it was denied.",
    policy: "Chalito's rules for this folder block this action.",
    busy: "Chalito has too many requests waiting. Try again in a moment.",
    disabled: "Chalito's connector for this app is turned off. Turn it on in Chalito's Connected AI tab.",
    too_large: "This request is too large for Chalito to review, so it was denied.",
    ambiguous_path: "This request names two different files, so Chalito denied it.",
    generic: "Chalito did not approve this action. Check Chalito on this computer or on your phone.",
  },
  es: {
    not_running: "Chalito no está abierto en esta computadora. Abre Chalito para aprobar esta acción.",
    denied: "Rechazaste esta acción en Chalito.",
    expired: "Nadie respondió esta solicitud en Chalito a tiempo, así que se rechazó.",
    policy: "Las reglas de Chalito para esta carpeta bloquean esta acción.",
    busy: "Chalito tiene demasiadas solicitudes pendientes. Inténtalo de nuevo en un momento.",
    disabled: "El conector de Chalito para esta app está apagado. Actívalo en la pestaña IA conectada de Chalito.",
    too_large: "Esta solicitud es demasiado grande para que Chalito la revise, así que se rechazó.",
    ambiguous_path: "Esta solicitud menciona dos archivos distintos, así que Chalito la rechazó.",
    generic: "Chalito no aprobó esta acción. Revisa Chalito en esta computadora o en tu teléfono.",
  },
};
export const nativeDenyMessage = (reason: string | undefined, locale: "es" | "en" = "en"): string =>
  DENY_TEXT[locale][(reason && Object.hasOwn(DENY_KIND, reason) ? DENY_KIND[reason] : undefined) ?? "generic"];

/** A tool-permission denial in each vendor's shape, for hooks that cannot tell which event ran. */
export const nativeHookDeny = (
  provider: NativeProvider,
  reason: string,
  locale: "es" | "en" = "en",
): Record<string, unknown> =>
  nativeHookOutput(provider, provider === "cursor" ? "preToolUse" : "PreToolUse", { ok: false, reason }, locale);

/** Exact vendor response shapes: a boolean from an unverified transport never becomes an allow. */
export const nativeHookOutput = (
  provider: NativeProvider,
  event: string,
  reply: NativeHookReply,
  locale: "es" | "en" = "en",
): Record<string, unknown> => {
  if (nativePermissionEvent(event)) {
    const allow = reply.ok === true && reply.allow === true;
    if (!allow && reply.ok === true && reply.pass === true) return {};
    // Codex rejects an explicit `allow` as a hook failure: no output is its "no objection".
    if (allow && provider === "codex") return {};
    const message = nativeDenyMessage(reply.reason, locale);
    return provider === "cursor"
      ? { permission: allow ? "allow" : "deny", ...(!allow ? { user_message: message, agent_message: message } : {}) }
      : event === "PreToolUse"
        ? {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: allow ? "allow" : "deny",
              ...(!allow ? { permissionDecisionReason: message } : {}),
            },
          }
        : {
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: { behavior: allow ? "allow" : "deny", ...(!allow ? { message } : {}) },
            },
          };
  }
  if ((event === "SessionStart" || event === "sessionStart") && reply.ok && reply.url) {
    const context = `This session is connected to Chalito. Its phone link is ${reply.url}. If the user asks for their Chalito link, provide this URL. It requires their Chalito sign-in.`;
    return provider === "cursor"
      ? { additional_context: context }
      : { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } };
  }
  if (provider === "cursor" && event === "beforeSubmitPrompt") return { continue: true };
  return {};
};

/** Written by the agent so a hook can tell workspace folders apart while the agent is down. */
export const NATIVE_WORKSPACES_FILE = "native-workspaces.json";
const WorkspacesFile = z.object({ v: z.literal(1), paths: z.array(z.string().min(1).max(4096)).max(1000) });

const realOrResolved = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};

/** Every form a policy path may take (`~`, as written, resolved): more paths only means more denials. */
export const nativeWorkspacePaths = (workspaces: { path: string; realPath?: string }[], home: string): string[] => {
  const out = new Set<string>();
  for (const w of workspaces) {
    const expanded = w.path === "~" ? home : w.path.startsWith("~/") ? join(home, w.path.slice(2)) : w.path;
    for (const p of [expanded, w.path, ...(w.realPath ? [w.realPath] : [])]) {
      out.add(resolve(p));
      out.add(realOrResolved(p));
    }
  }
  return [...out];
};

export const writeNativeWorkspaces = (dir: string, paths: string[]): void => {
  const file = join(dir, NATIVE_WORKSPACES_FILE);
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, paths })}\n`, { mode: 0o600, flag: "wx" });
  try {
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
};

/** `unknown` (file missing, unreadable or malformed) must be treated like `inside`: fail closed. */
export const nativeWorkspaceStatus = (
  dir: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): "inside" | "outside" | "unknown" => {
  let paths: string[];
  try {
    const raw = readFileSync(join(dir, NATIVE_WORKSPACES_FILE), "utf8");
    if (raw.length > 4 * 1024 * 1024) return "unknown";
    paths = WorkspacesFile.parse(JSON.parse(raw)).paths;
  } catch {
    return "unknown";
  }
  const fold = (p: string) => (platform === "win32" || platform === "darwin" ? p.toLowerCase() : p);
  const here = fold(realOrResolved(cwd));
  return paths.some((p) => {
    const root = fold(p);
    return here === root || here.startsWith(root.endsWith(sep) ? root : root + sep);
  })
    ? "inside"
    : "outside";
};
