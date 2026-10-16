import { randomUUID } from "node:crypto";
import {
  openJson,
  revokeBundleChallenge,
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
  Id,
  TerminalData,
  type CommandAcceptedMeta,
  type CommandRejectedMeta,
  isSignedOrigin,
  type AdapterKind,
  type CommandBody,
  type CommandPayload,
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
} from "@chalito/protocol";
import { SESSIONS_DEFAULTS, type SessionsConfig } from "@chalito/config";
import { ApprovalManager } from "./approvals.js";
import { CallLinePublisher } from "./call-lines.js";
import { CardBuilder } from "./card.js";
import { publicReason } from "./command-result.js";
import type { ComputerApprovalOutcome, ComputerControl } from "./computer/control.js";
import { COMPUTER_TOOL_PREFIX } from "./computer/tools.js";
import type { DevMode } from "./devmode.js";
import { DeltaThrottle } from "./live/deltas.js";
import type { LinkHost, LinkManager } from "./links/manager.js";
import type { ScreenManager } from "./screen/manager.js";
import {
  PERMISSION_RANK,
  SANDBOX_RANK,
  applyRemoteTighten,
  classifyToolCall,
  decide,
  originAllowed,
  policyHash,
  presetPolicy,
  type ClassifyContext,
  type Policy,
} from "./policy/index.js";
import { redact, redactDeep, type Logger } from "./redact.js";
import { Sealer } from "./sealing.js";
import { pruneRecords, type SessionRecord, type SessionRegistry } from "./session-registry.js";
import type { AgentStore } from "./store.js";

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
  classifyExtras?: () => { agentBinaries: string[]; protectedPaths: string[]; pathDirs: string[] };
  /** Computer control (computer/control.ts); absent = never attached. */
  computer?: ComputerControl;
  /** Remote terminal (terminal/control.ts); absent = terminal.* refused. */
  terminal?: TerminalCommands;
  /** Remote screen (screen/manager.ts); absent = `screen.*` commands are refused. */
  screen?: ScreenManager;
  /** M16 A: idle-close, live cap and delta flushing (packages/config sessions.yaml). */
  sessionsConfig?: Pick<SessionsConfig, "session" | "live">;
  /** M16 A: where sessions are remembered for resume (~/.chalito/sessions.json); absent = memory only. */
  registry?: SessionRegistry;
  /** Agent-to-agent links (links/manager.ts, ADR 0022 §3); absent = `link.*` commands are refused. */
  links?: LinkManager;
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
  /** The assistant message being streamed (`message.assistant.delta`), until its final text. */
  draft?: { mid: string; n: number; throttle: DeltaThrottle };
  /** Deltas are sealed and sent in order. */
  liveChain: Promise<void>;
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

const originTrust = (o: Origin) => (o === "local" ? 2 : isSignedOrigin(o) ? 1 : 0);
const lowerTrust = (a: Origin, b: Origin): Origin => (originTrust(b) < originTrust(a) ? b : a);

const REMOTE_ENABLE_ATTEMPT =
  /devmode\.(on|enable|toggleOn)|computer|remoteTerminal|rawShell|(terminal|shell)\.(enable|on)|screen\.(enable|on|grant|allow)|remote_?(view|control)|app_?control|policy\.(loosen|set)|trust\.add|bypass|dontAsk|\bauto\b|dangerous|danger-full-access|apps?\.(custom|enable)|recipe\.(enable|add)|link\.create:handoff/i;

/**
 * The device agent's brain (ADR 0008): verifies commands against the local trusted list,
 * runs sessions through adapters, gates every tool call with local policy + signed
 * approvals, and reports typed, sealed events.
 */
