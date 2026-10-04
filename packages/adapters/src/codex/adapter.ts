import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Origin, RemotePermissionMode } from "@chalito/protocol";
import type { AdapterEvent, Question, SessionAdapter, SessionHandle, SessionStartOptions, ToolCall } from "../core.js";

/**
 * Codex adapter over `codex app-server` on stdio (VERIFIED_APIS §1, D-021): newline-delimited
 * JSON, JSON-RPC shaped but without the "jsonrpc" field.
 */

/** One process speaking JSONL on stdio. Injected in tests (fake app-server, transcript replay). */
export interface CodexTransport {
  /** Writes one message (the transport adds the newline). */
  send(line: string): void;
  /** Incoming lines from the server's stdout. Ends when the process exits. */
  readonly lines: AsyncIterable<string>;
  /** Closes stdin; app-server exits on EOF. */
  close(): void;
}
/** `cwd` is the session's working directory; app-server takes the thread's cwd from it (see APPROVAL_POLICY). */
export type CodexSpawn = (
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
) => CodexTransport;

/** Codex releases this adapter is tested against: `min` inclusive, `below` exclusive. */
export interface CodexVersionRange {
  min: string;
  below: string;
}
/** Built and tested against openai/codex main at 550eb50 (2026-10-03, after rust-v0.162.0-alpha.11). */
export const DEFAULT_CODEX_VERSIONS: CodexVersionRange = { min: "0.160.0", below: "0.163.0" };

export interface CodexConfig {
  /** The user's own Codex install (never bundled). Defaults to `codex` on PATH. */
  codexPath?: string;
  /** BYO OpenAI API key from the OS keychain; logged in with `account/login/start {type:"apiKey"}`. */
  apiKey?: string;
  /**
   * ChatGPT plan through OpenAI's official Sign in with ChatGPT (D-003, ADR 0004). The agent owns
   * the SIWC token lifecycle; the adapter only hands the access token to app-server through the
   * `openai_chatgpt_plan` model provider. Never Codex's built-in `account/login/start {type:"chatgpt"}`.
   */
  chatgptPlan?: { accessToken: string };
  /** `providers.yaml: openai.subscriptionLocal` resolved for this user (owner_only/approved → true). */
  chatgptPlanEnabled?: boolean;
  model?: string;
  /** Reported in `initialize.clientInfo.version`. */
  clientVersion?: string;
  /**
   * Chalito's own Codex state dir, passed as CODEX_HOME so the API-key login, trust decisions and
   * rules never touch the user's own ~/.codex. Defaults to ~/.chalito/codex.
   */
  codexHome?: string;
  /** Refuse app-server builds outside this range (app-server is experimental, D-021). */
  versions?: CodexVersionRange;
  /** Injected in tests; defaults to spawning the binary. */
  spawn?: CodexSpawn;
  /** Base environment (defaults to process.env). */
  env?: Record<string, string | undefined>;
}

/** `-c` overrides for the SIWC ChatGPT-plan provider, verbatim from VERIFIED_APIS §2. */
export const CHATGPT_PLAN_OVERRIDES = [
  'model_provider="openai_chatgpt_plan"',
  'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
  'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
  'model_providers.openai_chatgpt_plan.wire_api="responses"',
  "model_providers.openai_chatgpt_plan.requires_openai_auth=false",
  "model_providers.openai_chatgpt_plan.supports_websockets=false",
];

