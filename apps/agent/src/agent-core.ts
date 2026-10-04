import { randomUUID } from "node:crypto";
import {
  openJson,
  type BoxKeyPair,
  type NonceStore,
  type SigningKeyPair,
  type TrustedClientList,
} from "@chalito/crypto";
import type { AdapterEvent, SessionAdapter, SessionHandle, ToolCall, ToolGate } from "@chalito/adapters";
import {
  AgentEvent,
  CommandEnvelope,
  isSignedOrigin,
  type AdapterKind,
  type CommandBody,
  type CommandPayload,
  type Origin,
  type RemotePermissionMode,
  type SealedEnvelope,
  type SessionState,
  approvalSummary,
} from "@chalito/protocol";
import { ApprovalManager } from "./approvals.js";
import { CallLinePublisher } from "./call-lines.js";
import { CardBuilder } from "./card.js";
import type { DevMode } from "./devmode.js";
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
export interface PolicyHolder {
  get(): Policy;
  set(p: Policy, via: "local" | "remote_tighten" | "preset_accepted"): Promise<void>;
}

export interface AgentCoreDeps {
  store: AgentStore;
  adapters: Partial<Record<AdapterKind, SessionAdapter>>;
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
}

interface Session {
  sid: string;
  adapter: AdapterKind;
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

const originTrust = (o: Origin) => (o === "local" ? 2 : isSignedOrigin(o) ? 1 : 0);
const lowerTrust = (a: Origin, b: Origin): Origin => (originTrust(b) < originTrust(a) ? b : a);

const REMOTE_ENABLE_ATTEMPT =
  /devmode\.(on|enable|toggleOn)|policy\.(loosen|set)|trust\.add|bypass|dontAsk|\bauto\b|dangerous|danger-full-access/i;

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

  async handleCommand(id: string, doc: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> {
    try {
      return await this.#handle(id, doc);
    } catch (err) {
      this.d.log.error("command failed", { id, error: err instanceof Error ? err.message : "error" });
      return { ok: false, reason: "internal" };
    } finally {
      await this.d.store.deleteCommand(id).catch(() => undefined);
    }
  }

  async #handle(id: string, doc: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> {
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
      this.#audit("command.rejected", { id, reason: "invalid" });
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

    return this.#dispatch(body.cid, body.payload, body.origin);
  }

  async #dispatch(cid: string, p: CommandPayload, origin: Origin): Promise<{ ok: boolean; reason?: string }> {
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
        const adapter = this.d.adapters[p.adapter];
        const enabled =
          p.adapter === "claude-code"
            ? policy.adapters.claudeCode
            : p.adapter === "codex"
              ? policy.adapters.codex
              : false;
        if (!adapter || !enabled) return this.#reject(cid, "adapter_disabled");
        const prompt = await open<string>(p.promptCt);
        await this.startSession({
          adapter: p.adapter,
          workspace: ws,
          prompt,
          origin,
          permissionMode: p.permissionMode,
        });
        return { ok: true };
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
        this.d.trust().remove(p.clientDeviceId);
        await this.d.saveTrust();
        for (const s of this.sessions.values())
          if (s.startedBy === `client:${p.clientDeviceId}`) await s.handle.interrupt();
        this.#audit("trust.client_removed", { clientDeviceId: p.clientDeviceId, by: origin });
        return { ok: true };
      }
    }
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

    session.handle = await this.d.adapters[input.adapter]!.start({
      sid,
      cwd: session.cwd,
      prompt: input.prompt,
      origin: input.origin,
      permissionMode: input.permissionMode,
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
      let aid: string | undefined;
      // The "requested" side effects (event, card, call line) run while the approval waits. Keep
      // the promise: the resolution below must not remove the call line before it was published,
      // or a fast decision leaves a stale plaintext line behind (seen over Supabase round-trips).
      let announced: Promise<void> = Promise.resolve();
      const outcome = await this.approvals.request({
        sid: s.sid,
        risk: classification.tier,
        stepUp: decision.stepUp,
        origin: call.origin,
        details: { toolName: call.toolName, input: call.input, reasons: classification.reasons },
        onRequested: (requested, expiresAt) => {
          aid = requested;
          announced = (async () => {
            s.card.approvalPending(requested, true);
            await this.#event(s, {
              type: "approval.requested",
              aid: requested,
              risk: classification.tier,
              expiresAt,
              urgency: classification.tier === "HIGH" ? "high" : "normal",
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
      if (outcome.allow) s.card.action(summary);
      await this.#publishCard(s);
      return outcome.allow ? { allow: true } : { allow: false, reason: outcome.reason };
    };
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
  }

  #reject(id: string, reason: string): { ok: false; reason: string } {
    this.#audit("command.rejected", { id, reason });
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