export class AgentCore {
  readonly sessions = new Map<string, Session>();
  /** Sessions without a process that a prompt or `session.resume` reopens (M16 A). */
  readonly #dormant = new Map<string, Dormant>();
  readonly approvals: ApprovalManager;
  readonly callLines: CallLinePublisher;
  readonly sealer: Sealer;
  pendingPreset: "estricto" | "estandar" | "relajado" | null = null;

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
    d.links?.attach(this.#linkHost());
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
            typeof body.origin === "string" && /^(local|client:|mcp:|call:)/.test(body.origin)
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

    switch (p.type) {
      case "session.start": {
        const ws = policy.workspaces.find((w) => w.label === p.workspaceLabel);
        if (!ws) return this.#reject(cid, "unknown_workspace");
        if (aboveCeiling(p.permissionMode)) return this.#reject(cid, "permission_mode_above_ceiling");
        if (sandboxAboveCeiling(p.codexSandbox)) return this.#reject(cid, "codex_sandbox_above_ceiling");
        const target = await this.#sessionTarget(p.adapter, p.appId);
        if (!target.ok) return this.#reject(cid, target.reason);
        const prompt = await open<string>(p.promptCt);
        if (!(await this.#makeRoom())) return this.#reject(cid, "session_limit");
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
        const s = this.sessions.get(p.sid);
        if (!s) {
          if (!this.#dormant.has(p.sid)) return this.#reject(cid, "unknown_session");
          const text = await open<string>(p.promptCt);
          return this.#revive(cid, p.sid, this.#withLinkData(p.sid, text, origin), origin);
        }
        const text = await open<string>(p.promptCt);
        await this.#event(s, { type: "message.user", origin, ct: await this.sealer.seal({ text }, `event:${s.sid}`) });
        this.#prompt(s, this.#withLinkData(s.sid, text, origin), origin);
        return { ok: true };
      }
      case "session.interrupt": {
        const s = this.sessions.get(p.sid);
        if (!s) return this.#dormant.has(p.sid) ? { ok: true } : this.#reject(cid, "unknown_session");
        await s.handle.interrupt();
        return { ok: true };
      }
      case "session.resume": {
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
        if (body?.stepUp?.bundle) await this.d.links?.revokeAll("revoke_all");
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
        return { ok: true };
      case "link.list":
        if (!this.d.links) return this.#reject(cid, "links_disabled");
        await this.d.links.publish();
        return { ok: true };
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
  #linkHost(): LinkHost {
    const info = (s: Session) => ({
      sid: s.sid,
      cwd: s.cwd,
      workspaceLabel: s.workspaceLabel,
      permissionMode: s.permissionMode,
      ...(s.appId ? { appId: s.appId } : {}),
    });
    return {
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
      startSession: async (input) => {
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
        if (s) await this.#event(s, partial);
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
          : await this.approvals.request({
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
    };
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
      session.handle = await adapter.start({
        sid,
        cwd: session.cwd,
        prompt: input.prompt,
        origin: input.origin,
        permissionMode: input.permissionMode,
        ...(resume?.providerSessionId ? { resume: resume.providerSessionId } : {}),
        ...(computer
          ? { mcpServers: { [computer.name]: { command: computer.command, args: computer.args, env: computer.env } } }
          : {}),
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
        onEvent: (e) => void this.#onAdapterEvent(session, e),
      });
    } catch (err) {
      // Nothing runs: forget the live session (a resumable one goes back to waiting).
      this.d.computer?.end(sid);
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
    // Never learned a provider session (it failed at start): a prompt starts afresh in the same sid.
    if (!r.providerSessionId && !prompt) return { ok: true, sid };
    if (!(await this.#makeRoom())) return this.#reject(cid, "session_limit");
    try {
      await this.startSession({
        adapter: target.adapter,
        ...(target.appId ? { appId: target.appId } : {}),
        ...(target.appAdapter ? { appAdapter: target.appAdapter } : {}),
        workspace: ws,
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
  async #makeRoom(): Promise<boolean> {
    const max = this.#lifecycle.session.maxLivePerDevice;
    const live = [...this.sessions.values()].filter((s) => !s.closing);
    if (live.length < max) return true;
    const idle = live.filter((s) => !BUSY.has(s.state)).sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    for (const s of idle.slice(0, live.length - max + 1)) this.#suspend(s, "session_limit");
    return idle.length >= live.length - max + 1;
  }

  /** (Re)arms the idle-close timer of a session that isn't busy. */
  #armIdle(s: Session): void {
    s.idleTimer?.clear();
    s.idleTimer = undefined;
    if (BUSY.has(s.state) || s.closing) return;
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
  #suspend(s: Session, reason: "idle" | "session_limit" | "agent_stop"): void {
    if (s.closing) return;
    s.closing = true;
    s.idleTimer?.clear();
    s.idleTimer = undefined;
    s.draft?.throttle.discard();
    s.draft = undefined;
    this.d.computer?.end(s.sid);
    if (this.sessions.get(s.sid) === s) this.sessions.delete(s.sid);
    this.#dormant.set(s.sid, { record: this.#record(s, false), card: s.card });
    try {
      s.handle?.close();
    } catch {
      /* already closed */
    }
    this.#persist();
    this.d.log.info("session.closed", { sid: s.sid, reason });
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

  /** Agent shutdown: interrupt busy sessions, close every process, keep all of them resumable. */
  async suspendAll(): Promise<void> {
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
        const r = this.d.computer?.gate(s.sid, call.origin) ?? { allow: false as const, reason: "computer_disabled" };
        if (!r.allow) {
          s.card.blocker(`Control del equipo bloqueado (${r.reason})`);
          await this.#publishCard(s);
        }
        return r;
      }
      const policy = this.d.policy.get();
      const classification = classifyToolCall(call.toolName, call.input, this.#classifyContext(policy, s));
      const decision = decide({
        classification,
        origin: call.origin,
        originAllowed: originAllowed(policy.origins, call.origin),
        devMode: this.d.devMode.state,
        permissionMode: s.permissionMode,
      });
      // R-M10: the same sanitised, explicitly-truncated summary the approval shows.
      const summary = approvalSummary(call.toolName, call.input).summary;
      if (decision.action === "allow") {
        s.card.action(summary);
        if (classification.workspaceEdit) s.card.fileTouched(String(call.input.file_path ?? ""));
        return { allow: true };
      }
      if (decision.action === "deny") {
        s.card.blocker(`${call.toolName} bloqueado (${decision.reason})`);
        await this.#publishCard(s);
        return { allow: false, reason: decision.reason };
      }
      const outcome = await this.#approve(s, {
        risk: classification.tier,
        stepUp: decision.stepUp,
        origin: call.origin,
        details: { toolName: call.toolName, input: call.input, reasons: classification.reasons },
      });
      if (outcome.allow) s.card.action(summary);
      await this.#publishCard(s);
      return outcome.allow ? { allow: true } : { allow: false, reason: outcome.reason };
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
      details: { toolName: string; input: unknown; reasons: string[] };
    },
  ): Promise<ComputerApprovalOutcome> {
    let aid: string | undefined;
    // The "requested" side effects (event, card, call line) run while the approval waits. Keep
    // the promise: the resolution below must not remove the call line before it was published,
    // or a fast decision leaves a stale plaintext line behind (seen over Supabase round-trips).
    let announced: Promise<void> = Promise.resolve();
    const outcome = await this.approvals.request({
      sid: s.sid,
      risk: input.risk,
      stepUp: input.stepUp,
      origin: input.origin,
      ...(input.kind ? { kind: input.kind } : {}),
      details: input.details,
      onRequested: (requested, expiresAt) => {
        aid = requested;
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
        })().catch((err: unknown) =>
          this.d.log.error("approval.announce_failed", { error: err instanceof Error ? err.message : "error" }),
        );
      },
    });
    await announced;
    if (aid) {
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
    return { policy, home: this.d.home, cwd: s.cwd, ...this.d.classifyExtras?.() };
  }

  async #onAdapterEvent(s: Session, e: AdapterEvent): Promise<void> {
    // An idle-closed (or replaced) session's last words, e.g. "completed" after close().
    if (s.closing || this.sessions.get(s.sid) !== s) return;
    s.lastActiveAt = this.d.now();
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
        await this.#event(s, { type: "tool.finished", toolUseId: e.toolUseId, ok: e.ok });
        return;
      case "usage":
        await this.#event(s, { type: "usage", tokIn: e.tokIn, tokOut: e.tokOut, tokCached: e.tokCacheRead });
        return;
      case "state":
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
    void this.d.store.writeEvent(event).catch((err: unknown) =>
      this.d.log.warn("event.write_failed", {
        type: event.type,
        error: err instanceof Error ? err.message : "error",
      }),
    );
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
    const card = s.card.build();
    await this.d.store.upsertSession(s.sid, {
      card: { ct: await this.sealer.seal(card, `card:${s.sid}`) },
      updatedAt: this.d.now(),
    });
    // MCP card sharing (opt-in, default off): the same redacted card, in plaintext, only while on.
    try {
      if (await this.d.store.mcpSharingOn(s.sid)) await this.d.store.writeSharedCard(s.sid, card);
    } catch (err) {
      this.d.log.warn("card.share_failed", { sid: s.sid, error: err instanceof Error ? err.message : "error" });
    }
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