/**
 * Tools that act without an approval request are switched off on every launch. `-c` overrides
 * are the runtime layer, the highest-precedence config layer (config/src/loader/mod.rs, layer
 * list), so user, system and project config can't turn them back on. Checked in openai/codex
 * codex-rs at 550eb50:
 * - `web_search` (config/src/config_toml.rs `ConfigToml.web_search`, WebSearchMode): wins over the
 *   web_search_* feature flags (core/src/config/mod.rs `resolve_web_search_mode`). Managed
 *   requirements can't force it back on: `allowed_web_search_modes` always accepts `disabled`
 *   (config/src/config_requirements.rs).
 * - `features.view_image` (features/src/lib.rs `Feature::ViewImage`; the tool is only registered
 *   when enabled, core/src/tools/spec_plan.rs). Reads images anywhere without asking.
 * - Also off: apps/plugins/MCP apps (MCP-backed tools), js_repl, code_mode, browser_use and
 *   computer_use, which run outside the command/patch approval path.
 * If managed requirements pin one of these features on, config loading fails
 * (core/src/config/managed_features.rs `validate_explicit_feature_settings_in_config_toml`) and the
 * session fails closed instead of running with it.
 * MCP servers can't be masked this way: layers deep-merge (config/src/merge.rs
 * `merge_toml_values`), so `mcp_servers={}` doesn't remove servers from system, admin or cloud
 * layers. The adapter checks `mcpServerStatus/list` after thread/start instead and refuses to run.
 */
export const HARDENING_OVERRIDES = [
  'web_search="disabled"',
  "features.web_search_request=false",
  "features.web_search_cached=false",
  "features.standalone_web_search=false",
  "features.view_image=false",
  "features.apps=false",
  "features.plugins=false",
  "features.enable_mcp_apps=false",
  "features.js_repl=false",
  "features.code_mode=false",
  "features.browser_use=false",
  "features.computer_use=false",
];

/** Credentials that would take precedence over the configured auth. */
const STRIPPED_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY", "ACCESS_TOKEN"];

export const codexLaunch = (
  config: CodexConfig,
): { command: string; args: string[]; env: Record<string, string | undefined> } => {
  const env = { ...(config.env ?? process.env) };
  for (const k of STRIPPED_ENV) delete env[k];
  env.CODEX_HOME = config.codexHome ?? join(homedir(), ".chalito", "codex");
  const args = ["app-server", "--listen", "stdio://"];
  for (const o of HARDENING_OVERRIDES) args.push("-c", o);
  if (config.chatgptPlan) {
    if (!config.chatgptPlanEnabled) throw new Error("ChatGPT plan usage is not enabled for this user");
    env.ACCESS_TOKEN = config.chatgptPlan.accessToken;
    for (const o of CHATGPT_PLAN_OVERRIDES) args.push("-c", o);
  } else if (!config.apiKey) {
    throw new Error("Codex needs an API key or a ChatGPT plan token");
  }
  return { command: config.codexPath ?? "codex", args, env };
};

const spawnTransport: CodexSpawn = (command, args, env, cwd) => {
  // Codex refuses a CODEX_HOME that doesn't exist.
  if (env.CODEX_HOME) mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });
  const child = nodeSpawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.on("error", () => lines.close());
  child.stdin.on("error", () => undefined);
  return {
    send: (line) => {
      if (child.stdin.writable) child.stdin.write(`${line}\n`);
    },
    lines,
    close: () => child.stdin.end(),
  };
};

/**
 * Every command and every file change must reach the gate (local policy sees everything).
 * Checked in openai/codex codex-rs at 550eb50:
 * - core/src/exec_policy.rs `render_decision_for_unmatched_command_for_platform`: under
 *   `UnlessTrusted` ("untrusted") every command not matched by an explicit `*.rules` allow
 *   prefix rule is `Decision::Prompt`; there is no built-in "known safe" auto-run list any more.
 *   `OnRequest` and `Granular` both `Allow` non-escalated commands inside a restricted sandbox.
 * - core/src/safety.rs `assess_patch_safety`: `UnlessTrusted` returns `AskUser` for every patch;
 *   `OnRequest` and `Granular` auto-approve patches inside writable roots, so granular can't force it.
 * Allow rules only come from `rules/` of enabled config layers (core/src/exec_policy.rs
 * `load_exec_policy`): CODEX_HOME (Chalito's own, empty; we never send
 * `acceptWithExecpolicyAmendment`), trusted project `.codex/` dirs, and admin/system config.
 * Projects stay untrusted because thread/start never carries `cwd`: app-server's
 * `thread_start_task` (app-server/src/request_processors/thread_processor.rs) persists
 * `trust_level = "trusted"` when a request has a cwd and the sandbox can write it, which would
 * load the repo's own `.codex/` rules and hooks. The process is spawned in the session cwd instead.
 * An untrusted project's config can't weaken any of this either: the cwd, tree and repo
 * `.codex/` layers are "loaded but disabled when untrusted" (config/src/loader/mod.rs layer list,
 * `ProjectTrustContext::disabled_reason_for_decision`: "project-local config, hooks, and exec
 * policies"), and disabled layers are skipped by `ConfigLayerStack::layers_low_to_high`
 * (config/src/state.rs), which both `effective_config` and `load_exec_policy` iterate. Even a
 * trusted project sits below the runtime `-c` layer. Residual: trust can still be granted by
 * system, admin or cloud config (a `[projects]` entry), which is the machine admin's choice.
 */
