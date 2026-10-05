import {
  APPROVAL_TTL_MS,
  COMMAND_TTL_MS,
  CommandBody,
  DecisionBody,
  type AdapterKind,
  type Channel,
  type CommandPayload,
  type DevModeToggle,
  type RemoteCodexSandbox,
  type RemotePermissionMode,
} from "@chalito/protocol";
import type { ClientKeys, StepUpProvider } from "./keys.js";
import type { LiveStore } from "./live.js";
import { writeWithRetry, type RetryOptions, type SupaClient } from "./supa.js";

export class ActionError extends Error {
  override name = "ActionError";
  constructor(
    readonly code:
      | "unknown_approval"
      | "not_pending"
      | "expired"
      | "step_up_cancelled"
      | "unknown_session"
      | "untrusted_agent"
      | "not_allowed"
      /** ADR 0019: the agent's signed request didn't verify here; only a deny is possible. */
      | "unverified_request"
      | "bad_choice",
    message?: string,
  ) {
    super(message ?? code);
  }
}

/**
 * The only command types a remote client may send. Developer mode and its toggles can be
 * turned OFF from here, never on: there is no payload for it in the protocol and no method
 * for it below (brief §5 M3/M5).
 */
const CLIENT_COMMANDS = new Set<CommandPayload["type"]>([
  "session.start",
  "session.prompt",
  "session.interrupt",
  "session.resume",
  "session.setPermissionMode",
  "session.answer",
  "devmode.off",
  "devmode.toggleOff",
  "device.revokeClient",
]);

const b64Nonce = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** The api call revokeAll makes (an ApiClient from @chalito/client-keys fits). */
export interface RevokeAllApi {
  post<T = unknown>(path: string, body: unknown): Promise<T>;
}

export interface RevokeAllResult {
  /** Clients the server revoked (and banned). */
  revoked: string[];
  commandsQueued: number;
  /** Command ids the server refused. */
  refused: string[];
  /** Clients whose Auth ban failed (still revoked; logged server-side). */
  banFailed: string[];
  /** Computers this device sent a signed revoke to. */
  notified: string[];
  /** Computers this device doesn't trust (no command from here). */
  untrusted: string[];
}

export interface ClientActionsOptions {
  stepUp: StepUpProvider;
  now?: () => number;
  /** Commands expire this long after issue (≤ 10 min, the protocol cap). */
  commandTtlMs?: number;
  retry?: RetryOptions;
  /** Ids for commands; defaults to crypto.randomUUID without dashes. */
  newId?: () => string;
}

/**
 * Everything a trusted client can DO, as signed rows written under RLS:
 * - decide: a signed Decision inserted into `approval_decisions` (insert-only; each attempt a row);
 * - commands: signed envelopes into `commands`, with any text sealed to the target agent's
 *   locally trusted box key (AAD `command:<cid>`);
 * - ackNotification.
 */
export class ClientActions {
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #newId: () => string;

  constructor(
    private readonly db: SupaClient,
    private readonly keys: ClientKeys,
    private readonly live: LiveStore,
    private readonly opts: ClientActionsOptions,
  ) {
    this.#now = opts.now ?? Date.now;
    this.#ttl = Math.min(opts.commandTtlMs ?? 5 * 60 * 1000, COMMAND_TTL_MS);
    this.#newId = opts.newId ?? (() => crypto.randomUUID().replace(/-/g, ""));
  }

  // ---- approvals --------------------------------------------------------------------

  /**
   * Signs and inserts this device's decision. HIGH/CRITICAL (or any approval marked
   * step-up) first asks the step-up provider (WebAuthn / biometric); cancelling sends nothing.
   */
  async decide(aid: string, allow: boolean, opts: { choice?: number } = {}): Promise<void> {
    const a = this.live.approval(aid);
    if (!a) throw new ActionError("unknown_approval");
    if (a.status !== "pending") throw new ActionError("not_pending");
    // ADR 0019 (R-H1): only what the agent signed can be allowed; a deny is always possible.
    // A Mesa decision has no agent: the orchestrator verifies the signed answer, and allowing it
    // means picking one of its options.
    if (allow && !a.verified && !a.mesa) throw new ActionError("unverified_request");
    if (allow && a.mesa && (opts.choice === undefined || opts.choice < 0 || opts.choice >= a.mesa.options.length))
      throw new ActionError("bad_choice");
    const now = this.#now();
    if (a.expiresAt <= now) throw new ActionError("expired");

    // The unsigned body first: a passkey step-up is bound to it (D-019: the WebAuthn challenge
    // is SHA-256(JCS(body without stepUp))), so it must be final before the ceremony.
    const base = DecisionBody.parse({
      v: 1,
      aid,
      requestId: a.requestId,
      uid: this.live.owner,
      targetDeviceId: a.agentDeviceId,
      allow,
      nonce: b64Nonce(),
      issuedAt: now,
      expiresAt: Math.min(a.expiresAt, now + APPROVAL_TTL_MS),
      ...(a.detailsHash ? { detailsHash: a.detailsHash } : {}),
      ...(opts.choice !== undefined ? { choice: opts.choice } : {}),
    });
    let body = base;
    if (allow && (a.stepUpRequired || a.risk === "HIGH" || a.risk === "CRITICAL")) {
      const stepUp = await this.opts.stepUp({ aid, risk: a.risk, agentDeviceId: a.agentDeviceId }, { ...base });
      if (!stepUp) throw new ActionError("step_up_cancelled");
      body = DecisionBody.parse({ ...base, stepUp });
    }
    const decision = await this.keys.sign("chalito.decision.v1", body);
    await writeWithRetry(
      "decide",
      () =>
        this.db
          .from("approval_decisions")
          .insert({ owner: this.live.owner, aid, signer_device_id: this.keys.deviceId, decision }),
      this.opts.retry,
    );
  }

