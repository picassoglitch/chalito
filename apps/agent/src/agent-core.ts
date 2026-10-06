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
import { ApprovalManager } from "./approvals.js";
import { CallLinePublisher } from "./call-lines.js";
import { CardBuilder } from "./card.js";
import { publicReason } from "./command-result.js";
import type { ComputerApprovalOutcome, ComputerControl } from "./computer/control.js";
import { COMPUTER_TOOL_PREFIX } from "./computer/tools.js";
import type { DevMode } from "./devmode.js";
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
}

/** Adapters that get the computer-control MCP server (see startSession). */
const COMPUTER_ADAPTERS: ReadonlySet<AdapterKind> = new Set<AdapterKind>(["claude-code", "codex"]);

const originTrust = (o: Origin) => (o === "local" ? 2 : isSignedOrigin(o) ? 1 : 0);
const lowerTrust = (a: Origin, b: Origin): Origin => (originTrust(b) < originTrust(a) ? b : a);

const REMOTE_ENABLE_ATTEMPT =
  /devmode\.(on|enable|toggleOn)|computer|remoteTerminal|rawShell|(terminal|shell)\.(enable|on)|screen\.(enable|on|grant|allow)|remote_?(view|control)|app_?control|policy\.(loosen|set)|trust\.add|bypass|dontAsk|\bauto\b|dangerous|danger-full-access|apps?\.(custom|enable)|recipe\.(enable|add)/i;

/**
 * The device agent's brain (ADR 0008): verifies commands against the local trusted list,
 * runs sessions through adapters, gates every tool call with local policy + signed
 * approvals, and reports typed, sealed events.
 */
export class AgentCore {
  readonly sessions = new Map<string, Session>();
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
        payload?: { type?: unknown; permissionMode?: unknown; codexSandbox?: unknown };
        origin?: unknown;
      };
      const attempted = [body.payload?.type, body.payload?.permissionMode, body.payload?.codexSandbox]
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
        if (!s) return this.#reject(cid, "unknown_session");
        const text = await open<string>(p.promptCt);
        await this.#event(s, { type: "message.user", origin, ct: await this.sealer.seal({ text }, `event:${s.sid}`) });
        s.handle.prompt(text, origin);
        return { ok: true };
      }
      case "session.interrupt": {
        const s = this.sessions.get(p.sid);
        if (!s) return this.#reject(cid, "unknown_session");
        await s.handle.interrupt();
        return { ok: true };
      }
      case "session.resume": {
        const s = this.sessions.get(p.sid);
        if (!s) return this.#reject(cid, "unknown_session");
        if (p.promptCt) s.handle.prompt(await open<string>(p.promptCt), origin);
        return { ok: true };
      }
      case "session.setPermissionMode": {
        const s = this.sessions.get(p.sid);
        if (!s) return this.#reject(cid, "unknown_session");
        if (aboveCeiling(p.permissionMode)) return this.#reject(cid, "permission_mode_above_ceiling");
        if (sandboxAboveCeiling(p.codexSandbox)) return this.#reject(cid, "codex_sandbox_above_ceiling");
        await s.handle.setPermissionMode(p.permissionMode);
        s.permissionMode = p.permissionMode;
        await this.d.store.upsertSession(s.sid, { permissionMode: p.permissionMode });
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
    }
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
    return { ok: true, adapter: adapter ?? "acp", appId, appAdapter };
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
  }): Promise<string> {
    const sid = input.sid ?? randomUUID();
    const card = new CardBuilder(
      { sid, adapter: input.adapter, label: input.workspace.label, workspaceLabel: input.workspace.label },
      this.d.now,
    );
    card.goal(input.prompt);
    const session: Session = {
      sid,
      adapter: input.adapter,
      ...(input.appId ? { appId: input.appId } : {}),
      cwd: input.workspace.path,
      label: input.workspace.label,
      workspaceLabel: input.workspace.label,
      startedBy: input.origin,
      permissionMode: input.permissionMode,
      handle: undefined as unknown as SessionHandle,
      card,
      seq: 0,
      questions: new Map(),
    };
    this.sessions.set(sid, session);
    await this.d.store.upsertSession(sid, {
      deviceId: this.d.self.deviceId,
      adapter: input.adapter,
      // Engine: chalito.sessions.kind / app_id are generated from these (migration 20261006000300).
      kind: "agent",
      ...(input.appId ? { appId: input.appId } : {}),
      label: session.label,
      cwdLabel: session.workspaceLabel,
      state: "starting",
      permissionMode: input.permissionMode,
      updatedAt: this.d.now(),
    });
    await this.#event(session, {
      type: "session.started",
      adapter: input.adapter,
      origin: input.origin,
      permissionMode: input.permissionMode,
    });

    // Computer control: only when the person turned it on here, for signed origins, with the
    // desktop app running. Its tools stay inert until this session's computer_control approval.
    // Claude Code and Codex only: the ACP agents (Grok Build, Gemini CLI) name and permission MCP
    // tool calls their own way, which the gate can't recognise yet, so they don't get it.
    const computer =
      COMPUTER_ADAPTERS.has(input.adapter) && !input.appAdapter
        ? this.d.computer?.attach(sid, {
            label: session.label,
            adapter: input.adapter,
            origin: input.origin,
          })
        : null;
    session.handle = await (input.appAdapter ?? this.d.adapters[input.adapter]!).start({
      sid,
      cwd: session.cwd,
      prompt: input.prompt,
      origin: input.origin,
      permissionMode: input.permissionMode,
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
    return sid;
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
      kind?: "tool" | "computer_control" | "app_control";
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
    switch (e.type) {
      case "started":
        s.providerSessionId = e.providerSessionId;
        await this.d.store.upsertSession(s.sid, { providerSessionId: e.providerSessionId });
        return;
      case "assistant_text":
        await this.#event(s, {
          type: "message.assistant",
          ct: await this.sealer.seal({ text: e.text }, `event:${s.sid}`),
        });
        return;
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
        if (e.state !== "running") s.turnOriginFloor = undefined;
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

  async #event(s: Session, partial: Record<string, unknown>): Promise<void> {
    const event = AgentEvent.parse({
      v: 1,
      eid: randomUUID(),
      sid: s.sid,
      deviceId: this.d.self.deviceId,
      seq: s.seq++,
      t: this.d.now(),
      urgency: "low",
      ...partial,
    });
    await this.d.store.writeEvent(event);
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
