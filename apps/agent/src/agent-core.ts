import { createHash, randomUUID } from "node:crypto";
import {
  openJson,
  revokeBundleChallenge,
  signEnvelope,
  revokeBundleId,
  stepUpBodyHash,
  stepUpChallenge,
  verifyWebAuthnAssertion,
  type BoxKeyPair,
  type NonceStore,
  type SigningKeyPair,
  type TrustedClientList,
} from "@chalito/crypto";
import type { AdapterEvent, SessionAdapter, SessionHandle, ToolCall, ToolGate } from "@chalito/adapters";
import {
  AgentEvent,
  CommandEnvelope,
  CommandPayload,
  Id,
  TerminalData,
  type CommandAcceptedMeta,
  type CommandRejectedMeta,
  isSignedOrigin,
  type AdapterKind,
  type CommandBody,
  type Origin,
  type RemotePermissionMode,
  type RiskTier,
  type SealedEnvelope,
  type SessionState,
  ScreenSignal,
  approvalSummary,
  APP_ADAPTER,
  PROVIDER_APP,
  isLegacyApp,
  type CoordRemoteResult,
} from "@chalito/protocol";
import { SESSIONS_DEFAULTS, type SessionsConfig } from "@chalito/config";
import { outsideTaskSid, sealJson } from "@chalito/crypto";
import { ApprovalManager, type ApprovalOutcome } from "./approvals.js";
import { CallLinePublisher } from "./call-lines.js";
import { CardBuilder } from "./card.js";
import type { LocalEvent, LocalTap } from "./code/events.js";
import { Coordinator, nodeGit, type CoordHost, type GitRun } from "./coord/coordinator.js";
import { coordAnswer } from "./coord/gate.js";
import { CoordRules, type CoordTombstones } from "./coord/rules.js";
import { coordinatorCeiling } from "./coord/toggle.js";
import { publicReason } from "./command-result.js";
import type { ComputerApprovalOutcome, ComputerControl } from "./computer/control.js";
import { COMPUTER_TOOL_PREFIX, ToolArgs, isToolName } from "./computer/tools.js";
import type { DevMode } from "./devmode.js";
import { DeltaThrottle } from "./live/deltas.js";
import { coordResultOf, type LinkHost, type LinkManager } from "./links/manager.js";
import { partsAsData } from "./links/frame.js";
import { Transfers, repoRemote, transferFrame } from "./links/transfer.js";
import type { LinkTools } from "./links/tool-server.js";
import { LINKS_TOOL_PREFIX, LinkToolArgs, isLinkToolName } from "./links/tools.js";
import type { ScreenManager } from "./screen/manager.js";
import {
  PERMISSION_RANK,
  SANDBOX_RANK,
  DEVMODE_OFF,
  applyRemoteTighten,
  classifyToolCall,
  decide,
  originAllowed,
  exposedFor,
  policyHash,
  presetPolicy,
  type ClassifyContext,
  type Policy,
} from "./policy/index.js";
import { redact, redactDeep, type Logger } from "./redact.js";
import { Sealer } from "./sealing.js";
import { pruneRecords, type SessionRecord, type SessionRegistry } from "./session-registry.js";
import { isRevokedRefusal, type AgentStore } from "./store.js";

/** Holds the local policy; `set` persists, re-hashes and reports `policyHash`. */

/** What became of a command; `sid` when it started or targets a session. */
export interface CommandResult {
  ok: boolean;
  reason?: string;
  sid?: string;
  /** Accepted, but too frequent to audit one by one (terminal input and resizes). */
  quiet?: boolean;
}
export interface PolicyHolder {
  get(): Policy;
  set(p: Policy, via: "local" | "remote_tighten" | "preset_accepted"): Promise<void>;
}

/** Remote terminals (terminal/control.ts); absent = every terminal.* command is refused. */
export interface TerminalCommands {
  has(tid: string): boolean;
  open(
    input: { appId: string; workspaceLabel: string; cols: number; rows: number },
    origin: Origin,
  ): Promise<{ ok: true; tid?: string } | { ok: false; reason: string }>;
  input(tid: string, data: string, origin: Origin): { ok: true } | { ok: false; reason: string };
  resize(tid: string, cols: number, rows: number, origin: Origin): { ok: true } | { ok: false; reason: string };
  close(tid: string, origin: Origin): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/**
 * The connect engine (apps/manager.ts AppManager); absent in setups that don't manage apps. The
 * provider.* commands are aliases of app.* for the four former providers.
 */
export interface AppCommands {
  connectKey(appId: string, key: unknown): Promise<{ ok: boolean; reason?: string }>;
  signin(appId: string): Promise<{ ok: boolean; reason?: string }>;
  disconnect(appId: string): Promise<{ ok: boolean; reason?: string }>;
  requestInstall(appId: string): Promise<{ ok: boolean; reason?: string }>;
  launch(appId: string): Promise<{ ok: boolean; reason?: string }>;
  report(appId?: string): Promise<void>;
  /**
   * Whether `session.start {appId}` may run this app here: known, a custom recipe enabled on
   * this computer, connected. The legacy four are gated by `policy.adapters` instead.
   */
  sessionReady?(appId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface AgentCoreDeps {
  store: AgentStore;
  /** Withdrawn remembered rules this device refuses (ADR 0025 §6); in memory when absent. */
  coordTombstones?: CoordTombstones;
  /** git for the coordinator (tests pass their own); hooks off by default. */
  git?: GitRun;
  adapters: Partial<Record<AdapterKind, SessionAdapter>>;
  /**
   * Engine: session adapters for apps beyond the four built-in ones, by app id, from the drivers
   * registered with drivers/registry.ts (e.g. any recipe with driver.acp).
   */
  appAdapters?: Readonly<Record<string, SessionAdapter>>;
  apps?: AppCommands;
  policy: PolicyHolder;
  devMode: DevMode;
  trust: () => TrustedClientList;
  saveTrust: () => Promise<void>;
  nonces: NonceStore;
  owner: string;
  self: { deviceId: string; pubBox: string; box: BoxKeyPair; sign: SigningKeyPair };
  home: string;
  locale: () => "es" | "en";
  now: () => number;
  log: Logger;
  setTimer?: (fn: () => void, ms: number) => { clear(): void };
  /** Host facts for the classifier's hard floor (agent binaries, service files, the session's PATH dirs). */
  classifyExtras?: () => {
    agentBinaries: string[];
    protectedPaths: string[];
    pathDirs: string[];
    /** APPDATA / LOCALAPPDATA for the classifier's Windows folder-redirection checks. */
    env?: Record<string, string | undefined>;
  };
  /** Computer control (computer/control.ts); absent = never attached. */
  computer?: ComputerControl;
  /** Remote terminal (terminal/control.ts); absent = terminal.* refused. */
  terminal?: TerminalCommands;
  /** Remote screen (screen/manager.ts); absent = `screen.*` commands are refused. */
  screen?: ScreenManager;
  /** Build flags (features.ts). Absent = off: `screen.*` and `terminal.*` are refused and audited. */
  remote?: { screen?: boolean; terminal?: boolean };
  /** M16 A: idle-close, live cap and delta flushing (packages/config sessions.yaml). */
  sessionsConfig?: Pick<SessionsConfig, "session" | "live">;
  /** M16 A: where sessions are remembered for resume (~/.chalito/sessions.json); absent = memory only. */
  registry?: SessionRegistry;
  /** Agent-to-agent links (links/manager.ts, ADR 0022 §3); absent = `link.*` commands are refused. */
  links?: LinkManager;
  /** The session link tools (links/tool-server.ts, M16 F); absent = never attached. */
  linkTools?: LinkTools;
}

interface Session {
  sid: string;
  adapter: AdapterKind;
  /** The recipe id this session runs (engine); the four built-in adapters map to theirs. */
  appId?: string;
  cwd: string;
  label: string;
  workspaceLabel: string;
  startedBy: Origin;
  permissionMode: RemotePermissionMode;
  handle: SessionHandle;
  card: CardBuilder;
  seq: number;
  providerSessionId?: string;
  questions: Map<string, (answers: Record<string, string | string[]>) => void>;
  /** Set by a relayed (mcp:/call:) answer: the rest of the current turn is gated at this trust. Cleared when the turn ends. */
  turnOriginFloor?: Origin;
  // ---- M16 A lifecycle ----
  state: SessionState;
  lastActiveAt: number;
  /** The origin of the turn running (or last run): prompts queued into a running turn lower it. */
  turnOrigin: Origin;
  idleTimer?: { clear(): void };
  /** Being idle-closed or shut down: what the adapter reports from now on is ignored. */
  closing?: boolean;
  /**
   * Coordinator mode (ADR 0025 §6): this session is a helper of the owner's plan. Chalito answers
   * its prompts within this computer's ceiling and the owner's remembered rules; it never gets
   * computer control; a prompt that times out is asked again while the plan runs.
   */
  coord?: SessionCoord;
  /** The assistant message being streamed (`message.assistant.delta`), until its final text. */
  draft?: { mid: string; n: number; throttle: DeltaThrottle };
  /** Deltas are sealed and sent in order. */
  liveChain: Promise<void>;
}

/** A coordinator helper's place in its plan (ADR 0025 §6). */
export interface SessionCoord {
  planId: string;
  taskId: string;
  /** `coord/<plan>/`: the only branches the helper may push on its own. */
  branchPrefix: string;
  /**
   * Whether the plan is running (or integrating). False once it stopped, failed or merged: then
   * nothing is answered for the owner and a timed-out prompt is a no.
   */
  active: () => boolean;
}

/** A session with no process (idle-closed, ended, or from before a restart) that can be resumed. */
interface Dormant {
  record: SessionRecord;
  /** Kept while this process runs, so a resumed session keeps its card. */
  card?: CardBuilder;
}

/** States in which a session is doing something or waiting on the person: never idle-closed. */
const BUSY: ReadonlySet<SessionState> = new Set<SessionState>([
  "starting",
  "running",
  "waiting_approval",
  "waiting_input",
]);
/** After a crash, events may have used seq numbers past the last save. */
const RESTART_SEQ_MARGIN = 1000;
/** ADR 0031 §6a: live sessions started from code.sock (any same-user process can ask for them). */
export const LOCAL_CLI_LIVE_MAX = 2;

const originTrust = (o: Origin) => (o === "local" ? 2 : isSignedOrigin(o) ? 1 : 0);
const lowerTrust = (a: Origin, b: Origin): Origin => (originTrust(b) < originTrust(a) ? b : a);

const REMOTE_ENABLE_ATTEMPT =
  /devmode\.(on|enable|toggleOn)|computer|remoteTerminal|rawShell|(terminal|shell)\.(enable|on)|screen\.(enable|on|grant|allow)|remote_?(view|control)|app_?control|policy\.(loosen|set)|trust\.add|bypass|dontAsk|\bauto\b|dangerous|danger-full-access|apps?\.(custom|enable)|recipe\.(enable|add)|link\.create:handoff/i;

/**
 * The device agent's brain (ADR 0008): verifies commands against the local trusted list,
 * runs sessions through adapters, gates every tool call with local policy + signed
 * approvals, and reports typed, sealed events.
 */
/** Adapters built on ACP (packages/adapters/src/acp): their tool calls are named from the agent's report. */
const ACP_KINDS: ReadonlySet<AdapterKind> = new Set<AdapterKind>(["acp", "grok", "gemini"]);

/** Outside hand-off tasks (M16 F): a link's default rate when only the cloud names it, and pending-tap caps. */
const OUTSIDE_RATE_PER_HOUR = 10;
const OUTSIDE_PENDING_PER_ORIGIN = 3;
const OUTSIDE_PENDING_PER_LINK = 5;

interface OutsideTask {
  sid: string;
  origin: Origin;
  key: string;
  appId: string | undefined;
  adapter: AdapterKind | undefined;
  prompt: string;
  workspace: { label: string; path: string };
  permissionMode: RemotePermissionMode;
}

export class AgentCore {
  readonly sessions = new Map<string, Session>();
  /** Outside tasks waiting for the owner's tap, by their session id (M16 F). */
  readonly #outside = new Map<string, { origin: Origin; key: string; abort: AbortController }>();
  /** Outside deliveries in the last hour, per local link id (or `cloud:<id>`). */
  readonly #outsideRate = new Map<string, number[]>();
  /** Sessions without a process that a prompt or `session.resume` reopens (M16 A). */
  readonly #dormant = new Map<string, Dormant>();
  readonly approvals: ApprovalManager;
  readonly callLines: CallLinePublisher;
  readonly sealer: Sealer;
  pendingPreset: "estricto" | "estandar" | "relajado" | null = null;
  /** The owner's remembered answers ("Siempre así"), verified here (ADR 0025 §6). */
  readonly coordRules: CoordRules;
  /** Coordinator mode on this computer (ADR 0025, M17 G2). */
  readonly coordinator: Coordinator;
  /** Adapter events for the coordinator, per session. */
  readonly #observers = new Map<string, (e: AdapterEvent) => void>();
  /** Coordinator helpers by session: their marker and worktree, kept for a revive. */
  readonly #coordOf = new Map<string, { coord: SessionCoord; cwd: string }>();
  /**
   * Helpers whose work is over (task done, plan ended): no longer answered for. Their helper
   * identity stays for the session's whole life (no computer control, their worktree on a revive).
   */
  readonly #coordEnded = new Set<string>();
  /** The coordinator's listener for results of tasks it sent to other computers (G4). */
  #coordResult: ((taskId: string, r: CoordRemoteResult | null) => boolean) | null = null;
  #revoked = false;
  /** ADR 0031 §1: plaintext listeners on this computer (`code.sock`); never stored or sent. */
  readonly #taps = new Set<LocalTap>();
  /** ADR 0031 §4: sessions this computer moves to another one (absent without links). */
  #transfers: Transfers | null = null;
  readonly #git: GitRun;

  constructor(private readonly d: AgentCoreDeps) {
    this.sealer = new Sealer(d.trust, { deviceId: d.self.deviceId, pubBox: d.self.pubBox });
    this.approvals = new ApprovalManager({
      store: d.store,
      trust: d.trust,
      nonces: d.nonces,
      sealer: this.sealer,
      owner: d.owner,
      deviceId: d.self.deviceId,
      signer: d.self.sign,
      now: d.now,
      ttlMs: () => d.policy.get().approvals.ttlSeconds * 1000,
      audit: (e) => this.#audit(e.type, e),
      ...(d.setTimer ? { setTimer: d.setTimer } : {}),
    });
    this.callLines = new CallLinePublisher({
      store: d.store,
      deviceId: d.self.deviceId,
      policyAllows: () => d.policy.get().egress.callLines,
      locale: d.locale,
      now: d.now,
    });
    this.coordRules = new CoordRules({
      list: () => d.store.listCoordRules(),
      listRevocations: () => d.store.listCoordRuleRevocations(),
      ...(d.coordTombstones ? { tombstones: d.coordTombstones } : {}),
      trust: d.trust,
      owner: d.owner,
      now: d.now,
      log: (msg, meta) => d.log.warn(msg, meta),
    });
    this.#git = d.git ?? nodeGit();
    this.coordinator = new Coordinator({
      host: this.#coordHost(),
      git: this.#git,
      now: d.now,
      audit: (type, meta) => this.#audit(type, meta),
      log: (msg, meta) => d.log.warn(msg, meta),
      ...(d.setTimer ? { setTimer: d.setTimer } : {}),
    });
    const host = this.#linkHost();
    d.links?.attach(host);
    d.links?.onResult(({ taskId, result }) => this.#coordResult?.(taskId, coordResultOf(result)) ?? false);
    if (d.links) {
      const transfers = new Transfers({
        links: d.links,
        git: this.#git,
        session: (sid) => {
          const s = this.sessions.get(sid);
          const info = host.session(sid);
          return info
            ? {
                sid,
                cwd: info.cwd,
                ...(info.appId ? { appId: info.appId } : {}),
                state: s?.state,
                permissionMode: info.permissionMode,
              }
            : undefined;
        },
        event: (sid, partial) => host.event(sid, partial),
        seal: (value, aad) => this.sealer.seal(value, aad),
        close: (sid) => {
          const s = this.sessions.get(sid);
          if (s) this.#suspend(s, "transferred");
        },
        audit: (type, meta) => this.#audit(type, meta),
        log: d.log,
        setTimer: (fn, ms) => this.#schedule(fn, ms),
      });
      this.#transfers = transfers;
      this.#taps.add((sid, e) => transfers.record(sid, e));
      d.links.onResult(({ taskId, result }) => transfers.onResult(taskId, result));
    }
  }

  // ---- remote control at the computer (ADR 0031 §1) ------------------------------

  tap(fn: LocalTap): () => void {
    this.#taps.add(fn);
    return () => void this.#taps.delete(fn);
  }

  #local(sid: string, e: LocalEvent): void {
    for (const fn of this.#taps)
      try {
        fn(sid, e);
      } catch (err) {
        this.d.log.warn("code.tap_failed", { error: err instanceof Error ? err.message : "error" });
      }
  }

  /** ADR 0031 §1: a command typed at this computer (panel `local`, terminal `local:cli`), fully checked. */
  async localCommand(
    origin: "local" | "local:cli",
    payload:
      | {
          type: "session.start";
          appId: string;
          workspaceLabel: string;
          prompt: string;
          permissionMode: RemotePermissionMode;
        }
      | { type: "session.prompt"; sid: string; text: string }
      | { type: "session.interrupt"; sid: string }
      | { type: "session.transfer"; sid: string; toDeviceId: string },
  ): Promise<CommandResult> {
    const cid = `loc${randomUUID().replace(/-/g, "")}`;
    const seal = async (text: string) =>
      sealJson(text, { [this.d.self.deviceId]: this.d.self.box.publicKey }, `command:${cid}`);
    const p = CommandPayload.safeParse(
      payload.type === "session.start"
        ? {
            type: "session.start",
            appId: payload.appId,
            workspaceLabel: payload.workspaceLabel,
            permissionMode: payload.permissionMode,
            promptCt: await seal(payload.prompt),
          }
        : payload.type === "session.prompt"
          ? { type: "session.prompt", sid: payload.sid, promptCt: await seal(payload.text) }
          : payload,
    );
    if (!p.success) return { ok: false, reason: "invalid" };
    const r = await this.#localDispatch(cid, p.data, origin);
    // The owner's audit trail: what was typed at this computer and what became of it, with its origin.
    this.#audit(r.ok ? "command.accepted" : "command.rejected", {
      cid,
      origin,
      command: p.data.type,
      ...(r.sid ? { sid: r.sid } : {}),
      ...(r.ok ? {} : { reason: publicReason(r.reason) }),
    });
    return r;
  }

  async #localDispatch(cid: string, p: CommandPayload, origin: "local" | "local:cli"): Promise<CommandResult> {
    if (!originAllowed(this.d.policy.get().origins, origin)) return this.#reject(cid, "origin_disabled");
    // An unsigned start can't pick acceptEdits: it would carry over to the owner's later signed turns.
    if (origin === "local:cli" && p.type === "session.start" && p.permissionMode === "acceptEdits")
      return this.#reject(cid, "permission_mode_above_ceiling");
    try {
      return await this.#dispatch(cid, p, origin);
    } catch (err) {
      this.d.log.error("code.command_failed", { error: err instanceof Error ? err.message : "error" });
      return { ok: false, reason: "internal" };
    }
  }