  // ---- sessions ---------------------------------------------------------------------

  async startSession(input: {
    agentDeviceId: string;
    adapter: AdapterKind;
    workspaceLabel: string;
    prompt: string;
    permissionMode?: RemotePermissionMode;
    codexSandbox?: RemoteCodexSandbox;
  }): Promise<string> {
    return this.#command(input.agentDeviceId, async (cid) => ({
      type: "session.start",
      adapter: input.adapter,
      workspaceLabel: input.workspaceLabel,
      promptCt: await this.#sealFor(input.agentDeviceId, input.prompt, cid),
      permissionMode: input.permissionMode ?? "default",
      ...(input.codexSandbox ? { codexSandbox: input.codexSandbox } : {}),
    }));
  }

  async prompt(sid: string, text: string): Promise<string> {
    const agent = this.#agentOf(sid);
    return this.#command(agent, async (cid) => ({
      type: "session.prompt",
      sid,
      promptCt: await this.#sealFor(agent, text, cid),
    }));
  }

  async interrupt(sid: string): Promise<string> {
    return this.#command(this.#agentOf(sid), async () => ({ type: "session.interrupt", sid }));
  }

  async resume(sid: string, text?: string): Promise<string> {
    const agent = this.#agentOf(sid);
    return this.#command(agent, async (cid) => ({
      type: "session.resume",
      sid,
      ...(text !== undefined ? { promptCt: await this.#sealFor(agent, text, cid) } : {}),
    }));
  }

  async setPermissionMode(sid: string, mode: RemotePermissionMode, codexSandbox?: RemoteCodexSandbox): Promise<string> {
    return this.#command(this.#agentOf(sid), async () => ({
      type: "session.setPermissionMode",
      sid,
      permissionMode: mode,
      ...(codexSandbox ? { codexSandbox } : {}),
    }));
  }

  async answer(sid: string, questionId: string, answers: Record<string, string | string[]>): Promise<string> {
    const agent = this.#agentOf(sid);
    return this.#command(agent, async (cid) => ({
      type: "session.answer",
      sid,
      questionId,
      answerCt: await this.#sealFor(agent, answers, cid),
    }));
  }

  // ---- device safety (off only) -----------------------------------------------------

  async devmodeOff(agentDeviceId: string): Promise<string> {
    return this.#command(agentDeviceId, async () => ({ type: "devmode.off" }));
  }

  async devmodeToggleOff(agentDeviceId: string, toggle: DevModeToggle): Promise<string> {
    return this.#command(agentDeviceId, async () => ({ type: "devmode.toggleOff", toggle }));
  }

  /**
   * Revoking ANOTHER client asks for this device's passkey (step-up over the command, review
   * R-L1); revoking itself doesn't.
   */
  async revokeClient(agentDeviceId: string, clientDeviceId: string): Promise<string> {
    return this.#command(
      agentDeviceId,
      async () => ({ type: "device.revokeClient", clientDeviceId }),
      this.#revokeStepUp(agentDeviceId, clientDeviceId),
    );
  }

  #revokeStepUp(agentDeviceId: string, clientDeviceId: string) {
    if (clientDeviceId === this.keys.deviceId) return undefined;
    return async (unsigned: Record<string, unknown>) => {
      const stepUp = await this.opts.stepUp({ aid: `revoke:${clientDeviceId}`, risk: "HIGH", agentDeviceId }, unsigned);
      // No passkey on this device: send it plain; agents accept that only while no trusted
      // client has a passkey at all.
      return stepUp ?? undefined;
    };
  }

  /**
   * "Cerrar sesión en todos los demás dispositivos" (POST /v1/devices/revoke-all, -41's api): the
   * server revokes and bans every other client at once after this device's passkey assertion
   * (`stepUp`: over a server challenge). Agents keep their own trust lists, so this device also
   * signs one `device.revokeClient` per (computer it trusts, other active client), each with its
   * own step-up like revokeClient (R-L1), and the api queues them. Computers this device doesn't
   * trust can't get a command from here (`untrusted`).
   */
  async revokeAll(o: { api: RevokeAllApi; stepUp: () => Promise<unknown> }): Promise<RevokeAllResult> {
    const devices = this.live.getSnapshot().devices.filter((d) => !d.revoked);
    const clients = devices
      .filter((d) => d.role === "client" && d.deviceId !== this.keys.deviceId)
      .map((d) => d.deviceId);
    const agents = devices.filter((d) => d.role === "agent").map((d) => d.deviceId);
    const trusted = agents.filter((a) => this.keys.trustedAgentBoxKey(a));
    const commands = [];
    for (const agent of trusted)
      for (const clientDeviceId of clients)
        commands.push(
          (
            await this.#signCommand(
              agent,
              async () => ({ type: "device.revokeClient", clientDeviceId }),
              this.#revokeStepUp(agent, clientDeviceId),
            )
          ).env,
        );
    // The server's assertion comes last, right before sending (a cancel sends nothing).
    const stepUp = await o.stepUp();
    const r = await o.api.post<{
      revoked?: string[];
      commandsQueued?: number;
      refused?: string[];
      banFailed?: string[];
    }>("/v1/devices/revoke-all", { stepUp, commands });
    return {
      revoked: r.revoked ?? [],
      commandsQueued: r.commandsQueued ?? 0,
      refused: r.refused ?? [],
      banFailed: r.banFailed ?? [],
      notified: trusted,
      untrusted: agents.filter((a) => !trusted.includes(a)),
    };
  }

  // ---- notifications ----------------------------------------------------------------

  async ackNotification(nid: string, via: Channel | "app" = "app"): Promise<void> {
    await writeWithRetry(
      "ack notification",
      () =>
        this.db
          .from("notifications")
          .update({ state: "acked", acked_at: new Date(this.#now()).toISOString(), acked_via: via })
          .eq("owner", this.live.owner)
          .eq("nid", nid),
      this.opts.retry,
    );
  }

  // ---- internals --------------------------------------------------------------------

  #agentOf(sid: string): string {
    const s = this.live.session(sid);
    if (!s) throw new ActionError("unknown_session");
    return s.agentDeviceId;
  }

  /** Sealed to the agent's LOCALLY trusted key (and this device, to show its own history). */
  async #sealFor(agentDeviceId: string, value: unknown, cid: string) {
    const agentKey = this.keys.trustedAgentBoxKey(agentDeviceId);
    if (!agentKey) throw new ActionError("untrusted_agent", `agent ${agentDeviceId} isn't paired with this device`);
    return this.keys.seal(
      value,
      { [agentDeviceId]: agentKey, [this.keys.deviceId]: this.keys.pubBox },
      `command:${cid}`,
    );
  }

  /** Signs a command for one agent (not sent). */
  async #signCommand(
    agentDeviceId: string,
    build: (cid: string) => Promise<CommandPayload>,
    stepUp?: (unsignedBody: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>,
  ) {
    if (!this.keys.trustedAgentBoxKey(agentDeviceId)) throw new ActionError("untrusted_agent");
    const cid = this.#newId();
    const payload = await build(cid);
    if (!CLIENT_COMMANDS.has(payload.type)) throw new ActionError("not_allowed");
    const now = this.#now();
    const base = CommandBody.parse({
      v: 1,
      cid,
      uid: this.live.owner,
      targetDeviceId: agentDeviceId,
      origin: `client:${this.keys.deviceId}`,
      nonce: b64Nonce(),
      issuedAt: now,
      expiresAt: now + this.#ttl,
      payload,
    });
    const step = stepUp ? await stepUp({ ...base }) : undefined;
    const body = step ? CommandBody.parse({ ...base, stepUp: step }) : base;
    const env = await this.keys.sign("chalito.command.v1", body);
    return { cid, body, env };
  }

  async #command(
    agentDeviceId: string,
    build: (cid: string) => Promise<CommandPayload>,
    /** A step-up bound to the final body (without stepUp); the body must not change after it. */
    stepUp?: (unsignedBody: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>,
  ): Promise<string> {
    const { cid, body, env } = await this.#signCommand(agentDeviceId, build, stepUp);
    await writeWithRetry(
      "send command",
      () =>
        this.db.from("commands").insert({
          owner: this.live.owner,
          target_device_id: agentDeviceId,
          id: cid,
          env,
          from_device_id: this.keys.deviceId,
          expires_at: new Date(body.expiresAt).toISOString(),
        }),
      this.opts.retry,
    );
    return cid;
  }
}