export const APPROVAL_POLICY = "untrusted";

const parseVersion = (v: string): number[] | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmpVersion = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;

/** The Codex version from initialize's userAgent (`<originator>/<version> (<os>; <arch>) ...`). */
export const codexVersionFromUserAgent = (userAgent: string): string | null =>
  /^[^/\s]+\/(\d+\.\d+\.\d+[\w.+-]*)/.exec(userAgent)?.[1] ?? null;

export const checkCodexVersion = (userAgent: string, range: CodexVersionRange = DEFAULT_CODEX_VERSIONS) => {
  const version = codexVersionFromUserAgent(userAgent);
  const v = version ? parseVersion(version) : null;
  const min = parseVersion(range.min);
  const below = parseVersion(range.below);
  if (v && min && below && cmpVersion(v, min) >= 0 && cmpVersion(v, below) < 0) return;
  throw Object.assign(
    new Error(
      `Codex ${version ?? `(unrecognised version in "${userAgent}")`} is outside the tested range ` +
        `>=${range.min} <${range.below}. Install a Codex release in that range, or update Chalito.`,
    ),
    { code: "unsupported_version" },
  );
};

/** Thread-level sandbox (kebab-case). Never "danger-full-access"; unknown modes fail closed. */
export const sandboxModeFor = (mode: RemotePermissionMode): "read-only" | "workspace-write" =>
  mode === "default" || mode === "acceptEdits" ? "workspace-write" : "read-only";

/** Per-turn `sandboxPolicy` (tagged, camelCase). Never `dangerFullAccess`. */
export const sandboxPolicyFor = (mode: RemotePermissionMode): Record<string, unknown> =>
  sandboxModeFor(mode) === "workspace-write"
    ? {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }
    : { type: "readOnly", networkAccess: false };

type Id = number | string;
interface Msg {
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}
interface Item {
  type: string;
  id: string;
  text?: string;
  command?: string;
  cwd?: string;
  status?: string;
  changes?: { path: string }[];
  server?: string;
  tool?: string;
  arguments?: unknown;
}

const errorCode = (info: unknown): Extract<AdapterEvent, { type: "error" }>["code"] => {
  if (info === "unauthorized") return "auth_required";
  if (info === "usageLimitExceeded" || info === "sessionBudgetExceeded") return "quota_exhausted";
  if (info === "rateLimitExceeded") return "rate_limited";
  return "internal";
};

/** The tool name and input the gate and events see for a Codex item; null for non-tool items. */
const toolOf = (item: Item): { toolName: string; input: Record<string, unknown> } | null => {
  switch (item.type) {
    case "commandExecution":
      return { toolName: "Bash", input: { command: item.command ?? "", cwd: item.cwd } };
    case "fileChange":
      return { toolName: "Edit", input: { file_path: item.changes?.[0]?.path ?? "" } };
    case "mcpToolCall":
      return {
        toolName: `mcp__${item.server ?? ""}__${item.tool ?? ""}`,
        input: (item.arguments ?? {}) as Record<string, unknown>,
      };
    case "dynamicToolCall":
      return { toolName: item.tool ?? "dynamic", input: (item.arguments ?? {}) as Record<string, unknown> };
    case "webSearch":
      return { toolName: "WebSearch", input: {} };
    default:
      return null;
  }
};

export class CodexAdapter implements SessionAdapter {
  readonly kind = "codex" as const;