  // ---- commands ---------------------------------------------------------------

  async handleCommand(id: string, doc: Record<string, unknown>): Promise<CommandResult> {
    let result: CommandResult;
    try {
      result = await this.#handle(id, doc);
    } catch (err) {
      this.d.log.error("command failed", { id, error: err instanceof Error ? err.message : "error" });
      result = { ok: false, reason: "internal" };
    } finally {
      await this.d.store.deleteCommand(id).catch(() => undefined);
    }
    if (!(result.ok && result.quiet)) await this.#publishResult(id, result);
    return result;
  }

  /**
   * One audit row per command for the person's clients (metadata only, CommandAcceptedMeta /
   * CommandRejectedMeta): accepted with the session id where there is one, or rejected with a
   * closed reason. The cid is the command row's id, which the client chose; a malformed one is
   * only logged.
   */
  async #publishResult(id: string, r: CommandResult): Promise<void> {
    if (!Id.safeParse(id).success) return;
    const meta: CommandAcceptedMeta | CommandRejectedMeta = r.ok
      ? { cid: id, ...(r.sid ? { sid: r.sid } : {}) }
      : { cid: id, reason: publicReason(r.reason) };
    await this.d.store
      .audit({
        eid: randomUUID(),
        t: this.d.now(),
        type: r.ok ? "command.accepted" : "command.rejected",
        meta: { ...meta },
        source: "agent",
      })
      .catch((err: unknown) =>
        this.d.log.warn("command.result_publish_failed", { id, error: err instanceof Error ? err.message : "error" }),
      );
  }

  async #handle(id: string, doc: Record<string, unknown>): Promise<CommandResult> {
    const env = doc.env as Record<string, unknown> | undefined;
    const parsed = CommandEnvelope.safeParse(env);
    if (!parsed.success) {
      const body = (env?.body ?? {}) as {
        payload?: { type?: unknown; permissionMode?: unknown; codexSandbox?: unknown; link?: { mode?: unknown } };
        origin?: unknown;
      };
      // A hand-off link is made only on the device (ADR 0022 §3): a remote attempt is reported.
      const linkAttempt =
        body.payload?.type === "link.create" && body.payload.link?.mode !== "share" ? "link.create:handoff" : undefined;
      const attempted = [body.payload?.type, body.payload?.permissionMode, body.payload?.codexSandbox, linkAttempt]
        .filter((x) => typeof x === "string")
        .join(" ");
      if (REMOTE_ENABLE_ATTEMPT.test(attempted)) {
        await this.d.store.publishDeviceEvent({
          v: 1,
          type: "remote_enable.rejected",
          deviceId: this.d.self.deviceId,
          attempted: redact(attempted).slice(0, 64),
          origin:
            typeof body.origin === "string" && /^(local|client:|mcp:|call:|agent:|a2a:)/.test(body.origin)
              ? (body.origin as Origin)
              : "local",
          t: this.d.now(),
        });
        this.#audit("remote_enable.rejected", { id, attempted: redact(attempted).slice(0, 64) });
        return { ok: false, reason: "remote_enable_rejected" };
      }
      this.d.log.warn("command.rejected", { id, reason: "invalid" });
      return { ok: false, reason: "invalid" };
    }

    const envelope = parsed.data;
    let body: CommandBody;
    if ("relayedBy" in envelope) {
      body = envelope.body;
      // Another agent over a link: signed with the key recorded locally for that link.
      if (envelope.relayedBy === "agent-link") {
        if (!this.d.links) return this.#reject(id, "links_disabled");
        const sig = await this.d.links.verifyRelay(envelope);
        if (!sig.ok) return this.#reject(id, sig.reason);
      }
    } else {
      const sig = await this.d.trust().verifySigned(envelope, "chalito.command.v1");
      if (!sig.ok) return this.#reject(id, sig.reason);
      body = envelope.body;
      if (body.origin !== `client:${envelope.signerDeviceId}`) return this.#reject(id, "origin_mismatch");
    }
    if (body.targetDeviceId !== this.d.self.deviceId) return this.#reject(id, "wrong_device");
    if (body.uid !== this.d.owner) return this.#reject(id, "wrong_owner");
    const now = this.d.now();
    if (body.expiresAt <= now || body.issuedAt > now + 60_000) return this.#reject(id, "expired");
    if (!(await this.d.nonces.claim(body.nonce, body.expiresAt, now))) return this.#reject(id, "replayed_nonce");
    if (!originAllowed(this.d.policy.get().origins, body.origin)) return this.#reject(id, "origin_disabled");
    // An outside hand-off task (MCP create_task, A2A SendMessage): the cloud's LinkAuthorizer
    // isn't enough; local policy must expose that agent in that workspace over that path.
    if (
      "relayedBy" in envelope &&
      (envelope.relayedBy === "mcp-gateway" || envelope.relayedBy === "a2a-server") &&
      body.payload.type === "session.start" &&
      !exposedFor(this.d.policy.get(), body.origin, body.payload.appId, body.payload.workspaceLabel)
    ) {
      this.#audit("link.task_not_exposed", { id, origin: body.origin, appId: body.payload.appId ?? null });
      return this.#reject(id, "not_exposed");
    }

