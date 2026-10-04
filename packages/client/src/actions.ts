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
      | "not_allowed",
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
 * - decide: a signed Decision inserted into `approval_decisions` (one per signer);
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

  async revokeClient(agentDeviceId: string, clientDeviceId: string): Promise<string> {
    return this.#command(agentDeviceId, async () => ({ type: "device.revokeClient", clientDeviceId }));
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

  async #command(agentDeviceId: string, build: (cid: string) => Promise<CommandPayload>): Promise<string> {
    if (!this.keys.trustedAgentBoxKey(agentDeviceId)) throw new ActionError("untrusted_agent");
    const cid = this.#newId();
    const payload = await build(cid);
    if (!CLIENT_COMMANDS.has(payload.type)) throw new ActionError("not_allowed");
    const now = this.#now();
    const body = CommandBody.parse({
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
    const env = await this.keys.sign("chalito.command.v1", body);
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