  constructor(private readonly config: CodexConfig) {}

  async start(opts: SessionStartOptions): Promise<SessionHandle> {
    const launch = codexLaunch(this.config);
    const t = (this.config.spawn ?? spawnTransport)(launch.command, launch.args, launch.env, opts.cwd);

    let nextId = 0;
    const pending = new Map<Id, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const send = (m: Msg) => t.send(JSON.stringify(m));
    const request = <T>(method: string, params: unknown): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        send({ id, method, params: params as Record<string, unknown> });
      });

    let origin: Origin = opts.origin;
    let mode: RemotePermissionMode = opts.permissionMode;
    let threadId = "";
    /** null: no turn running; "": turn/start sent, id not known yet. */
    let turnId: string | null = null;
    let turnStart: Promise<string | null> = Promise.resolve(null);
    let turnAbort = new AbortController();
    let interrupted = false;
    let closed = false;
    let startFailed = false;
    const queue: { text: string; origin: Origin }[] = [];
    const items = new Map<string, Item>();
    const deltas = new Map<string, string>();

    const flushText = (itemId: string, final?: string) => {
      const text = final || deltas.get(itemId) || "";
      deltas.delete(itemId);
      if (text) opts.onEvent({ type: "assistant_text", text });
    };

    const startTurn = (text: string, turnOrigin: Origin) => {
      origin = turnOrigin;
      interrupted = false;
      turnAbort = new AbortController();
      turnId = "";
      turnStart = request<{ turn: { id: string } }>("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        approvalPolicy: APPROVAL_POLICY,
        sandboxPolicy: sandboxPolicyFor(mode),
      }).then(
        (r) => {
          if (turnId === "") turnId = r.turn.id;
          return r.turn.id;
        },
        (err: Error) => {
          turnId = null;
          if (!closed) {
            opts.onEvent({ type: "error", code: "internal", message: err.message });
            opts.onEvent({ type: "state", state: "failed" });
          }
          return null;
        },
      );
    };

    const gate = async (call: Omit<ToolCall, "sid" | "origin">): Promise<boolean> => {
      const res = await opts.gate({ sid: opts.sid, origin, ...call }, turnAbort.signal);
      return res.allow && !turnAbort.signal.aborted;
    };

    /** Every approval is a single decision: "accept" or "decline", never "acceptForSession". */
    const approve = async (method: string, p: Record<string, unknown>): Promise<"accept" | "decline"> => {
      const itemId = String(p.itemId ?? "");
      if (method === "item/commandExecution/requestApproval") {
        const known = items.get(itemId);
        const command = typeof p.command === "string" ? p.command : (known?.command ?? "");
        const cwd = typeof p.cwd === "string" ? p.cwd : (known?.cwd ?? opts.cwd);
        const toolUseId = typeof p.approvalId === "string" ? `${itemId}:${p.approvalId}` : itemId;
        return (await gate({ toolUseId, toolName: "Bash", input: { command, cwd } })) ? "accept" : "decline";
      }
      // A patch may touch several files; each path goes through the gate and every one must pass.
      const paths = items.get(itemId)?.changes?.map((c) => c.path) ?? [];
      if (paths.length === 0) paths.push(typeof p.grantRoot === "string" ? p.grantRoot : "");
      for (const [i, file_path] of paths.entries()) {
        const toolUseId = i === 0 ? itemId : `${itemId}#${i}`;
        if (!(await gate({ toolUseId, toolName: "Edit", input: { file_path } }))) return "decline";
      }
      return "accept";
    };

    const askUser = async (p: Record<string, unknown>) => {
      const qs = (p.questions ?? []) as {
        id: string;
        header?: string;
        question: string;
        options?: { label: string; description?: string }[] | null;
      }[];
      const questions: Question[] = qs.map((q) => ({
        question: q.question,
        ...(q.header ? { header: q.header } : {}),
        options: q.options ?? [],
      }));
      opts.onEvent({ type: "state", state: "waiting_input" });
      const got = await opts.askUser(
        { sid: opts.sid, questionId: String(p.itemId ?? ""), questions },
        turnAbort.signal,
      );
      opts.onEvent({ type: "state", state: "running" });
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of qs) {
        const a = got[q.id] ?? got[q.question];
        if (a !== undefined) answers[q.id] = { answers: Array.isArray(a) ? a : [a] };
      }
      return { answers };
    };

    const onServerRequest = (m: Msg & { id: Id; method: string }) => {
      const p = m.params ?? {};
      const reply = (work: Promise<unknown>) =>
        work.then(
          (result) => send({ id: m.id, result }),
          (err: unknown) => send({ id: m.id, error: { code: -32000, message: String(err) } }),
        );
      if (m.method === "item/commandExecution/requestApproval" || m.method === "item/fileChange/requestApproval") {
        // A gate failure is a denial, never an approval.
        void reply(
          approve(m.method, p).then(
            (decision) => ({ decision }),
            () => ({ decision: "decline" }),
          ),
        );
        return;
      }
      if (m.method === "item/tool/requestUserInput") {
        void reply(askUser(p));
        return;
      }
      // Permission widening, MCP elicitation, dynamic tools, token refresh: not offered (fail closed).
      send({ id: m.id, error: { code: -32601, message: `chalito does not handle ${m.method}` } });
    };

    const onNotification = (method: string, p: Record<string, unknown>) => {
      switch (method) {
        case "turn/started": {
          const id = (p.turn as { id?: string } | undefined)?.id;
          if (id) turnId = id;
          return;
        }
        case "item/agentMessage/delta": {
          const id = String(p.itemId);
          deltas.set(id, (deltas.get(id) ?? "") + String(p.delta ?? ""));
          return;
        }
        case "item/started": {
          const item = p.item as Item;
          items.set(item.id, item);
          const tool = toolOf(item);
          if (tool) opts.onEvent({ type: "tool_started", toolUseId: item.id, ...tool });
          return;
        }
        case "item/completed": {
          const item = p.item as Item;
          items.delete(item.id);
          if (item.type === "agentMessage") return flushText(item.id, item.text);
          if (toolOf(item))
            opts.onEvent({ type: "tool_finished", toolUseId: item.id, ok: item.status === "completed" });
          return;
        }
        case "thread/tokenUsage/updated": {
          const last = (p.tokenUsage as { last?: Record<string, number> } | undefined)?.last ?? {};
          const cached = last.cachedInputTokens ?? 0;
          opts.onEvent({
            type: "usage",
            tokIn: Math.max(0, (last.inputTokens ?? 0) - cached),
            tokOut: last.outputTokens ?? 0,
            tokCacheRead: cached,
            tokCacheWrite: last.cacheWriteInputTokens ?? 0,
          });
          return;
        }
        case "error": {
          if (p.willRetry) return;
          const err = (p.error ?? {}) as { message?: string; codexErrorInfo?: unknown };
          opts.onEvent({ type: "error", code: errorCode(err.codexErrorInfo), message: err.message });
          return;
        }
        case "turn/completed": {
          const turn = (p.turn ?? {}) as { status?: string; error?: { message?: string; codexErrorInfo?: unknown } };
          for (const id of [...deltas.keys()]) flushText(id);
          turnId = null;
          turnAbort.abort();
          if (turn.status === "completed") opts.onEvent({ type: "state", state: "idle" });
          else if (turn.status === "interrupted") {
            if (!interrupted) opts.onEvent({ type: "state", state: "interrupted" });
          } else {
            if (turn.error) {
              opts.onEvent({ type: "error", code: errorCode(turn.error.codexErrorInfo), message: turn.error.message });
            }
            opts.onEvent({ type: "state", state: "failed" });
          }
          const next = queue.shift();
          if (next && !closed) {
            opts.onEvent({ type: "state", state: "running" });
            startTurn(next.text, next.origin);
          }
          return;
        }
      }
    };

    const reader = (async () => {
      for await (const line of t.lines) {
        if (!line.trim()) continue;
        let m: Msg;
        try {
          m = JSON.parse(line) as Msg;
        } catch {
          continue;
        }
        if (m.method !== undefined && m.id !== undefined) onServerRequest(m as Msg & { id: Id; method: string });
        else if (m.method !== undefined) onNotification(m.method, m.params ?? {});
        else if (m.id !== undefined) {
          const w = pending.get(m.id);
          pending.delete(m.id);
          if (m.error) w?.reject(new Error(m.error.message));
          else w?.resolve(m.result);
        }
      }
      for (const w of pending.values()) w.reject(new Error("codex app-server exited"));
      pending.clear();
    })();

    const done = (async () => {
      await reader;
      turnAbort.abort();
      if (startFailed) return;
      if (closed) opts.onEvent({ type: "state", state: "completed" });
      else {
        opts.onEvent({ type: "error", code: "adapter_crash", message: "codex app-server exited" });
        opts.onEvent({ type: "state", state: "failed" });
      }
    })();

    try {
      const init = await request<{ userAgent?: string }>("initialize", {
        clientInfo: { name: "chalito", title: "Chalito", version: this.config.clientVersion ?? "0.0.0" },
        capabilities: null,
      });
      checkCodexVersion(init.userAgent ?? "", this.config.versions);
      send({ method: "initialized" });
      if (!this.config.chatgptPlan) {
        await request("account/login/start", { type: "apiKey", apiKey: this.config.apiKey });
      }
      // No cwd here (see APPROVAL_POLICY): app-server uses the process cwd.
      const threadParams = {
        approvalPolicy: APPROVAL_POLICY,
        sandbox: sandboxModeFor(mode),
        ...(this.config.model ? { model: this.config.model } : {}),
      };
      const r = await request<{ thread: { id: string } }>(
        opts.resume ? "thread/resume" : "thread/start",
        opts.resume ? { threadId: opts.resume, ...threadParams } : threadParams,
      );
      threadId = r.thread.id;
      // MCP tool calls bypass the command/patch approvals and can't be masked by config (see
      // HARDENING_OVERRIDES). Chalito's CODEX_HOME defines none, so any server here comes from
      // system, admin or cloud config, or a plugin. Residual: Codex has already started stdio
      // servers for the thread by the time we can list them.
      const mcp = await request<{ data?: { name: string }[] }>("mcpServerStatus/list", {
        threadId,
        detail: "toolsAndAuthOnly",
      });
      const servers = (mcp.data ?? []).map((s) => s.name);
      if (servers.length > 0) {
        throw Object.assign(
          new Error(
            `Codex has MCP servers configured outside Chalito (${servers.join(", ")}). Their tool calls ` +
              "skip Chalito's approvals, so Chalito won't run Codex with them. Remove them from the " +
              "system or managed Codex config.",
          ),
          { code: "mcp_not_allowed" },
        );
      }
    } catch (err) {
      closed = startFailed = true;
      t.close();
      await done;
      const message = err instanceof Error ? err.message : String(err);
      const known = (err as { code?: string }).code;
      throw Object.assign(new Error(`codex app-server: ${message}`), {
        code: known ?? (/auth|api key|401|unauthorized/i.test(message) ? "auth_required" : "adapter_crash"),
      });
    }

    opts.onEvent({ type: "started", providerSessionId: threadId });
    opts.onEvent({ type: "state", state: "running" });
    startTurn(opts.prompt, opts.origin);

    return {
      prompt: (text, turnOrigin) => {
        if (closed) return;
        if (turnId !== null) {
          queue.push({ text, origin: turnOrigin });
          return;
        }
        opts.onEvent({ type: "state", state: "running" });
        startTurn(text, turnOrigin);
      },
      interrupt: async () => {
        interrupted = true;
        turnAbort.abort();
        const id = turnId === "" ? await turnStart : turnId;
        if (id) await request("turn/interrupt", { threadId, turnId: id }).catch(() => undefined);
        opts.onEvent({ type: "state", state: "interrupted" });
      },
      setPermissionMode: async (next) => {
        // Applied as the per-turn sandboxPolicy on the next turn/start.
        mode = next;
      },
      close: () => {
        if (closed) return;
        closed = true;
        queue.length = 0;
        turnAbort.abort();
        t.close();
      },
      done,
    };
  }
}