    const r = await this.#dispatch(body.cid, body.payload, body.origin, body);
    const sid = (body.payload as { sid?: unknown }).sid;
    return r.ok && !r.sid && typeof sid === "string" ? { ...r, sid } : r;
  }

  async #dispatch(cid: string, p: CommandPayload, origin: Origin, body?: CommandBody): Promise<CommandResult> {
    const policy = this.d.policy.get();
    const open = <T>(ct: SealedEnvelope) => openJson<T>(ct, this.d.self.deviceId, this.d.self.box, `command:${cid}`);
    const aboveCeiling = (mode: RemotePermissionMode) =>
      PERMISSION_RANK[mode] > PERMISSION_RANK[policy.remote.maxPermissionMode];
    const sandboxAboveCeiling = (sandbox: keyof typeof SANDBOX_RANK | undefined) =>
      sandbox !== undefined && SANDBOX_RANK[sandbox] > SANDBOX_RANK[policy.remote.maxCodexSandbox];

    // Remote screen is dormant unless built in (features.ts): refuse every screen.* and say so.
    if (p.type.startsWith("screen.") && !this.d.remote?.screen) {
      this.#audit("remote_screen.refused", { cid, command: p.type, origin });
      return this.#reject(cid, "remote_screen_off");
    }

    // Remote terminal and raw shell are dormant unless built in (features.ts): refuse every terminal.* and say so.
    if (p.type.startsWith("terminal.") && !this.d.remote?.terminal) {
      this.#audit("remote_terminal.refused", { cid, command: p.type, origin });
      return this.#reject(cid, "remote_terminal_off");
    }

    switch (p.type) {
      case "session.start": {
        const ws = policy.workspaces.find((w) => w.label === p.workspaceLabel);
        if (!ws) return this.#reject(cid, "unknown_workspace");
        if (aboveCeiling(p.permissionMode)) return this.#reject(cid, "permission_mode_above_ceiling");
        if (sandboxAboveCeiling(p.codexSandbox)) return this.#reject(cid, "codex_sandbox_above_ceiling");
        const target = await this.#sessionTarget(p.adapter, p.appId);
        if (!target.ok) return this.#reject(cid, target.reason);
        const prompt = await open<string>(p.promptCt);
        // A hand-off task from outside (MCP create_task, A2A SendMessage, M16 F).
        if (origin.startsWith("mcp:") || origin.startsWith("a2a:"))
          return this.#outsideStart(cid, origin, p, ws, target, prompt);
        if (!(await this.#makeRoom(origin))) return this.#reject(cid, "session_limit");
        try {
          const sid = await this.startSession({
            adapter: target.adapter,
            ...(target.appId ? { appId: target.appId } : {}),
            ...(target.appAdapter ? { appAdapter: target.appAdapter } : {}),
            workspace: ws,
            prompt,
            origin,
            permissionMode: p.permissionMode,
          });
          return { ok: true, sid };
        } catch (err) {
          this.d.log.error("session.start_failed", { cid, error: err instanceof Error ? err.message : "error" });
          return this.#reject(cid, "start_failed");
        }
      }
      case "session.prompt": {
        if (this.#transfers?.isMoving(p.sid)) return this.#reject(cid, "session_busy");
        const s = this.sessions.get(p.sid);
        if (!s) {
          if (!this.#dormant.has(p.sid)) return this.#reject(cid, "unknown_session");
          const text = await open<string>(p.promptCt);
          this.#local(p.sid, { type: "user", origin, text });
          return this.#revive(cid, p.sid, this.#withLinkData(p.sid, text, origin), origin);
        }
        const text = await open<string>(p.promptCt);
        this.#local(s.sid, { type: "user", origin, text });
        await this.#event(s, { type: "message.user", origin, ct: await this.sealer.seal({ text }, `event:${s.sid}`) });
        this.#prompt(s, this.#withLinkData(s.sid, text, origin), origin);
        return { ok: true };
      }
      case "session.transfer": {
        // ADR 0031 §4: the owner's own call (phone or panel); a terminal or relayed turn can't move it.
        if (!isSignedOrigin(origin)) return this.#reject(cid, "origin_mismatch");
        if (!this.#transfers) return this.#reject(cid, "links_disabled");
        const r = await this.#transfers.start(p.sid, p.toDeviceId);
        return r.ok ? { ok: true, sid: p.sid } : this.#reject(cid, r.reason);
      }
      case "session.interrupt": {
        const s = this.sessions.get(p.sid);
        if (!s) return this.#dormant.has(p.sid) ? { ok: true } : this.#reject(cid, "unknown_session");
        await s.handle.interrupt();
        return { ok: true };
      }
      case "session.resume": {
        if (this.#transfers?.isMoving(p.sid)) return this.#reject(cid, "session_busy");
        const s = this.sessions.get(p.sid);
        if (!s) {
          // Idle-closed, ended, or from before a restart: reopen it in the provider (M16 A).
          if (!this.#dormant.has(p.sid)) return this.#reject(cid, "unknown_session");
          return this.#revive(
            cid,
            p.sid,
            p.promptCt ? this.#withLinkData(p.sid, await open<string>(p.promptCt), origin) : "",
            origin,
          );
        }
        if (p.promptCt) this.#prompt(s, this.#withLinkData(s.sid, await open<string>(p.promptCt), origin), origin);
        return { ok: true };
      }
      case "session.setPermissionMode": {
        const s = this.sessions.get(p.sid);
        const dormant = s ? undefined : this.#dormant.get(p.sid);
        if (!s && !dormant) return this.#reject(cid, "unknown_session");
        if (aboveCeiling(p.permissionMode)) return this.#reject(cid, "permission_mode_above_ceiling");
        if (sandboxAboveCeiling(p.codexSandbox)) return this.#reject(cid, "codex_sandbox_above_ceiling");
        if (s) {
          await s.handle.setPermissionMode(p.permissionMode);
          s.permissionMode = p.permissionMode;
        } else dormant!.record.permissionMode = p.permissionMode;
        await this.d.store.upsertSession(p.sid, { permissionMode: p.permissionMode });
        this.#persist();
        return { ok: true };
      }
      case "session.answer": {
        const s = this.sessions.get(p.sid);
        const resolve = s?.questions.get(p.questionId);
        if (!s || !resolve) return this.#reject(cid, "unknown_question");
        // An answer steers the running turn, so that turn can't keep a more trusted origin.
        s.turnOriginFloor = lowerTrust(s.turnOriginFloor ?? origin, origin);
        resolve(await open<Record<string, string | string[]>>(p.answerCt));
        s.questions.delete(p.questionId);
        return { ok: true };
      }
      case "policy.tighten": {
        const res = applyRemoteTighten(policy, await open<unknown>(p.patchCt));
        if (!res.ok) return this.#reject(cid, res.reason);
        await this.d.policy.set(res.policy, "remote_tighten");
        return { ok: true };
      }
      case "policy.proposePreset": {
        this.pendingPreset = p.preset;
        this.#audit("policy.preset_proposed", { preset: p.preset, origin });
        return { ok: true };
      }
      case "devmode.off":
        await this.d.devMode.off(origin);
        await this.d.store.updateDevice({ devMode: this.d.devMode.state });
        return { ok: true };
      case "devmode.toggleOff":
        await this.d.devMode.toggleOff(p.toggle, origin);
        await this.d.store.updateDevice({ devMode: this.d.devMode.state });
        return { ok: true };
      case "device.revokeClient": {
        // Revoking ANOTHER client takes the signer's passkey step-up over this command (review
        // R-L1), so a stolen phone can't wipe the user's other phones (or the last one holding a
        // passkey) from every agent. Revoking oneself never needs it. Setups where no trusted
        // client has a passkey yet keep working without one.
        const signer = origin.startsWith("client:") ? origin.slice("client:".length) : null;
        if (p.clientDeviceId !== signer) {
          const failure = await this.#revokeStepUpFailure(signer, body);
          if (failure) return this.#reject(cid, failure);
        }
        this.d.trust().remove(p.clientDeviceId);
        await this.d.saveTrust();
        // ADR 0020 revoke-all (a bundle step-up) also revokes every link on this device.
        if (body?.stepUp?.bundle) {
          await this.d.links?.revokeAll("revoke_all");
          this.#cancelOutside();
        }
        for (const s of this.sessions.values())
          if (s.startedBy === `client:${p.clientDeviceId}`) await s.handle.interrupt();
        await this.d.screen?.endForClient(p.clientDeviceId);
        this.#audit("trust.client_removed", { clientDeviceId: p.clientDeviceId, by: origin });
        return { ok: true };
      }
      // Credentials, the app's own sign-in, its official install and launching it: none of
      // these touches policy, trust or Developer mode, and none enables a custom recipe (that's
      // only on the device). An install still waits for a yes on this computer, and a sign-in
      // happens on this computer. provider.* are aliases for the four former providers.
      case "provider.connect":
      case "app.connect": {
        const apps = this.d.apps;
        if (!apps) return this.#reject(cid, "provider_failed");
        const appId = p.type === "app.connect" ? p.appId : PROVIDER_APP[p.provider];
        const r =
          p.method === "api_key"
            ? await apps.connectKey(appId, await open<string>(p.keyCt!))
            : await apps.signin(appId);
        this.#audit("app.connect", { appId, method: p.method, by: origin, ok: r.ok, via: p.type });
        return r.ok ? { ok: true } : this.#reject(cid, r.reason ?? "provider_failed");
      }
      case "provider.disconnect":
      case "app.disconnect": {
        if (!this.d.apps) return this.#reject(cid, "provider_failed");
        const appId = p.type === "app.disconnect" ? p.appId : PROVIDER_APP[p.provider];
        const r = await this.d.apps.disconnect(appId);
        this.#audit("app.disconnect", { appId, by: origin, ok: r.ok, via: p.type });
        return r.ok ? { ok: true } : this.#reject(cid, r.reason ?? "provider_failed");
      }
      case "provider.install":
      case "app.install": {
        if (!this.d.apps) return this.#reject(cid, "provider_failed");
        const appId = p.type === "app.install" ? p.appId : PROVIDER_APP[p.provider];
        const r = await this.d.apps.requestInstall(appId);
        this.#audit("app.install_requested", { appId, by: origin, ok: r.ok, via: p.type });
        return r.ok ? { ok: true } : this.#reject(cid, r.reason ?? "provider_failed");
      }
      case "provider.status":
      case "app.status":
        if (!this.d.apps) return this.#reject(cid, "provider_failed");
        await this.d.apps.report(p.type === "app.status" ? p.appId : undefined);
        return { ok: true };
      case "app.launch": {
        if (!this.d.apps) return this.#reject(cid, "provider_failed");
        const r = await this.d.apps.launch(p.appId);
        this.#audit("app.launch", { appId: p.appId, by: origin, ok: r.ok });
        return r.ok ? { ok: true } : this.#reject(cid, r.reason ?? "app_unavailable");
      }
      // ---- TERMINAL: open only what the person turned on here, after their passkey approval ----
      case "terminal.open": {
        if (!this.d.terminal) return this.#reject(cid, "terminal_disabled");
        const r = await this.d.terminal.open(
          { appId: p.appId, workspaceLabel: p.workspaceLabel, cols: p.cols ?? 80, rows: p.rows ?? 24 },
          origin,
        );
        return r.ok ? { ok: true, ...(r.tid ? { sid: r.tid } : {}) } : this.#reject(cid, r.reason);
      }
      case "terminal.input": {
        // Unknown terminals are refused before anything is decrypted.
        if (!this.d.terminal?.has(p.tid)) return this.#reject(cid, "unknown_session");
        const parsed = TerminalData.safeParse(await open<unknown>(p.dataCt));
        if (!parsed.success) return this.#reject(cid, "invalid");
        const r = this.d.terminal.input(p.tid, parsed.data.data, origin);
        return r.ok ? { ok: true, quiet: true } : this.#reject(cid, r.reason);
      }
      case "terminal.resize": {
        if (!this.d.terminal?.has(p.tid)) return this.#reject(cid, "unknown_session");
        const r = this.d.terminal.resize(p.tid, p.cols, p.rows, origin);
        return r.ok ? { ok: true, quiet: true } : this.#reject(cid, r.reason);
      }
      case "terminal.close": {
        if (!this.d.terminal) return this.#reject(cid, "unknown_session");
        const r = await this.d.terminal.close(p.tid, origin);
        return r.ok ? { ok: true, sid: p.tid } : this.#reject(cid, r.reason);
      }

      // ---- SCREEN (screen/manager.ts): asks only; enabling is local (`chalito screen enable`).
      case "screen.open": {
        if (!this.d.screen) return this.#reject(cid, "screen_disabled");
        const r = await this.d.screen.open({
          origin,
          mode: p.mode,
          ...(p.display !== undefined ? { display: p.display } : {}),
          ...(p.appId ? { appId: p.appId } : {}),
        });
        return r.ok ? { ok: true, sid: r.sid } : this.#reject(cid, r.reason);
      }
      case "screen.close": {
        if (!this.d.screen) return this.#reject(cid, "unknown_session");
        const r = await this.d.screen.close(p.sid, origin);
        return r.ok ? { ok: true } : this.#reject(cid, r.reason ?? "unknown_session");
      }
      case "screen.signal": {
        if (!this.d.screen) return this.#reject(cid, "unknown_session");
        const signal = ScreenSignal.safeParse(await open<unknown>(p.signalCt));
        if (!signal.success) return this.#reject(cid, "bad_signal");
        const r = await this.d.screen.signal(p.sid, origin, signal.data);
        return r.ok ? { ok: true } : this.#reject(cid, r.reason ?? "bad_signal");
      }

      // ---- LINKS (links/manager.ts, ADR 0022 §3) ---------------------------------------------
      case "link.create": {
        // Share links only (hand-off is unrepresentable here), from a trusted client, with that
        // client's passkey step-up over this command, always (no passkey = no remote link).
        if (!this.d.links) return this.#reject(cid, "links_disabled");
        const signer = origin.startsWith("client:") ? origin.slice("client:".length) : null;
        if (!signer || !this.d.trust().webauthnFor(signer)) return this.#reject(cid, "step_up_required");
        const failure = await this.#revokeStepUpFailure(signer, body);
        if (failure) return this.#reject(cid, failure);
        const r = await this.d.links.createFromClient(p.link, origin);
        return r.ok ? { ok: true } : this.#reject(cid, r.reason);
      }
      case "link.revoke":
        if (!this.d.links) return this.#reject(cid, "links_disabled");
        return (await this.d.links.revoke(p.linkId, origin)) ? { ok: true } : this.#reject(cid, "unknown_link");
      case "link.revokeAll":
        if (!this.d.links) return this.#reject(cid, "links_disabled");
        await this.d.links.revokeAll(origin);
        this.#cancelOutside();
        return { ok: true };
      case "link.list":
        if (!this.d.links) return this.#reject(cid, "links_disabled");
        await this.d.links.publish();
        return { ok: true };
      // ---- coordinator mode (ADR 0025 §6): client-signed only (no relay carries these) ----
      case "coord.start": {
        if (!policy.coordinator?.enabled) return this.#reject(cid, "coordinator_off");
        if (!isSignedOrigin(origin)) return this.#reject(cid, "origin_mismatch");
        const target = await this.#sessionTarget(undefined, p.appId ?? "claude-code");
        if (!target.ok) return this.#reject(cid, target.reason);
        const goal = await open<string>(p.goalCt);
        if (typeof goal !== "string" || !goal.trim()) return this.#reject(cid, "invalid");
        const r = await this.coordinator.start({
          goal: goal.slice(0, 4000),
          workspaceLabel: p.workspaceLabel,
          appId: p.appId ?? "claude-code",
          maxAgents: p.maxAgents ?? 3,
          maxMinutes: p.maxMinutes ?? 120,
          ...(p.base ? { base: p.base } : {}),
          ...(p.helpers ? { helpers: p.helpers } : {}),
        });
        return r.ok ? { ok: true, ...(r.sid ? { sid: r.sid } : {}) } : this.#reject(cid, r.reason);
      }
      case "coord.approve": {
        if (!policy.coordinator?.enabled) return this.#reject(cid, "coordinator_off");
        if (!isSignedOrigin(origin)) return this.#reject(cid, "origin_mismatch");
        // Approving a plan lets Chalito answer its helpers' prompts: the owner's passkey, always
        // (security review, 2026-10-19), like the merge tap.
        const failure = await this.#passkeyFailure(origin.startsWith("client:") ? origin.slice(7) : null, body);
        if (failure) return this.#reject(cid, failure);
        const r = await this.coordinator.approve(p.planId, p.digest);
        return r.ok ? { ok: true, ...(r.sid ? { sid: r.sid } : {}) } : this.#reject(cid, r.reason);
      }
      case "coord.stop": {
        // The kill switch: cheap (no passkey) and works even with coordinator mode turned off
        // since, but only from a trusted client's signature.
        if (!isSignedOrigin(origin)) return this.#reject(cid, "origin_mismatch");
        const r = await this.coordinator.stop(p.planId, "owner");
        return r.ok ? { ok: true, ...(r.sid ? { sid: r.sid } : {}) } : this.#reject(cid, r.reason);
      }
      case "coord.merge": {
        if (!policy.coordinator?.enabled) return this.#reject(cid, "coordinator_off");
        if (!isSignedOrigin(origin)) return this.#reject(cid, "origin_mismatch");
        // The owner's merge tap moves (and pushes) the base: their passkey, always.
        const failure = await this.#passkeyFailure(origin.startsWith("client:") ? origin.slice(7) : null, body);
        if (failure) return this.#reject(cid, failure);
        const r = await this.coordinator.merge(p.planId, p.digest);
        return r.ok ? { ok: true, ...(r.sid ? { sid: r.sid } : {}) } : this.#reject(cid, r.reason);
      }
      case "link.handoff":
      case "link.share":
      case "link.result": {
        // Only an agent-link relay (verified in #handle) carries these (CommandBody refine).
        if (!this.d.links || !origin.startsWith("agent:")) return this.#reject(cid, "links_disabled");
        const r = await this.d.links.onRelay(cid, p, origin);
        return r.ok ? { ok: true, ...(r.sid ? { sid: r.sid } : {}) } : this.#reject(cid, r.reason);
      }
    }
  }

  /** Queued link data (shares, results) goes in front of the owner's own prompt only. */
  #withLinkData(sid: string, text: string, origin: Origin): string {
    return this.d.links && isSignedOrigin(origin) ? this.d.links.takeShared(sid, text) : text;
  }

  /** What the link manager may do here: the same session, event and approval paths as commands. */
  #coordHost(): CoordHost {
    return {
      workspace: (label) => this.d.policy.get().workspaces.find((w) => w.label === label),
      helpersAllowed: () => PERMISSION_RANK[this.d.policy.get().remote.maxPermissionMode] >= PERMISSION_RANK.default,
      startSession: async (input) => {
        // The same ceiling as any remote start (security review): never above this computer's.
        if (PERMISSION_RANK[input.permissionMode] > PERMISSION_RANK[this.d.policy.get().remote.maxPermissionMode])
          return { ok: false, reason: "permission_mode_above_ceiling" };
        const target = await this.#sessionTarget(undefined, input.appId);
        if (!target.ok) return target;
        if (!(await this.#makeRoom())) return { ok: false, reason: "session_limit" };
        try {
          await this.startSession({
            sid: input.sid,
            adapter: target.adapter,
            ...(target.appId ? { appId: target.appId } : {}),
            ...(target.appAdapter ? { appAdapter: target.appAdapter } : {}),
            workspace: { label: input.workspaceLabel, path: input.cwd },
            prompt: input.prompt,
            origin: input.origin,
            permissionMode: input.permissionMode,
            coord: input.coord,
          });
          return { ok: true };
        } catch (err) {
          this.d.log.error("coord.start_failed", { error: err instanceof Error ? err.message : "error" });
          return { ok: false, reason: "start_failed" };
        }
      },
      prompt: async (sid, text, origin) => {
        const s = this.sessions.get(sid);
        if (!s) {
          if (this.#dormant.has(sid)) await this.#revive(`coord-${sid}-${this.d.now()}`, sid, text, origin);
          return;
        }
        await this.#event(s, { type: "message.user", origin, ct: await this.sealer.seal({ text }, `event:${sid}`) });
        this.#prompt(s, text, origin);
      },
      interrupt: async (sid) => {
        await this.sessions.get(sid)?.handle?.interrupt();
      },
      observe: (sid, fn) => {
        this.#observers.set(sid, fn);
        return () => {
          if (this.#observers.get(sid) === fn) this.#observers.delete(sid);
        };
      },
      endHelper: (sid) => void this.#coordEnded.add(sid),
      deviceId: () => this.d.self.deviceId,
      coordinatorOn: () => this.d.policy.get().coordinator?.enabled === true,
      // A hand-off link the owner made here to that computer, starting new sessions there; one
      // that doesn't ask the phone each time wins.
      linkTo: (deviceId, appId) => {
        const now = this.d.now();
        const usable = (this.d.links?.list() ?? []).filter(
          (l) =>
            l.mode === "handoff" &&
            l.sender.deviceId === this.d.self.deviceId &&
            l.receiver.deviceId === deviceId &&
            l.sender.sessionId === undefined &&
            l.receiver.sessionId === undefined &&
            (l.sender.appId === undefined || l.sender.appId === appId) &&
            l.expiresAt > now,
        );
        const l = usable.find((x) => !x.confirm) ?? usable[0];
        return l ? { linkId: l.id } : null;
      },
      sendCoordTask: async (linkId, fromSid, task) => {
        if (!this.d.links) return { ok: false, reason: "links_disabled" };
        return this.d.links.handoff({ fromSid, linkId, parts: [{ data: task }] });
      },
      onCoordResult: (fn) => {
        this.#coordResult = fn;
      },
      publish: async (sid, state) => {
        if (this.#revoked) return;
        // Signed by this agent, then sealed: clients verify it against the key they trust (security review).
        const signed = await signEnvelope(
          "chalito.coordplan.v1",
          state,
          this.d.self.deviceId,
          this.d.self.sign.secretKey,
        );
        await this.d.store.upsertSession(sid, {
          coord: { planId: state.planId, ct: await this.sealer.seal(signed, `coord:${sid}`) },
          updatedAt: this.d.now(),
        });
      },
    };
  }

  #linkHost(): LinkHost {
    const info = (s: Session) => ({
      sid: s.sid,
      cwd: s.cwd,
      workspaceLabel: s.workspaceLabel,
      permissionMode: s.permissionMode,
      ...(s.appId ? { appId: s.appId } : {}),
    });
    const host: LinkHost = {
      session: (sid) => {
        const s = this.sessions.get(sid);
        if (s) return info(s);
        // Idle-closed or from before a restart (M16 A): still the link's receiver; a prompt revives it.
        const r = this.#dormant.get(sid)?.record;
        const ws = r && this.d.policy.get().workspaces.find((w) => w.label === r.workspaceLabel);
        return r && ws
          ? {
              sid,
              cwd: ws.path,
              workspaceLabel: r.workspaceLabel,
              permissionMode: r.permissionMode,
              ...(r.appId ? { appId: r.appId } : {}),
            }
          : undefined;
      },
      sessions: () => [...this.sessions.values()].map(info),
      coordTask: (input) => this.coordinator.runRemote(input),
      startSession: async (input) => {
        // A link starts new sessions only: never one this computer already has, live or dormant.
        if (this.sessions.has(input.sid) || this.#dormant.has(input.sid)) return { ok: false, reason: "start_failed" };
        const policy = this.d.policy.get();
        const ws = policy.workspaces.find((w) => w.label === input.workspaceLabel);
        if (!ws) return { ok: false, reason: "unknown_workspace" };
        if (PERMISSION_RANK[input.permissionMode] > PERMISSION_RANK[policy.remote.maxPermissionMode])
          return { ok: false, reason: "permission_mode_above_ceiling" };
        const target = await this.#sessionTarget(undefined, input.appId ?? "claude-code");
        if (!target.ok) return target;
        try {
          await this.startSession({
            sid: input.sid,
            adapter: target.adapter,
            ...(target.appId ? { appId: target.appId } : {}),
            ...(target.appAdapter ? { appAdapter: target.appAdapter } : {}),
            workspace: ws,
            prompt: input.prompt,
            origin: input.origin,
            permissionMode: input.permissionMode,
          });
          return { ok: true };
        } catch (err) {
          this.d.log.error("link.start_failed", { error: err instanceof Error ? err.message : "error" });
          return { ok: false, reason: "start_failed" };
        }
      },
      prompt: async (sid, text, origin) => {
        // A session on its way to another computer takes no hand-off (the link reports it as failed).
        if (this.#transfers?.isMoving(sid)) throw new Error("session_busy");
        const s = this.sessions.get(sid);
        if (!s) {
          if (this.#dormant.has(sid)) await this.#revive(`link-${sid}-${this.d.now()}`, sid, text, origin);
          return;
        }
        await this.#event(s, { type: "message.user", origin, ct: await this.sealer.seal({ text }, `event:${sid}`) });
        this.#prompt(s, text, origin);
      },
      interrupt: async (sid) => {
        await this.sessions.get(sid)?.handle.interrupt();
      },
      event: async (sid, partial) => {
        const s = this.sessions.get(sid);
        if (s) return this.#event(s, partial);
        // A hand-off's progress or result can arrive after the session idle-closed (M16 A): it is
        // still that session's timeline, numbered after its last event.
        const d = this.#dormant.get(sid);
        if (!d) return;
        const seq = d.record.seq;
        d.record = { ...d.record, seq: seq + 1 };
        this.#persist();
        await this.#event({ sid, seq } as Session, partial, { seq });
      },
      confirm: async (sid, input) => {
        const s = this.sessions.get(sid);
        const outcome = s
          ? await this.#approve(s, {
              risk: "MED",
              stepUp: false,
              origin: input.origin,
              kind: "link_handoff",
              details: input.details,
            })
          : await this.#requestApproval({
              sid,
              risk: "MED",
              stepUp: false,
              origin: input.origin,
              kind: "link_handoff",
              details: input.details,
            });
        return { allow: outcome.allow };
      },
      handleCommand: (cid, doc) => this.handleCommand(cid, doc),
      sealForClients: (value, aad) => this.sealer.seal(value, aad),
    };
    // ADR 0031 §4: a session moved here. Same project (origin) or refused; then the owner's next turns.
    host.transferIn = async (i) => {
      const ws = this.d.policy.get().workspaces.find((w) => w.label === i.workspaceLabel);
      if (!ws) return { ok: false, reason: "start_failed" };
      if (i.transfer.repo && (await repoRemote(this.#git, ws.path)) !== i.transfer.repo.remote)
        return { ok: false, reason: "wrong_repo" };
      const started = await host.startSession({
        sid: i.sid,
        appId: i.appId,
        workspaceLabel: i.workspaceLabel,
        prompt: transferFrame(i.transfer, i.fromDeviceId),
        origin: i.origin,
        // Never above the session's own mode on the other computer, nor the link's ceiling.
        permissionMode:
          PERMISSION_RANK[i.transfer.permissionMode] <= PERMISSION_RANK[i.ceiling]
            ? i.transfer.permissionMode
            : i.ceiling,
      });
      if (!started.ok) return { ok: false, reason: "start_failed" };
      this.#audit("session.transfer.received", { sid: i.sid, from: i.fromDeviceId, fromSid: i.transfer.fromSid });
      // Started: the ack must go back even if this notice can't be written.
      await host
        .event(i.sid, {
          type: "session.transferred",
          direction: "in",
          stage: "delivered",
          peerDeviceId: i.fromDeviceId,
          peerSid: i.transfer.fromSid,
        })
        .catch((err: unknown) => this.#writeFailed("session.transfer_event_failed", err));
      return { ok: true };
    };
    return host;
  }

  /**
   * What `session.start` runs: the four built-in adapters (by `adapter`, or by their app id),
   * gated by `policy.adapters` as before; any other app by its id, through the session adapter a
   * registered driver built for it, while the app is ready here and the person allowed its
   * sessions on this computer (`policy.apps.sessions[appId] === true`, set only locally).
   */
  async #sessionTarget(
    adapter: AdapterKind | undefined,
    appId: string | undefined,
  ): Promise<
    { ok: true; adapter: AdapterKind; appId?: string; appAdapter?: SessionAdapter } | { ok: false; reason: string }
  > {
    const policy = this.d.policy.get();
    if (appId === undefined || isLegacyApp(appId)) {
      const kind = appId !== undefined ? APP_ADAPTER[appId as keyof typeof APP_ADAPTER] : adapter!;
      if (adapter !== undefined && adapter !== kind) return { ok: false, reason: "adapter_disabled" };
      // "acp" alone (no app) is never enabled; a missing grok/gemini key is off.
      const enabled = {
        "claude-code": policy.adapters.claudeCode,
        codex: policy.adapters.codex,
        grok: policy.adapters.grok ?? false,
        gemini: policy.adapters.gemini ?? false,
        acp: false,
        // Like "acp": a chat-api or a2a session always names its app.
        "chat-api": false,
        a2a: false,
      }[kind];
      if (!this.d.adapters[kind] || !enabled) return { ok: false, reason: "adapter_disabled" };
      return { ok: true, adapter: kind, ...(appId ? { appId } : {}) };
    }
    if (!this.d.apps?.sessionReady) return { ok: false, reason: "unknown_app" };
    const ready = await this.d.apps.sessionReady(appId);
    if (!ready.ok) return ready;
    // Owner decision 2026-10-06: off until the person allows this app's sessions on this computer
    // (`chalito apps sessions enable` / the desktop panel); missing = off.
    if (policy.apps?.sessions?.[appId] !== true) return { ok: false, reason: "adapter_disabled" };
    const appAdapter =
      this.d.appAdapters && Object.hasOwn(this.d.appAdapters, appId) ? this.d.appAdapters[appId] : undefined;
    if (!appAdapter) return { ok: false, reason: "adapter_disabled" };
    // The card names the protocol family; the session doc carries the app id.
    return { ok: true, adapter: adapter ?? appAdapter.kind, appId, appAdapter };
  }

  /** The daemon rebuilds the adapters when an app is connected, signed out or installed. */
  setAdapters(
    adapters: Partial<Record<AdapterKind, SessionAdapter>>,
    appAdapters?: Readonly<Record<string, SessionAdapter>>,
  ): void {
    this.d.adapters = adapters;
    if (appAdapters) this.d.appAdapters = appAdapters;
  }

  /** Engine: the session adapters registered drivers built for apps beyond the built-in four. */
  setAppAdapters(appAdapters: Readonly<Record<string, SessionAdapter>>): void {
    this.d.appAdapters = appAdapters;
  }

  /** Local acceptance of a cloud-proposed preset (desktop app or CLI). */
  async acceptPendingPreset(): Promise<boolean> {
    if (!this.pendingPreset) return false;
    await this.d.policy.set(presetPolicy(this.pendingPreset, this.d.policy.get()), "preset_accepted");
    this.pendingPreset = null;
    return true;
  }

  // ---- sessions -----------------------------------------------------------------

  async startSession(input: {
    adapter: AdapterKind;
    /** Engine: the recipe id, and the adapter its driver built (apps beyond the built-in four). */
    appId?: string;
    appAdapter?: SessionAdapter;
    workspace: { label: string; path: string };
    prompt: string;
    origin: Origin;
    permissionMode: RemotePermissionMode;
    sid?: string;
    /**
     * M16 A: reopen a session that has no process (idle-closed, ended, from before a restart) in
     * its provider session. `prompt` may then be empty (reopened idle, no turn).
     */
    resume?: { providerSessionId?: string; seq: number; startedBy: Origin; card?: CardBuilder };
    /** Coordinator mode: the helper's plan and task (set only by the local coordinator). */
    coord?: SessionCoord;
  }): Promise<string> {
    const sid = input.sid ?? randomUUID();
    const resume = input.resume;
    const card =
      resume?.card ??
      new CardBuilder(
        { sid, adapter: input.adapter, label: input.workspace.label, workspaceLabel: input.workspace.label },
        this.d.now,
      );
    if (input.prompt) card.goal(input.prompt);
    const session: Session = {
      sid,
      adapter: input.adapter,
      ...(input.appId ? { appId: input.appId } : {}),
      cwd: input.workspace.path,
      label: input.workspace.label,
      workspaceLabel: input.workspace.label,
      startedBy: resume?.startedBy ?? input.origin,
      permissionMode: input.permissionMode,
      handle: undefined as unknown as SessionHandle,
      card,
      seq: resume?.seq ?? 0,
      ...(resume?.providerSessionId ? { providerSessionId: resume.providerSessionId } : {}),
      questions: new Map(),
      state: "starting",
      lastActiveAt: this.d.now(),
      turnOrigin: input.origin,
      liveChain: Promise.resolve(),
      ...((input.coord ?? this.#coordOf.get(sid)?.coord)
        ? { coord: (input.coord ?? this.#coordOf.get(sid)?.coord)! }
        : {}),
    };
    if (input.coord) this.#coordOf.set(sid, { coord: input.coord, cwd: input.workspace.path });
    this.sessions.set(sid, session);
    this.#dormant.delete(sid);
    try {
      if (resume) {
        await this.d.store.upsertSession(sid, { state: "starting", live: true, updatedAt: this.d.now() });
      } else {
        await this.d.store.upsertSession(sid, {
          deviceId: this.d.self.deviceId,
          adapter: input.adapter,
          // Engine: chalito.sessions.kind / app_id are generated from these (migration 20261006000300).
          kind: "agent",
          ...(input.appId ? { appId: input.appId } : {}),
          label: session.label,
          cwdLabel: session.workspaceLabel,
          state: "starting",
          live: true,
          permissionMode: input.permissionMode,
          updatedAt: this.d.now(),
        });
        await this.#event(session, {
          type: "session.started",
          adapter: input.adapter,
          origin: input.origin,
          permissionMode: input.permissionMode,
        });
      }
      if (input.prompt) this.#local(sid, { type: "user", origin: input.origin, text: input.prompt });
      // ADR 0031 §1: a session typed at this computer shows its first prompt on the phone too.
      if (!resume && input.prompt && (input.origin === "local" || input.origin === "local:cli"))
        await this.#event(session, {
          type: "message.user",
          origin: input.origin,
          ct: await this.sealer.seal({ text: input.prompt }, `event:${sid}`),
        });
      if (resume && input.prompt)
        await this.#event(session, {
          type: "message.user",
          origin: input.origin,
          ct: await this.sealer.seal({ text: input.prompt }, `event:${sid}`),
        });
      this.#persist();

      const adapter = input.appAdapter ?? this.d.adapters[input.adapter]!;
      // Computer control: only when the person turned it on here, for signed origins, with the
      // desktop app running, and only for adapters that put the server's tool calls through the
      // gate (Claude Code, Codex, ACP: `localMcp`). Its tools stay inert until this session's
      // computer_control approval.
      const computer = adapter.localMcp
        ? this.d.computer?.attach(sid, {
            label: session.label,
            adapter: input.adapter,
            origin: input.origin,
          })
        : null;
      // Link tools: only for a session that is the sender on an active link, for adapters that put
      // the server's calls through the gate (the chat-api bridge does too).
      const linkServer =
        adapter.localMcp || adapter.kind === "chat-api"
          ? (this.d.linkTools?.attach(sid, resume?.startedBy ?? input.origin) ?? null)
          : null;
      const mcpServers = {
        ...(computer
          ? {
              [computer.name]: {
                command: computer.command,
                args: computer.args,
                env: computer.env,
                // ACP names a call after this server only for a real tool with valid arguments.
                isTool: (tool: string, input: Record<string, unknown>) =>
                  isToolName(tool) && ToolArgs[tool].safeParse(input).success,
              },
            }
          : {}),
        ...(linkServer
          ? {
              [linkServer.name]: {
                command: linkServer.command,
                args: linkServer.args,
                env: linkServer.env,
                isTool: (tool: string, input: Record<string, unknown>) =>
                  isLinkToolName(tool) && LinkToolArgs[tool].safeParse(input).success,
              },
            }
          : {}),
      };
      session.handle = await adapter.start({
        sid,
        cwd: session.cwd,
        prompt: input.prompt,
        origin: input.origin,
        permissionMode: input.permissionMode,
        ...(resume?.providerSessionId ? { resume: resume.providerSessionId } : {}),
        ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
        gate: this.#gate(session),
        askUser: async (q) => {
          const first = q.questions[0]?.question ?? null;
          await this.#event(session, {
            type: "question.asked",
            questionId: q.questionId,
            ct: await this.sealer.seal(q.questions, `event:${sid}`),
          });
          card.question(first ?? undefined);
          await this.#publishCard(session);
          await this.callLines.publish(`${sid}_${q.questionId}`, {
            notificationId: `q_${q.questionId}`,
            sid,
            sessionLabel: session.label,
            question: first,
          });
          const answers = await new Promise<Record<string, string | string[]>>((resolve) =>
            session.questions.set(q.questionId, resolve),
          );
          await this.callLines.remove(`${sid}_${q.questionId}`);
          card.question(undefined);
          return answers;
        },
        // Never an unhandled rejection: one would take the whole agent process down.
        onEvent: (e) =>
          void this.#onAdapterEvent(session, e).catch((err: unknown) => this.#writeFailed("session.event_failed", err)),
      });
    } catch (err) {
      // Nothing runs: forget the live session (a resumable one goes back to waiting).
      this.d.computer?.end(sid);
      this.d.linkTools?.end(sid);
      if (this.sessions.get(sid) === session) this.sessions.delete(sid);
      if (resume) this.#dormant.set(sid, { record: this.#record(session, false), card });
      this.#persist();
      throw err;
    }
    // The process is gone (it exited, crashed, or was closed): keep the session resumable.
    void session.handle.done.then(
      () => this.#retire(session),
      () => this.#retire(session),
    );
    return sid;
  }

  /**
   * An outside hand-off task (MCP create_task, A2A SendMessage; ADR 0022 §4, M16 F). Fail closed:
   * - Its session id is made here (`outsideTaskSid`: owner, origin, cid), never taken from the
   *   cloud, and never one a link names or a live, dormant or pending session has.
   * - The owner's `link_handoff` tap is needed unless a locally held link for this receiver (app
   *   and workspace) is set to automatic. The cloud's `linkConfirm` can add the tap, never remove it.
   * - The link's `ratePerHour` applies here (a default for a cloud-only link), and pending taps
   *   are capped per origin and per link.
   * - After the tap: revoke-all (which cancels pending taps), the link's revocation and cloud row,
   *   policy, exposure and the app are checked again before anything starts.
   */
  async #outsideStart(
    cid: string,
    origin: Origin,
    p: Extract<CommandPayload, { type: "session.start" }>,
    ws: { label: string; path: string },
    target: { ok: true; adapter: AdapterKind; appId?: string; appAdapter?: SessionAdapter },
    prompt: string,
  ): Promise<CommandResult> {
    const sid = await outsideTaskSid(this.d.owner, origin, cid);
    if (this.sessions.has(sid) || this.#dormant.has(sid) || this.#outside.has(sid) || this.d.links?.namesSession(sid))
      return this.#reject(cid, "invalid");
    const appId = target.appId ?? p.appId;
    const local = this.d.links?.outsideLink(appId, ws.label);
    const confirm = p.linkConfirm !== undefined || !local || local.confirm;
    const key = local ? local.id : `cloud:${p.linkConfirm?.linkId ?? origin}`;
    const now = this.d.now();
    const recent = (this.#outsideRate.get(key) ?? []).filter((t) => t > now - 60 * 60_000);
    if (recent.length >= (local?.ratePerHour ?? OUTSIDE_RATE_PER_HOUR)) {
      this.#audit("link.task.refused", { cid, origin, reason: "rate_limited" });
      return this.#reject(cid, "rate_limited");
    }
    if (confirm) {
      const pending = [...this.#outside.values()];
      if (
        pending.filter((x) => x.origin === origin).length >= OUTSIDE_PENDING_PER_ORIGIN ||
        pending.filter((x) => x.key === key).length >= OUTSIDE_PENDING_PER_LINK
      ) {
        this.#audit("link.task.refused", { cid, origin, reason: "too_many_pending" });
        return this.#reject(cid, "rate_limited");
      }
    }
    this.#outsideRate.set(key, [...recent, now]);
    const task = {
      sid,
      origin,
      key,
      appId,
      adapter: p.adapter,
      prompt,
      workspace: ws,
      permissionMode: p.permissionMode,
    };
    if (!confirm) {
      const refused = await this.d.links!.linkRefusal(local!.id);
      if (refused) {
        this.#audit("link.task.refused", { cid, origin, linkId: local!.id, reason: refused });
        return this.#reject(cid, "link_refused");
      }
      return this.#startOutside(cid, task, local!.id);
    }
    const abort = new AbortController();
    this.#outside.set(sid, { origin, key, abort });
    void this.#confirmOutside(cid, task, local?.id, p.linkConfirm?.linkId, abort.signal)
      .catch((err: unknown) =>
        this.d.log.error("link.task_confirm_failed", { cid, error: err instanceof Error ? err.message : "error" }),
      )
      .finally(() => this.#outside.delete(sid));
    return { ok: true, quiet: true };
  }

  async #confirmOutside(
    cid: string,
    t: OutsideTask,
    localLinkId: string | undefined,
    cloudLinkId: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const linkId = localLinkId ?? cloudLinkId ?? null;
    this.#audit("link.task.confirm_requested", { cid, sid: t.sid, linkId, origin: t.origin });
    const outcome = await this.#requestApproval({
      sid: t.sid,
      risk: "MED",
      stepUp: false,
      origin: t.origin,
      kind: "link_handoff",
      signal,
      details: {
        toolName: "link.handoff",
        input: {
          ...(linkId ? { linkId } : {}),
          from: t.origin,
          to: t.appId ?? t.adapter ?? null,
          workspace: t.workspace.label,
          request: partsAsData([{ text: t.prompt }]),
        },
        reasons: [`Task from ${t.origin}${linkId ? ` over link ${linkId}` : ""}`],
      },
    });
    const refuse = async (reason: string) => {
      this.#audit("link.task.declined", { cid, sid: t.sid, linkId, reason });
      await this.#publishResult(cid, { ok: false, reason: "link_refused" });
    };
    if (!outcome.allow) return refuse(signal.aborted ? "revoked_all" : outcome.reason);
    // Revoked (here, by revoke-all, or the cloud row) while the phone was asked: still refused.
    if (signal.aborted) return refuse("revoked_all");
    if (localLinkId) {
      const refused = await this.d.links!.linkRefusal(localLinkId);
      if (refused) return refuse(refused);
    }
    await this.#publishResult(cid, await this.#startOutside(cid, t, linkId));
  }

  /** The checks again (policy may have changed meanwhile), then the session. */
  async #startOutside(cid: string, t: OutsideTask, linkId: string | null): Promise<CommandResult> {
    const policy = this.d.policy.get();
    const ws = policy.workspaces.find((w) => w.label === t.workspace.label);
    const target = await this.#sessionTarget(t.adapter, t.appId);
    const r: CommandResult = !ws
      ? this.#reject(cid, "unknown_workspace")
      : !originAllowed(policy.origins, t.origin)
        ? this.#reject(cid, "origin_disabled")
        : !exposedFor(policy, t.origin, t.appId, t.workspace.label)
          ? this.#reject(cid, "not_exposed")
          : PERMISSION_RANK[t.permissionMode] > PERMISSION_RANK[policy.remote.maxPermissionMode]
            ? this.#reject(cid, "permission_mode_above_ceiling")
            : !target.ok
              ? this.#reject(cid, target.reason)
              : !(await this.#makeRoom())
                ? this.#reject(cid, "session_limit")
                : await this.startSession({
                    sid: t.sid,
                    adapter: target.adapter,
                    ...(target.appId ? { appId: target.appId } : {}),
                    ...(target.appAdapter ? { appAdapter: target.appAdapter } : {}),
                    workspace: ws,
                    prompt: t.prompt,
                    origin: t.origin,
                    permissionMode: t.permissionMode,
                  }).then(
                    (sid): CommandResult => ({ ok: true, sid }),
                    (err: unknown) => {
                      this.d.log.error("session.start_failed", {
                        cid,
                        error: err instanceof Error ? err.message : "error",
                      });
                      return this.#reject(cid, "start_failed");
                    },
                  );
    this.#audit(r.ok ? "link.task.delivered" : "link.task.refused", {
      cid,
      sid: t.sid,
      linkId,
      ...(r.ok ? {} : { reason: r.reason }),
    });
    return r;
  }

  /** Revoke-all: every pending outside task's tap is cancelled (a no). */
  #cancelOutside(): void {
    for (const x of this.#outside.values()) x.abort.abort();
  }

  // ---- session lifecycle (M16 A, ADR 0022 §1) -------------------------------------------------

  get #lifecycle() {
    return this.d.sessionsConfig ?? SESSIONS_DEFAULTS;
  }

  #schedule(fn: () => void, ms: number): { clear(): void } {
    if (this.d.setTimer) return this.d.setTimer(fn, ms);
    const t = setTimeout(fn, ms);
    t.unref?.();
    return { clear: () => clearTimeout(t) };
  }

  /** The origin the computer-control broker checks each action against (this turn's, lowered). */
  turnOrigin(sid: string): Origin | undefined {
    const s = this.sessions.get(sid);
    if (!s) return undefined;
    return s.turnOriginFloor ? lowerTrust(s.turnOrigin, s.turnOriginFloor) : s.turnOrigin;
  }

  /** Sessions that can be resumed (no process), by sid. */
  dormantSessions(): SessionRecord[] {
    return [...this.#dormant.values()].map((d) => ({ ...d.record }));
  }

  #prompt(s: Session, text: string, origin: Origin): void {
    // A prompt queued into a running turn lowers that turn's origin, as the adapters do.
    s.turnOrigin = BUSY.has(s.state) ? lowerTrust(s.turnOrigin, origin) : origin;
    s.lastActiveAt = this.d.now();
    s.idleTimer?.clear();
    s.idleTimer = undefined;
    s.handle.prompt(text, origin);
  }

  #record(s: Session, live: boolean): SessionRecord {
    return {
      sid: s.sid,
      adapter: s.adapter,
      ...(s.appId ? { appId: s.appId } : {}),
      workspaceLabel: s.workspaceLabel,
      label: s.label,
      permissionMode: s.permissionMode,
      startedBy: s.startedBy,
      ...(s.providerSessionId ? { providerSessionId: s.providerSessionId } : {}),
      seq: s.seq,
      state: s.state,
      lastActiveAt: s.lastActiveAt,
      live,
    };
  }

  /** Saves every live and resumable session (labels and ids only); a failed write is logged. */
  #persist(): void {
    if (!this.d.registry) return;
    try {
      const records = [
        ...[...this.sessions.values()].filter((s) => !s.closing).map((s) => this.#record(s, true)),
        ...[...this.#dormant.values()].map((d) => d.record),
      ];
      this.d.registry.save(pruneRecords(records, this.d.now()));
    } catch (err) {
      this.d.log.warn("sessions.persist_failed", { error: err instanceof Error ? err.message : "error" });
    }
  }

  /**
   * At startup: the sessions saved before this agent stopped become resumable. Lazily: nothing is
   * spawned until a prompt or `session.resume` for one arrives. A session that was mid-turn when
   * the agent stopped is reported interrupted.
   */
  async restore(): Promise<number> {
    if (!this.d.registry) return 0;
    const records = pruneRecords(this.d.registry.load(), this.d.now());
    for (const r of records) {
      if (this.sessions.has(r.sid)) continue;
      const record = { ...r, seq: r.live ? r.seq + RESTART_SEQ_MARGIN : r.seq, live: false };
      if (BUSY.has(r.state)) {
        record.state = "interrupted";
        await this.d.store
          .upsertSession(r.sid, { state: "interrupted", live: false, updatedAt: this.d.now() })
          .catch((err: unknown) =>
            this.d.log.warn("sessions.restore_report_failed", { error: err instanceof Error ? err.message : "error" }),
          );
      }
      this.#dormant.set(r.sid, { record });
    }
    this.#persist();
    if (records.length) this.d.log.info("sessions.restored", { resumable: this.#dormant.size });
    return this.#dormant.size;
  }

  /**
   * Reopens a resumable session in its provider session (Claude `resume`, Codex `thread/resume`,
   * ACP `session/resume|load`), re-checking everything `session.start` checks: the workspace (by
   * label), the adapter or app, the permission ceiling, the live-session cap.
   */
  async #revive(cid: string, sid: string, prompt: string, origin: Origin): Promise<CommandResult> {
    const d = this.#dormant.get(sid);
    if (!d) return this.#reject(cid, "unknown_session");
    const r = d.record;
    const policy = this.d.policy.get();
    const ws = policy.workspaces.find((w) => w.label === r.workspaceLabel);
    if (!ws) return this.#reject(cid, "unknown_workspace");
    if (PERMISSION_RANK[r.permissionMode] > PERMISSION_RANK[policy.remote.maxPermissionMode])
      return this.#reject(cid, "permission_mode_above_ceiling");
    const target = await this.#sessionTarget(r.appId ? undefined : r.adapter, r.appId);
    if (!target.ok) return this.#reject(cid, target.reason);
    // A coordinator helper comes back in its own worktree, still a helper.
    const helper = this.#coordOf.get(sid);
    // Never learned a provider session (it failed at start): a prompt starts afresh in the same sid.
    if (!r.providerSessionId && !prompt) return { ok: true, sid };
    if (!(await this.#makeRoom(r.startedBy === "local:cli" ? "local:cli" : origin)))
      return this.#reject(cid, "session_limit");
    try {
      await this.startSession({
        adapter: target.adapter,
        ...(target.appId ? { appId: target.appId } : {}),
        ...(target.appAdapter ? { appAdapter: target.appAdapter } : {}),
        workspace: helper ? { label: ws.label, path: helper.cwd } : ws,
        prompt,
        origin,
        permissionMode: r.permissionMode,
        sid,
        resume: {
          ...(r.providerSessionId ? { providerSessionId: r.providerSessionId } : {}),
          seq: r.seq,
          startedBy: r.startedBy,
          ...(d.card ? { card: d.card } : {}),
        },
      });
      this.#audit("session.resumed", { sid, adapter: r.adapter, by: origin, withPrompt: prompt !== "" });
      return { ok: true, sid };
    } catch (err) {
      this.d.log.error("session.resume_failed", { cid, error: err instanceof Error ? err.message : "error" });
      return this.#reject(cid, "start_failed");
    }
  }

  /**
   * Below the live cap, or made so by closing the longest-idle session. False when every live
   * session is busy.
   */
  async #makeRoom(origin?: Origin): Promise<boolean> {
    const max = this.#lifecycle.session.maxLivePerDevice;
    const live = [...this.sessions.values()].filter((s) => !s.closing);
    // ADR 0031 §6a: terminal sessions get a small cap of their own and only ever evict each other.
    if (origin === "local:cli") {
      const mine = live.filter((s) => s.startedBy === "local:cli");
      const over = Math.max(mine.length - LOCAL_CLI_LIVE_MAX + 1, live.length - max + 1, 0);
      if (over === 0) return true;
      const idle = mine.filter((s) => !BUSY.has(s.state)).sort((a, b) => a.lastActiveAt - b.lastActiveAt);
      if (idle.length < over) return false;
      for (const s of idle.slice(0, over)) this.#suspend(s, "session_limit");
      return true;
    }
    if (live.length < max) return true;
    const idle = live.filter((s) => !BUSY.has(s.state)).sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    for (const s of idle.slice(0, live.length - max + 1)) this.#suspend(s, "session_limit");
    return idle.length >= live.length - max + 1;
  }

  /** (Re)arms the idle-close timer of a session that isn't busy. */
  #armIdle(s: Session): void {
    s.idleTimer?.clear();
    s.idleTimer = undefined;
    if (BUSY.has(s.state) || s.closing || this.#revoked) return;
    const timeout = this.#lifecycle.session.idleTimeout;
    const wait = Math.max(0, s.lastActiveAt + timeout - this.d.now());
    s.idleTimer = this.#schedule(() => {
      s.idleTimer = undefined;
      if (this.sessions.get(s.sid) !== s || s.closing || BUSY.has(s.state)) return;
      if (this.d.now() - s.lastActiveAt >= timeout) this.#suspend(s, "idle");
      else this.#armIdle(s);
    }, wait);
  }

  /**
   * Closes a session's process and keeps it resumable: `handle.close()`, out of the live map,
   * its provider session id kept. The phone keeps the state it had (no "completed").
   */
  #suspend(s: Session, reason: "idle" | "session_limit" | "agent_stop" | "agent_revoked" | "transferred"): void {
    if (s.closing) return;
    s.closing = true;
    s.idleTimer?.clear();
    s.idleTimer = undefined;
    s.draft?.throttle.discard();
    s.draft = undefined;
    this.d.computer?.end(s.sid);
    this.d.linkTools?.end(s.sid);
    if (this.sessions.get(s.sid) === s) this.sessions.delete(s.sid);
    this.#dormant.set(s.sid, { record: this.#record(s, false), card: s.card });
    try {
      s.handle?.close();
    } catch {
      /* already closed */
    }
    this.#persist();
    this.d.log.info("session.closed", { sid: s.sid, reason });
    // Revoked: the database refuses this device's writes, so there's no one to tell.
    if (this.#revoked) return;
    void this.d.store
      .upsertSession(s.sid, { live: false, updatedAt: this.d.now() })
      .catch((err: unknown) =>
        this.d.log.warn("session.close_report_failed", { error: err instanceof Error ? err.message : "error" }),
      );
  }

  /** The adapter's process ended on its own: the session stays resumable. */
  #retire(s: Session): void {
    if (s.closing || this.sessions.get(s.sid) !== s) return;
    this.#suspend(s, "idle");
  }

  /** True once the database refused a write as this device's (the account revoked it). */
  get revoked(): boolean {
    return this.#revoked;
  }

  /**
   * A store write failed. An RLS refusal (42501) of this device's own rows means the account
   * revoked it: an expected outcome, handled once by `#onRevoked`. Anything else is logged.
   */
  #writeFailed(what: string, err: unknown): void {
    if (isRevokedRefusal(err)) return this.#onRevoked(err);
    this.d.log.warn(what, { error: err instanceof Error ? err.message : "error" });
  }

  /**
   * This device was revoked (the daemon also stops on its next token refresh): stop publishing
   * at once. Pending approvals end as denied, every session process closes (keeping its idle and
   * delta timers from firing), link retries stop, and no more cards, events or sessions are written.
   */
  #onRevoked(err?: unknown): void {
    if (this.#revoked) return;
    this.#revoked = true;
    this.d.log.warn("agent.revoked", {
      action: "stop_publishing",
      ...(err instanceof Error ? { error: err.message } : {}),
    });
    this.approvals.revokeAll();
    void this.coordinator.stopAll("revoked");
    this.d.links?.close();
    for (const s of [...this.sessions.values()]) this.#suspend(s, "agent_revoked");
  }

  /** Agent shutdown: interrupt busy sessions, close every process, keep all of them resumable. */
  async suspendAll(): Promise<void> {
    // Plans live in memory: the agent stopping ends them (worktrees and branches stay).
    await this.coordinator.stopAll("restart").catch(() => undefined);
    for (const s of [...this.sessions.values()]) {
      if (BUSY.has(s.state)) await s.handle?.interrupt().catch(() => undefined);
      this.#suspend(s, "agent_stop");
    }
  }

  #gate(s: Session): ToolGate {
    return async (gated: ToolCall) => {
      const call = s.turnOriginFloor ? { ...gated, origin: lowerTrust(gated.origin, s.turnOriginFloor) } : gated;
      // Computer-control tools: the broker does the per-action checks (grant, indicator, rate,
      // audit); here they're refused outright when control is off, ended or denied, or the turn
      // comes from an unsigned origin. Not on the card: inputs can be typed text.
      if (call.toolName.startsWith(COMPUTER_TOOL_PREFIX)) {
        // Coordinator helpers never get computer control (owner, 2026-10-19).
        const r = s.coord
          ? { allow: false as const, reason: "coordinator_no_computer" }
          : (this.d.computer?.gate(s.sid, call.origin) ?? { allow: false as const, reason: "computer_disabled" });
        if (!r.allow) {
          s.card.blocker(`Control del equipo bloqueado (${r.reason})`);
          await this.#publishCard(s);
          return r;
        }
        // An ACP agent only reports what a call is (its title and arguments), so the name is its
        // word: each such call is asked about like any other tool, never allowed outright.
        if (ACP_KINDS.has(s.adapter)) {
          const outcome = await this.#approve(s, {
            risk: "HIGH",
            stepUp: true,
            origin: call.origin,
            details: {
              toolName: call.toolName,
              input: call.input,
              reasons: ["computer control reported by an ACP agent"],
            },
          });
          await this.#publishCard(s);
          return outcome.allow ? { allow: true } : { allow: false, reason: outcome.reason };
        }
        return r;
      }
      // Link tools (M16 F): refused unless this session has them; never Developer-mode auto-approve.
      const linkTool = call.toolName.startsWith(LINKS_TOOL_PREFIX);
      if (linkTool && !this.d.linkTools?.attached(s.sid)) {
        s.card.blocker(`Enlace bloqueado (link_tools_not_attached)`);
        await this.#publishCard(s);
        return { allow: false, reason: "link_tools_not_attached" };
      }
      const allowed = (): { allow: true } => {
        if (linkTool) this.d.linkTools?.admit(s.sid, call.toolName, call.input);
        return { allow: true };
      };
      const policy = this.d.policy.get();
      const classification = classifyToolCall(call.toolName, call.input, this.#classifyContext(policy, s));
      const decision = decide({
        classification,
        origin: call.origin,
        originAllowed: originAllowed(policy.origins, call.origin),
        devMode: linkTool ? DEVMODE_OFF : this.d.devMode.state,
        permissionMode: s.permissionMode,
      });
      // R-M10: the same sanitised, explicitly-truncated summary the approval shows.
      const summary = approvalSummary(call.toolName, call.input).summary;
      // An ACP agent's link call is named from its own report, as for computer control: asked
      // about every time (HIGH, step-up), even link_list, never allowed as a read.
      if (linkTool && ACP_KINDS.has(s.adapter) && decision.action !== "deny") {
        const outcome = await this.#approve(s, {
          risk: "HIGH",
          stepUp: true,
          origin: call.origin,
          details: { toolName: call.toolName, input: call.input, reasons: ["link tool reported by an ACP agent"] },
        });
        await this.#publishCard(s);
        return outcome.allow ? allowed() : { allow: false, reason: outcome.reason };
      }
      if (decision.action === "allow") {
        s.card.action(summary);
        if (classification.workspaceEdit) s.card.fileTouched(String(call.input.file_path ?? ""));
        return allowed();
      }
      if (decision.action === "deny") {
        s.card.blocker(`${call.toolName} bloqueado (${decision.reason})`);
        await this.#publishCard(s);
        return { allow: false, reason: decision.reason };
      }
      // Coordinator mode: Chalito answers for the owner within this computer's ceiling and the
      // owner's remembered rules; anything else still asks below.
      // Only while the plan runs, and only for the coordinator's own turns (security review): a
      // prompt the owner sent into a helper, or anything after the plan ended, asks as usual.
      if (
        s.coord &&
        !linkTool &&
        s.coord.active() &&
        !this.#coordEnded.has(s.sid) &&
        call.origin === `agent:coord_${s.coord.planId}`
      ) {
        const answer = coordAnswer({
          classification,
          toolName: call.toolName,
          input: call.input,
          workspaceLabel: s.workspaceLabel,
          branchPrefix: s.coord.branchPrefix,
          ceiling: coordinatorCeiling(policy),
          // No rules on any failure: the owner is asked, never answered for.
          rules: policy.coordinator?.enabled
            ? await this.coordRules.matches().catch(() => new Set<string>())
            : new Set<string>(),
          hash: (t) => createHash("sha256").update(t).digest("hex"),
        });
        if (answer) {
          this.#audit("coordinator.auto_allow", {
            sid: s.sid,
            planId: s.coord.planId,
            taskId: s.coord.taskId,
            toolName: call.toolName,
            tier: classification.tier,
            via: answer.via,
            ...(answer.via === "coordinator_auto" ? { kind: answer.kind } : { rule: answer.match.slice(0, 12) }),
          });
          s.card.action(summary);
          if (classification.workspaceEdit) s.card.fileTouched(String(call.input.file_path ?? ""));
          return allowed();
        }
      }
      // A helper's prompt carries its workspace label inside what the agent signs, so a "Siempre
      // así" rule is bound to it (security review), never to a plaintext column.
      const askDetails = {
        toolName: call.toolName,
        input: call.input,
        reasons: classification.reasons,
        ...(s.coord ? { workspaceLabel: s.workspaceLabel } : {}),
      };
      let outcome = await this.#approve(s, {
        risk: classification.tier,
        stepUp: decision.stepUp,
        origin: call.origin,
        details: askDetails,
      });
      // A helper's prompt that times out never becomes a yes, nor a no while the plan runs: the
      // owner is asked again (owner, 2026-10-19).
      while (
        outcome.reason === "timeout_deny" &&
        s.coord?.active() &&
        !this.#coordEnded.has(s.sid) &&
        !s.closing &&
        !this.#revoked
      ) {
        outcome = await this.#approve(s, {
          risk: classification.tier,
          stepUp: decision.stepUp,
          origin: call.origin,
          details: askDetails,
        });
      }
      if (outcome.allow) s.card.action(summary);
      await this.#publishCard(s);
      return outcome.allow ? allowed() : { allow: false, reason: outcome.reason };
    };
  }

  /**
   * Asks the person's trusted devices (signed, sealed request) and announces it: session event,
   * card, call line. Resolves with the verified outcome; no answer within the TTL is a deny.
   */
  async #approve(
    s: Session,
    input: {
      risk: RiskTier;
      stepUp: boolean;
      origin: Origin;
      kind?: "tool" | "computer_control" | "app_control" | "link_handoff";
      details: { toolName: string; input: unknown; reasons: string[]; workspaceLabel?: string };
    },
  ): Promise<ComputerApprovalOutcome> {
    let aid: string | undefined;
    // The "requested" side effects (event, card, call line) run while the approval waits. Keep
    // the promise: the resolution below must not remove the call line before it was published,
    // or a fast decision leaves a stale plaintext line behind (seen over Supabase round-trips).
    let announced: Promise<void> = Promise.resolve();
    const outcome = await this.#requestApproval({
      sid: s.sid,
      risk: input.risk,
      stepUp: input.stepUp,
      origin: input.origin,
      ...(input.kind ? { kind: input.kind } : {}),
      details: input.details,
      onRequested: (requested, expiresAt) => {
        aid = requested;
        this.#local(s.sid, {
          type: "approval",
          aid: requested,
          risk: input.risk,
          stepUp: input.stepUp,
          summary: approvalSummary(input.details.toolName, input.details.input).summary,
        });
        announced = (async () => {
          s.card.approvalPending(requested, true);
          await this.#event(s, {
            type: "approval.requested",
            aid: requested,
            risk: input.risk,
            expiresAt,
            urgency: input.risk === "HIGH" ? "high" : "normal",
          });
          await this.#publishCard(s);
          await this.callLines.publish(`${s.sid}_${requested}`, {
            notificationId: `a_${requested}`,
            sid: s.sid,
            sessionLabel: s.label,
            question: null,
          });
        })().catch((err: unknown) => {
          if (isRevokedRefusal(err)) return this.#onRevoked(err);
          this.d.log.error("approval.announce_failed", { error: err instanceof Error ? err.message : "error" });
        });
      },
    });
    await announced;
    // Revoked meanwhile: the sweep already denied it and removed its call line; write nothing.
    if (this.#revoked) return outcome;
    if (aid) {
      this.#local(s.sid, { type: "approval_done", aid, allow: outcome.allow, reason: outcome.reason });
      s.card.approvalPending(aid, false);
      await this.callLines.remove(`${s.sid}_${aid}`);
      await this.#event(s, {
        type: "approval.resolved",
        aid,
        allow: outcome.allow,
        reason: outcome.reason,
        ...(outcome.byDeviceId ? { byDeviceId: outcome.byDeviceId } : {}),
      });
    }
    return outcome;
  }

  /** `approvals.request`, where a refusal of the approval's own rows (42501) is the revoke. */
  async #requestApproval(input: Parameters<ApprovalManager["request"]>[0]): Promise<ApprovalOutcome> {
    try {
      return await this.approvals.request(input);
    } catch (err) {
      if (!isRevokedRefusal(err)) throw err;
      this.#onRevoked(err);
      return { allow: false, reason: "agent_revoked" };
    }
  }

  /**
   * A session's `computer_control` grant (computer/control.ts): HIGH, with a passkey step-up,
   * from a trusted device. The origin is the session's own, lowered by an unsigned answer.
   */
  async requestComputerApproval(
    sid: string,
    input: {
      origin: Origin;
      kind?: "computer_control" | "app_control";
      details: { toolName: string; input: unknown; reasons: string[] };
    },
  ): Promise<ComputerApprovalOutcome> {
    const s = this.sessions.get(sid);
    if (!s) return { allow: false, reason: "policy_block" };
    const origin = s.turnOriginFloor ? lowerTrust(input.origin, s.turnOriginFloor) : input.origin;
    if (!isSignedOrigin(origin)) return { allow: false, reason: "policy_block" };
    return this.#approve(s, {
      risk: "HIGH",
      stepUp: true,
      origin,
      kind: input.kind ?? "computer_control",
      details: input.details,
    });
  }

  #classifyContext(policy: Policy, s: Session): ClassifyContext {
    return {
      policy,
      home: this.d.home,
      cwd: s.cwd,
      ...this.d.classifyExtras?.(),
      onWorkspaceMoved: (label, pinned, now) => {
        // Once per workspace and target, not once per tool call.
        const key = `${label}\0${now}`;
        if (this.#movedWorkspaces.has(key)) return;
        this.#movedWorkspaces.add(key);
        this.#audit("policy.workspace_moved", { label, pinned, now });
      },
    };
  }

  #movedWorkspaces = new Set<string>();

  async #onAdapterEvent(s: Session, e: AdapterEvent): Promise<void> {
    // An idle-closed (or replaced) session's last words, e.g. "completed" after close().
    if (s.closing || this.#revoked || this.sessions.get(s.sid) !== s) return;
    s.lastActiveAt = this.d.now();
    this.#observers.get(s.sid)?.(e);
    // Hand-off tasks (links/manager.ts): projection, budget, the result back to the sender.
    if (this.d.links)
      void this.d.links
        .onAdapterEvent(s.sid, e)
        .catch((err: unknown) =>
          this.d.log.warn("link.track_failed", { error: err instanceof Error ? err.message : "error" }),
        );
    switch (e.type) {
      case "started":
        s.providerSessionId = e.providerSessionId;
        this.#persist();
        await this.d.store.upsertSession(s.sid, { providerSessionId: e.providerSessionId });
        return;
      case "assistant_delta": {
        this.#local(s.sid, { type: "delta", text: e.text });
        // Throttled (sessions.yaml live.*), broadcast only; the final text below is the message.
        const live = this.#lifecycle.live;
        if (!s.draft) {
          const draft: NonNullable<Session["draft"]> = {
            mid: randomUUID(),
            n: 0,
            throttle: new DeltaThrottle({
              flushMs: live.deltaFlushMs,
              flushChars: live.deltaFlushChars,
              schedule: (fn, ms) => this.#schedule(fn, ms),
              emit: (text) => this.#delta(s, draft, text),
            }),
          };
          s.draft = draft;
        }
        s.draft.throttle.push(e.text);
        return;
      }
      case "assistant_text": {
        this.#local(s.sid, { type: "assistant", text: e.text });
        const draft = s.draft;
        draft?.throttle.discard();
        s.draft = undefined;
        // Reserved before sealing: the seq the deltas carried, ahead of what follows (usage, idle).
        const seq = s.seq++;
        await this.#event(
          s,
          {
            type: "message.assistant",
            ...(draft ? { mid: draft.mid } : {}),
            ct: await this.sealer.seal({ text: e.text }, `event:${s.sid}`),
          },
          { seq },
        );
        return;
      }
      case "tool_started": {
        const policy = this.d.policy.get();
        const c = classifyToolCall(e.toolName, e.input, this.#classifyContext(policy, s));
        this.#local(s.sid, {
          type: "tool",
          toolUseId: e.toolUseId,
          category: c.category,
          risk: c.tier,
          summary: approvalSummary(e.toolName, e.input).summary,
        });
        await this.#event(s, {
          type: "tool.started",
          toolUseId: e.toolUseId,
          category: c.category,
          risk: c.tier,
          ct: await this.sealer.seal({ toolName: e.toolName, input: e.input }, `event:${s.sid}`),
        });
        return;
      }
      case "tool_finished":
        this.#local(s.sid, { type: "tool_done", toolUseId: e.toolUseId, ok: e.ok });
        await this.#event(s, { type: "tool.finished", toolUseId: e.toolUseId, ok: e.ok });
        return;
      case "usage":
        await this.#event(s, { type: "usage", tokIn: e.tokIn, tokOut: e.tokOut, tokCached: e.tokCacheRead });
        return;
      case "state":
        this.#local(s.sid, { type: "state", state: e.state as SessionState });
        s.state = e.state as SessionState;
        if (e.state !== "running") s.turnOriginFloor = undefined;
        if (!BUSY.has(s.state)) {
          // The turn is over: a draft without its final text is dropped.
          s.draft?.throttle.discard();
          s.draft = undefined;
        }
        this.#armIdle(s);
        this.#persist();
        if (e.state === "completed" || e.state === "failed") this.d.computer?.end(s.sid);
        s.card.state(e.state as SessionState);
        await this.#event(s, { type: "session.state", state: e.state });
        await this.d.store.upsertSession(s.sid, { state: e.state, updatedAt: this.d.now() });
        await this.#publishCard(s);
        return;
      case "error":
        this.#local(s.sid, { type: "error", code: e.code });
        await this.#event(s, { type: "error", code: e.code === "adapter_crash" ? "adapter_crash" : e.code });
        return;
    }
  }

  /**
   * One event for the person's clients. The store sends live-only types over the live path and
   * batches the rest into `session_events` (M16 A); the core doesn't wait for either, and order
   * is kept by the store. A failed write is logged.
   */
  async #event(s: Session, partial: Record<string, unknown>, opts: { seq?: number } = {}): Promise<void> {
    if (this.#revoked) return;
    const event = AgentEvent.parse({
      v: 1,
      eid: randomUUID(),
      sid: s.sid,
      deviceId: this.d.self.deviceId,
      // A caller may reserve the seq up front (before an await), so events keep their order.
      seq: opts.seq ?? s.seq++,
      t: this.d.now(),
      urgency: "low",
      ...partial,
    });
    void this.d.store.writeEvent(event).catch((err: unknown) => {
      if (isRevokedRefusal(err)) return this.#onRevoked(err);
      this.d.log.warn("event.write_failed", {
        type: event.type,
        error: err instanceof Error ? err.message : "error",
      });
    });
  }

  /** One flushed delta: sealed, numbered, sent in order (broadcast only). */
  #delta(s: Session, draft: NonNullable<Session["draft"]>, text: string): void {
    const n = draft.n++;
    const seq = s.seq;
    s.liveChain = s.liveChain
      .then(async () => {
        if (s.closing) return;
        await this.#event(
          s,
          {
            type: "message.assistant.delta",
            mid: draft.mid,
            n,
            ct: await this.sealer.seal({ text }, `event:${s.sid}`),
          },
          // A delta takes the seq its final message will have, without using it up.
          { seq },
        );
      })
      .catch((err: unknown) =>
        this.d.log.warn("event.delta_failed", { error: err instanceof Error ? err.message : "error" }),
      );
  }

  async #publishCard(s: Session): Promise<void> {
    if (this.#revoked) return;
    const card = s.card.build();
    try {
      await this.d.store.upsertSession(s.sid, {
        card: { ct: await this.sealer.seal(card, `card:${s.sid}`) },
        updatedAt: this.d.now(),
      });
    } catch (err) {
      // Revoked: an expected end, not a failure for the caller (a tool gate, a question).
      if (isRevokedRefusal(err)) return this.#onRevoked(err);
      throw err;
    }
    // MCP card sharing (opt-in, default off): the same redacted card, in plaintext, only while on.
    try {
      if (await this.d.store.mcpSharingOn(s.sid)) await this.d.store.writeSharedCard(s.sid, card);
    } catch (err) {
      this.d.log.warn("card.share_failed", { sid: s.sid, error: err instanceof Error ? err.message : "error" });
    }
  }

  /** A passkey step-up over this command by its signer; unlike a revoke, required even with no passkey enrolled. */
  async #passkeyFailure(signer: string | null, body: CommandBody | undefined): Promise<string | null> {
    const trust = this.d.trust();
    const credential = signer ? trust.webauthnFor(signer) : undefined;
    if (!credential) return "step_up_required";
    const step = body?.stepUp;
    if (!body || !step || step.method !== "webauthn" || !step.assertion || step.bundle) return "step_up_required";
    const res = await verifyWebAuthnAssertion({
      assertion: step.assertion,
      credential,
      expectedChallenge: await stepUpChallenge(body),
      rpId: credential.rpId,
      origin: [`https://${credential.rpId}`],
    });
    if (!res.ok) return `step_up_${res.reason}`;
    if (!trust.acceptSignCount(signer!, res.signCount)) return "step_up_replayed";
    await this.d.saveTrust();
    return null;
  }

  async #revokeStepUpFailure(signer: string | null, body: CommandBody | undefined): Promise<string | null> {
    const trust = this.d.trust();
    const anyPasskey = trust.toJSON().some((c) => c.webauthn !== undefined);
    if (!anyPasskey) return null;
    const credential = signer ? trust.webauthnFor(signer) : undefined;
    if (!credential) return "step_up_required";
    const step = body?.stepUp;
    if (!body || !step || step.method !== "webauthn" || !step.assertion) return "step_up_required";
    // ADR 0020: a revoke-all signs one bundle of body hashes; this command must be in it.
    const bundle = step.bundle;
    if (bundle && !bundle.includes(await stepUpBodyHash(body))) return "step_up_not_in_bundle";
    const res = await verifyWebAuthnAssertion({
      assertion: step.assertion,
      credential,
      expectedChallenge: bundle ? await revokeBundleChallenge(bundle) : await stepUpChallenge(body),
      rpId: credential.rpId,
      origin: [`https://${credential.rpId}`],
    });
    if (!res.ok) return `step_up_${res.reason}`;
    // A monotonic sign counter per client: an older assertion (a withheld command from an old
    // bundle) is refused once this client's passkey signed something newer here.
    if (!trust.acceptSignCount(signer!, res.signCount, bundle ? await revokeBundleId(bundle) : undefined))
      return "step_up_replayed";
    await this.d.saveTrust();
    return null;
  }

  /** Logged with the internal reason here; the audit row (closed reason) comes from #publishResult. */
  #reject(id: string, reason: string): { ok: false; reason: string } {
    this.d.log.warn("command.rejected", { id, reason });
    return { ok: false, reason };
  }

  /** Logs and writes the durable audit trail (fire-and-forget; a failed write is logged, never thrown). */
  #audit(type: string, meta: Record<string, unknown>): void {
    this.d.log.warn(type, meta);
    void this.d.store
      .audit({
        eid: randomUUID(),
        t: this.d.now(),
        type,
        meta: redactDeep(meta) as Record<string, unknown>,
        source: "agent",
      })
      .catch((err: unknown) =>
        this.d.log.error("audit write failed", { type, error: err instanceof Error ? err.message : "error" }),
      );
  }

  /** policyHash helper for reporting. */
  static hash(p: Policy): string {
    return policyHash(p);
  }
}
