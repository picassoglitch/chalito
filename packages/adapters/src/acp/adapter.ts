import { spawn as nodeSpawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type PermissionOption,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { AdapterKind, Origin } from "@chalito/protocol";
import type { AdapterEvent, SessionAdapter, SessionHandle, SessionStartOptions, ToolCall } from "../core.js";
import { askModeOf, commandAllowed, modeAllowed, slashCommand, unsafeToggle } from "./policy.js";
import { type AcpConfig, type AcpKind, type AcpProfile, builtinAcpRecipe, profileFor } from "./profiles.js";
import type { AcpRecipe } from "./recipe.js";

/**
 * Generic ACP client (Agent Client Protocol v1, JSON-RPC 2.0 over ndjson on stdio) on the
 * official @agentclientprotocol/sdk. It speaks initialize, authenticate, session/new|load|resume,
 * session/prompt, session/update, session/request_permission and session/cancel. The agent
 * owns policy: every permission request goes through the gate as a Chalito tool call, and the
 * client offers no fs or terminal capability, so the agent can only act through its own tools,
 * which ask.
 */

/** One agent process. Injected in tests; defaults to spawning the pinned CLI. */
export interface AcpTransport {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  /** Closes stdin, then stops the process if it doesn't exit on its own. */
  close(): void;
}
export type AcpSpawn = (
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  cwd: string,
) => AcpTransport;

export interface AcpAdapterConfig extends AcpConfig {
  /** Injected in tests; defaults to spawnAcp. */
  spawn?: AcpSpawn;
  /** initialize + authenticate + session/new must finish within this (default 60 s). */
  startTimeoutMs?: number;
}

/** After stdin closes, how long the agent gets to exit before SIGTERM. */
const EXIT_GRACE_MS = 3000;

export const spawnAcp: AcpSpawn = (command, args, env, cwd) => {
  const child = nodeSpawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.on("error", () => undefined);
  const stdout = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  child.on("error", () => child.stdout.destroy());
  return {
    stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    stdout,
    close: () => {
      child.stdin.end();
      if (child.exitCode !== null || child.signalCode !== null) return;
      const timer = setTimeout(() => child.kill("SIGTERM"), EXIT_GRACE_MS);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    },
  };
};

type ErrorCode = Extract<AdapterEvent, { type: "error" }>["code"];
const errorCode = (message: string): ErrorCode => {
  if (/auth|api key|unauthori[sz]ed|401|sign.?in|log.?in/i.test(message)) return "auth_required";
  if (/quota|exhausted|credits|usage limit|billing/i.test(message)) return "quota_exhausted";
  if (/rate.?limit|429|too many requests/i.test(message)) return "rate_limited";
  return "internal";
};
const messageOf = (err: unknown) => {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * The Chalito tool calls (names and inputs the policy classifier knows) a permission request
 * stands for. Several locations (a move, a multi-file edit) give one call per path, and every
 * one must pass. Anything unrecognised keeps an `acp:` name, which the classifier treats as
 * HIGH (step-up approval).
 */
export const toolCallsFor = (
  t: ToolCallUpdate,
  cwd: string,
): { toolName: string; input: Record<string, unknown> }[] => {
  const raw = record(t.rawInput);
  const paths = [
    ...(t.locations ?? []).map((l) => l.path),
    ...[raw.file_path, raw.path, raw.absolute_path, raw.destination].map(str),
  ].filter((p): p is string => !!p);
  const unique = [...new Set(paths)];
  const label = str(t.name) ?? str(t.title) ?? t.toolCallId;
  switch (t.kind) {
    case "execute":
      return [{ toolName: "Bash", input: { command: str(raw.command) ?? str(raw.cmd) ?? label, cwd } }];
    case "edit":
    case "delete":
    case "move":
      // A delete or move changes files like an edit does; an edit without a path is HIGH.
      return unique.length > 0
        ? unique.map((file_path) => ({ toolName: "Edit", input: { file_path } }))
        : [{ toolName: "Edit", input: {} }];
    case "read":
      return (unique.length > 0 ? unique : [cwd]).map((file_path) => ({ toolName: "Read", input: { file_path } }));
    case "search":
      if (str(raw.query) && !str(raw.pattern)) return [{ toolName: "WebSearch", input: { query: str(raw.query) } }];
      return [{ toolName: "Grep", input: { path: unique[0] ?? cwd, ...(str(raw.glob) ? { glob: raw.glob } : {}) } }];
    case "fetch": {
      const url = str(raw.url) ?? str(raw.prompt)?.match(/https?:\/\/\S+/)?.[0];
      return url
        ? [{ toolName: "WebFetch", input: { url } }]
        : [{ toolName: "WebSearch", input: { query: str(raw.query) } }];
    }
    case "think":
      return [{ toolName: "TodoWrite", input: {} }];
    default:
      return [{ toolName: `acp:${label}`, input: raw }];
  }
};

/** A select option's values, flattening groups. */
const selectValues = (o: SessionConfigOption): { id: string; name: string }[] => {
  if (o.type !== "select") return [];
  return o.options.flatMap((x) =>
    "group" in x ? x.options.map((v) => ({ id: v.value, name: v.name })) : [{ id: x.value, name: x.name }],
  );
};
const isModeOption = (o: SessionConfigOption) => o.type === "select" && (o.category === "mode" || o.id === "mode");

/** How many times a session may be put back in its ask mode before Chalito gives up and stops it. */
const MAX_MODE_RESTORES = 3;

/**
 * Any ACP agent, from its recipe (`driver.acp` + `apiKey.env`). `grok` and `gemini` keep their
 * own `AdapterKind`; every other recipe runs as kind "acp" and is told apart by `appId`.
 */
export class AcpAdapter implements SessionAdapter {
  readonly kind: AdapterKind;
  /** The recipe id. */
  readonly appId: string;
  readonly #profile: AcpProfile;

  constructor(
    recipe: AcpRecipe | AcpKind,
    private readonly config: AcpAdapterConfig,
  ) {
    const r = typeof recipe === "string" ? builtinAcpRecipe(recipe) : recipe;
    this.#profile = profileFor(r);
    this.appId = r.id;
    this.kind = r.id === "grok" || r.id === "gemini" ? r.id : "acp";
  }

  async start(opts: SessionStartOptions): Promise<SessionHandle> {
    const profile = this.#profile;
    const launch = profile.launch(this.config, opts.permissionMode);
    const t = (this.config.spawn ?? spawnAcp)(launch.command, launch.args, launch.env, opts.cwd);

    let origin: Origin = opts.origin;
    let sessionId = "";
    /** Replayed history while session/load runs: not new output. */
    let loading = false;
    let turn: Promise<void> | null = null;
    let turnAbort = new AbortController();
    let interrupted = false;
    let closed = false;
    let started = false;
    let text = "";
    const queue: { text: string; origin: Origin }[] = [];
    const tools = new Map<string, ToolCallUpdate & { started?: boolean }>();
    const commands = new Set<string>();
    /** The ask mode the session is held in (session/set_mode), when the agent has modes. */
    let askMode: string | null = null;
    const modeNames = new Map<string, string>();
    let restores = 0;

    const flushText = () => {
      if (text) opts.onEvent({ type: "assistant_text", text });
      text = "";
    };

    const gate = async (call: Omit<ToolCall, "sid" | "origin">, signal: AbortSignal): Promise<boolean> => {
      const res = await opts.gate({ sid: opts.sid, origin, ...call }, signal);
      return res.allow && !signal.aborted;
    };

    /** A single decision per request: never an "always" option, which would skip later prompts. */
    const pick = (options: PermissionOption[], allow: boolean): RequestPermissionResponse => {
      const o = allow
        ? options.find((x) => x.kind === "allow_once")
        : (options.find((x) => x.kind === "reject_once") ?? options.find((x) => x.kind === "reject_always"));
      return o ? { outcome: { outcome: "selected", optionId: o.optionId } } : { outcome: { outcome: "cancelled" } };
    };

    const requestPermission = async (p: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
      const signal = turnAbort.signal;
      if (p.sessionId !== sessionId || signal.aborted || closed) return { outcome: { outcome: "cancelled" } };
      const known = tools.get(p.toolCall.toolCallId);
      const merged: ToolCallUpdate = { ...known, toolCallId: p.toolCall.toolCallId };
      for (const [k, v] of Object.entries(p.toolCall))
        if (v !== undefined && v !== null) Object.assign(merged, { [k]: v });
      const calls = toolCallsFor(merged, opts.cwd);
      let allow = true;
      try {
        for (const [i, c] of calls.entries()) {
          const toolUseId = i === 0 ? p.toolCall.toolCallId : `${p.toolCall.toolCallId}#${i}`;
          if (!(await gate({ toolUseId, ...c }, signal))) {
            allow = false;
            break;
          }
        }
      } catch {
        // A gate failure is a denial, never an approval.
        allow = false;
      }
      if (signal.aborted || closed) return { outcome: { outcome: "cancelled" } };
      return pick(p.options, allow);
    };

    const onUpdate = (n: SessionNotification) => {
      if (loading || n.sessionId !== sessionId) return;
      const u = n.update;
      switch (u.sessionUpdate) {
        case "agent_message_chunk":
          if (u.content.type === "text") text += u.content.text;
          return;
        case "tool_call": {
          flushText();
          const entry = { ...u, started: true };
          tools.set(u.toolCallId, entry);
          const [first] = toolCallsFor(u, opts.cwd);
          opts.onEvent({ type: "tool_started", toolUseId: u.toolCallId, ...first! });
          if (u.status === "completed" || u.status === "failed") {
            tools.delete(u.toolCallId);
            opts.onEvent({ type: "tool_finished", toolUseId: u.toolCallId, ok: u.status === "completed" });
          }
          return;
        }
        case "tool_call_update": {
          const known = tools.get(u.toolCallId);
          if (!known) return;
          for (const [k, v] of Object.entries(u)) if (v !== undefined && v !== null) Object.assign(known, { [k]: v });
          if (u.status === "completed" || u.status === "failed") {
            tools.delete(u.toolCallId);
            opts.onEvent({ type: "tool_finished", toolUseId: u.toolCallId, ok: u.status === "completed" });
          }
          return;
        }
        case "available_commands_update":
          commands.clear();
          for (const c of u.availableCommands) commands.add(c.name);
          return;
        case "current_mode_update":
          if (!modeAllowed(profile, askMode, u.currentModeId, modeNames.get(u.currentModeId)))
            void restoreSafeMode(u.currentModeId);
          return;
        case "config_option_update":
          void holdConfig(u.configOptions).catch((err: unknown) => stopUnsafe(messageOf(err)));
          return;
        default:
          return;
      }
    };

    const client: Client = {
      requestPermission,
      sessionUpdate: (n) => onUpdate(n),
      // No readTextFile/writeTextFile/createTerminal: the SDK answers "method not found", so the
      // agent can't use the client to touch files or run commands outside its own gated tools.
    };
    const conn = new ClientSideConnection(() => client, ndJsonStream(t.stdin, t.stdout));

    /** Ends a session that left (or can't be kept in) a mode where every action asks. */
    const stopUnsafe = (why: string) => {
      if (closed) return;
      opts.onEvent({
        type: "error",
        code: "internal",
        message: `${profile.title}: ${why}, which would skip Chalito's approvals; the session was stopped.`,
      });
      opts.onEvent({ type: "state", state: "failed" });
      handle.close();
    };

    /** The agent switched itself to a mode that might not ask: switch back, or stop. */
    const restoreSafeMode = async (reported: string) => {
      const target = askMode ?? profile.safeMode;
      if (target && restores++ < MAX_MODE_RESTORES) {
        const ok = await conn.setSessionMode({ sessionId, modeId: target }).then(
          () => true,
          () => false,
        );
        if (ok) return;
      }
      stopUnsafe(`it switched to the "${reported}" mode`);
    };

    /** Holds the session in its ask mode at start (session/new, load or resume). */
    const holdModes = async (modes: SessionModeState | null | undefined) => {
      if (!modes) return;
      for (const m of modes.availableModes) modeNames.set(m.id, m.name);
      askMode = askModeOf(profile, modes.availableModes);
      const current = modes.currentModeId;
      if (askMode && current !== askMode) await conn.setSessionMode({ sessionId, modeId: askMode });
      else if (!modeAllowed(profile, askMode, current, modeNames.get(current)))
        throw new Error(`it starts in the "${current}" mode and offers no mode that asks`);
    };

    /**
     * Same for session config options: a "mode" selector is held on its ask value, and an on/off
     * option named like "yolo" or "auto-approve" is switched off. Throws when it can't be.
     */
    const holdConfig = async (options: SessionConfigOption[] | null | undefined, atStart = false) => {
      for (const o of options ?? []) {
        if (isModeOption(o) && o.type === "select") {
          const values = selectValues(o);
          const target = askModeOf(profile, values);
          const name = values.find((v) => v.id === o.currentValue)?.name;
          const ok = modeAllowed(profile, target, o.currentValue, name);
          if (ok && !(atStart && target && o.currentValue !== target)) continue;
          if (!target || restores++ >= MAX_MODE_RESTORES) throw new Error(`its "${o.currentValue}" ${o.name} setting`);
          await conn.setSessionConfigOption({ sessionId, configId: o.id, value: target });
        } else if (o.type === "boolean" && o.currentValue && unsafeToggle(o.id, o.name)) {
          if (restores++ >= MAX_MODE_RESTORES) throw new Error(`its "${o.name}" setting is on`);
          await conn.setSessionConfigOption({ sessionId, configId: o.id, type: "boolean", value: false });
        }
      }
    };

    const usageOf = (r: PromptResponse) => {
      if (!r.usage) return;
      const cached = r.usage.cachedReadTokens ?? 0;
      opts.onEvent({
        type: "usage",
        tokIn: Math.max(0, r.usage.inputTokens - cached),
        tokOut: r.usage.outputTokens,
        tokCacheRead: cached,
        tokCacheWrite: r.usage.cachedWriteTokens ?? 0,
      });
    };

    const next = () => {
      const n = queue.shift();
      if (n && !closed) {
        opts.onEvent({ type: "state", state: "running" });
        startTurn(n.text, n.origin);
      }
    };

    const startTurn = (prompt: string, turnOrigin: Origin) => {
      origin = turnOrigin;
      interrupted = false;
      turnAbort = new AbortController();
      const cmd = slashCommand(prompt);
      if (cmd && !commandAllowed(cmd, profile.allowedCommands, commands)) {
        opts.onEvent({
          type: "error",
          code: "internal",
          message: `Chalito doesn't run ${profile.title}'s /${cmd} command from a session.`,
        });
        opts.onEvent({ type: "state", state: "idle" });
        turn = null;
        next();
        return;
      }
      turn = conn.prompt({ sessionId, prompt: [{ type: "text", text: prompt }] }).then(
        (r) => {
          flushText();
          usageOf(r);
          if (r.stopReason === "cancelled") {
            if (!interrupted && !closed) opts.onEvent({ type: "state", state: "interrupted" });
          } else opts.onEvent({ type: "state", state: "idle" });
        },
        (err: unknown) => {
          flushText();
          if (closed || interrupted) return;
          const message = messageOf(err);
          opts.onEvent({ type: "error", code: errorCode(message), message });
          opts.onEvent({ type: "state", state: "failed" });
        },
      );
      void turn.finally(() => {
        turn = null;
        turnAbort.abort();
        next();
      });
    };

    const done = (async () => {
      await conn.closed.catch(() => undefined);
      turnAbort.abort();
      if (!started) return;
      if (closed) opts.onEvent({ type: "state", state: "completed" });
      else {
        closed = true;
        opts.onEvent({ type: "error", code: "adapter_crash", message: `${profile.title} exited` });
        opts.onEvent({ type: "state", state: "failed" });
      }
    })();

    const handle: SessionHandle = {
      prompt: (prompt, turnOrigin) => {
        if (closed) return;
        if (turn) {
          queue.push({ text: prompt, origin: turnOrigin });
          return;
        }
        opts.onEvent({ type: "state", state: "running" });
        startTurn(prompt, turnOrigin);
      },
      interrupt: async () => {
        interrupted = true;
        queue.length = 0;
        // Pending permission requests answer "cancelled" once the turn's signal aborts.
        turnAbort.abort();
        if (turn && sessionId) await conn.cancel({ sessionId }).catch(() => undefined);
        opts.onEvent({ type: "state", state: "interrupted" });
      },
      // The gate applies the permission mode to every call (plan denies anything but reads). The
      // OS sandbox (Grok) was chosen from the mode at launch and stays for the process.
      setPermissionMode: async () => undefined,
      close: () => {
        if (closed) return;
        closed = true;
        queue.length = 0;
        turnAbort.abort();
        t.close();
      },
      done,
    };

    const timeoutMs = this.config.startTimeoutMs ?? 60_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${profile.title} didn't start within ${Math.round(timeoutMs / 1000)} s`)),
        timeoutMs,
      );
    });
    const closedEarly = conn.closed.then(() => {
      throw new Error(`${profile.title} exited during startup`);
    });

    try {
      const setup = async () => {
        const init = await conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "chalito", title: "Chalito", version: this.config.clientVersion ?? "0.0.0" },
        });
        if (init.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error(`${profile.title} speaks ACP v${init.protocolVersion}; Chalito speaks v${PROTOCOL_VERSION}`);
        }
        const auth = profile.authenticate(this.config, init.authMethods ?? []);
        if (auth) {
          try {
            await conn.authenticate(auth);
          } catch (err) {
            throw Object.assign(new Error(`authentication failed: ${messageOf(err)}`), { code: "auth_required" });
          }
        }
        const caps = init.agentCapabilities ?? {};
        const base = { cwd: opts.cwd, mcpServers: [] };
        let state: { modes?: SessionModeState | null; configOptions?: SessionConfigOption[] | null };
        if (opts.resume && caps.sessionCapabilities?.resume) {
          sessionId = opts.resume;
          state = (await conn.resumeSession({ sessionId: opts.resume, ...base })) ?? {};
        } else if (opts.resume && caps.loadSession) {
          sessionId = opts.resume;
          loading = true;
          try {
            state = (await conn.loadSession({ sessionId: opts.resume, ...base })) ?? {};
          } finally {
            loading = false;
          }
        } else {
          const r = await conn.newSession(base).catch((err: unknown) => {
            const message = messageOf(err);
            if (errorCode(message) === "auth_required") {
              throw Object.assign(new Error(`${message}. ${profile.signInHint}`), { code: "auth_required" });
            }
            throw err;
          });
          sessionId = r.sessionId;
          state = r;
        }
        // Where the agent has modes, every session runs in the one that asks (D-064).
        await holdModes(state.modes);
        await holdConfig(state.configOptions, true);
      };
      await Promise.race([setup(), timeout, closedEarly]);
    } catch (err) {
      closed = true;
      t.close();
      const message = messageOf(err);
      const known = (err as { code?: unknown }).code;
      throw Object.assign(new Error(`${profile.title}: ${message}`), {
        code:
          typeof known === "string"
            ? known
            : errorCode(message) === "auth_required"
              ? "auth_required"
              : "adapter_crash",
      });
    } finally {
      clearTimeout(timer);
      closedEarly.catch(() => undefined);
    }

    started = true;
    opts.onEvent({ type: "started", providerSessionId: sessionId });
    opts.onEvent({ type: "state", state: "running" });
    startTurn(opts.prompt, opts.origin);
    return handle;
  }
}
