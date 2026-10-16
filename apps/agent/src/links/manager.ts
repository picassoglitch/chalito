import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";
import { LinkProjector, type AdapterEvent } from "@chalito/adapters";
import {
  fromB64url,
  openJson,
  randomNonce,
  sealJson,
  signEnvelope,
  verifyDetached,
  type BoxKeyPair,
  type SigningKeyPair,
} from "@chalito/crypto";
import {
  AgentLink,
  LINK_MAX_HOPS,
  LinkMessage,
  LinkResult,
  RelayedCommand,
  isTerminalLinkState,
  type AgentLinkSummary,
  type CommandBody,
  type CommandPayload,
  type DeviceEvent,
  type LinkAuthorizeRequest,
  type LinkAuthorizeResult,
  type LinkAuthorizer,
  type LinkCreateSpec,
  type LinkEndpoint,
  type LinkHandoffStage,
  type LinkMode,
  type LinkPart,
  type LinkRefusal,
  type LinkTaskState,
  type Origin,
  type RemotePermissionMode,
  type SealedEnvelope,
} from "@chalito/protocol";
import { PERMISSION_RANK, originAllowed, type Policy } from "../policy/index.js";
import type { Logger } from "../redact.js";
import type { LinkCloud } from "./cloud.js";
import { artifactsAsData, handoffFrame, partsAsData, sharedBlock, withLinkData } from "./frame.js";
import type { LinkState, LinkStorage } from "./storage.js";

/**
 * Agent-to-agent links on this device (ADR 0022 §3): the local list (links/storage.ts), the
 * checks every delivery goes through (`authorize`), and both ends of share and hand-off.
 *
 * Guardrails, in the order they run on the receiving device:
 * 1. The relay verifies against the sender key recorded locally for that link (`verifyRelay`).
 * 2. The link is active here (not revoked, here or in the cloud's revoke-all; not expired), this
 *    device is its receiver, the mode matches and the policy allows `agent:` turns.
 * 3. Hop limit (2) and no cycle through the chain; the sender is the chain's last session.
 * 4. Scope: the link's workspace is in local policy (and the cwd inside it).
 * 5. Rate (deliveries per hour) and the daily token budget.
 * 6. Permission: the receiving session runs at most min(link ceiling, policy remote max). The
 *    tool gate is unchanged; `agent:` is unsigned, so Developer mode never auto-approves its tools.
 * 7. "Ask me each time" (default): one tap on the phone (`link_handoff` approval) before delivery.
 * Shares never prompt: they're queued as quoted data for the owner's next own prompt.
 * Results come back as quoted data the same way; a result can never instruct the sender.
 */

export interface LinkSessionInfo {
  sid: string;
  cwd: string;
  workspaceLabel: string;
  permissionMode: RemotePermissionMode;
  appId?: string;
}

/** What the agent core gives the link manager (agent-core.ts implements it). */
export interface LinkHost {
  session(sid: string): LinkSessionInfo | undefined;
  sessions(): LinkSessionInfo[];
  startSession(input: {
    sid: string;
    appId?: string;
    workspaceLabel: string;
    prompt: string;
    origin: Origin;
    permissionMode: RemotePermissionMode;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
  prompt(sid: string, text: string, origin: Origin): Promise<void>;
  interrupt(sid: string): Promise<void>;
  event(sid: string, partial: Record<string, unknown>): Promise<void>;
  /** One tap on the phone (MED, no step-up). A timeout or no trusted client is a no. */
  confirm(
    sid: string,
    input: { origin: Origin; details: { toolName: string; input: unknown; reasons: string[] } },
  ): Promise<{ allow: boolean }>;
  /** This agent's own command path (a same-device link goes through the same checks). */
  handleCommand(cid: string, doc: Record<string, unknown>): Promise<unknown>;
  sealForClients(value: unknown, aad: string): Promise<SealedEnvelope>;
}

export interface LinkManagerDeps {
  deviceId: string;
  owner: string;
  sign: SigningKeyPair;
  box: BoxKeyPair;
  pubBox: string;
  storage: LinkStorage;
  cloud: LinkCloud;
  policy: () => Policy;
  audit: (type: string, meta: Record<string, unknown>) => void;
  publishDeviceEvent: (e: DeviceEvent) => Promise<void>;
  now: () => number;
  log: Logger;
}

export type LinkResultOf<T = object> = ({ ok: true } & T) | { ok: false; reason: string };

/** A hand-off task this device received and is running. */
interface Inbound {
  linkId: string;
  taskId: string;
  hop: number;
  /** The chain up to and including the sender; this session is appended when it hands off. */
  chain: string[];
  fromDeviceId: string;
  fromSid: string;
  projector: LinkProjector;
  done: boolean;
}

/** A hand-off this device sent and waits on. */
interface Outbound {
  linkId: string;
  /** The link as it was when sent: a result still comes back if it was revoked meanwhile. */
  link: AgentLink;
  fromSid: string;
  peerDeviceId: string;
  hop: number;
}

const RELAY_TTL_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const within = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
const minMode = (a: RemotePermissionMode, b: RemotePermissionMode): RemotePermissionMode =>
  PERMISSION_RANK[a] <= PERMISSION_RANK[b] ? a : b;
const sidOf = (origin: Origin) => (origin.startsWith("agent:") ? origin.slice("agent:".length) : null);

const STAGE_OF: Partial<Record<LinkTaskState, LinkHandoffStage>> = {
  TASK_STATE_COMPLETED: "completed",
  TASK_STATE_FAILED: "failed",
  TASK_STATE_CANCELED: "canceled",
  TASK_STATE_REJECTED: "refused",
};

export class LinkManager implements LinkAuthorizer {
  #state: LinkState;
  #host: LinkHost | null = null;
  readonly #inbound = new Map<string, Inbound>();
  readonly #outbound = new Map<string, Outbound>();
  /** Quoted blocks (shares, results) waiting for the owner's next prompt, per session. */
  readonly #pending = new Map<string, string[]>();

  constructor(private readonly d: LinkManagerDeps) {
    const { state, tampered } = d.storage.load();
    this.#state = state;
    if (tampered) {
      d.audit("link.tampered", {});
      d.storage.save(state);
    }
  }

  attach(host: LinkHost): void {
    this.#host = host;
  }

  get #h(): LinkHost {
    if (!this.#host) throw new Error("link manager not attached");
    return this.#host;
  }

  // ---- the list ---------------------------------------------------------------------------

  /** Active links (not revoked, not expired). */
  list(): AgentLink[] {
    const now = this.d.now();
    return this.#state.links.filter((l) => l.expiresAt > now);
  }

  get(linkId: string): AgentLink | undefined {
    return this.list().find((l) => l.id === linkId);
  }

  /**
   * A hand-off or share link made on this device (desktop panel or `chalito link add`). The
   * caller has already done OS authentication and the confirmations (links/local.ts).
   */
  async createLocal(
    spec: Omit<AgentLink, "v" | "createdAt" | "createdBy">,
  ): Promise<LinkResultOf<{ link: AgentLink }>> {
    return this.#add({ ...spec, v: 1, createdAt: this.d.now(), createdBy: "local" });
  }

  /** A share link from a trusted client (the core checked the signature and the passkey step-up). */
  async createFromClient(spec: LinkCreateSpec, origin: Origin): Promise<LinkResultOf<{ link: AgentLink }>> {
    if (!origin.startsWith("client:")) return { ok: false, reason: "link_local_only" };
    return this.#add({ ...spec, v: 1, createdAt: this.d.now(), createdBy: origin });
  }

  async #add(raw: unknown): Promise<LinkResultOf<{ link: AgentLink }>> {
    const parsed = AgentLink.safeParse(raw);
    if (!parsed.success) {
      const handoff = (raw as { mode?: unknown }).mode === "handoff";
      return { ok: false, reason: handoff ? "link_local_only" : "invalid" };
    }
    const link = parsed.data;
    const self = this.d.deviceId;
    if (link.sender.deviceId !== self && link.receiver.deviceId !== self)
      return { ok: false, reason: "link_wrong_endpoint" };
    if (link.receiver.deviceId === self && !this.d.policy().workspaces.some((w) => w.label === link.workspaceLabel))
      return { ok: false, reason: "link_out_of_scope" };
    if (this.#state.revoked.some((r) => r.id === link.id) || this.#state.links.some((l) => l.id === link.id))
      return { ok: false, reason: "invalid" };
    this.#state.links.push(link);
    this.#save();
    this.d.audit("link.created", {
      linkId: link.id,
      mode: link.mode,
      by: link.createdBy,
      sender: link.sender.deviceId,
      receiver: link.receiver.deviceId,
      confirm: link.confirm,
      ceiling: link.permissionCeiling,
      expiresAt: link.expiresAt,
    });
    await this.#changed("created");
    return { ok: true, link };
  }

  /** Revoke one link, from anywhere (a trusted client, the device, revoke-all). */
  async revoke(linkId: string, by: string): Promise<boolean> {
    const had = this.#state.links.some((l) => l.id === linkId);
    if (!had) return false;
    this.#revokeLocal([linkId], by);
    await this.#changed("revoked");
    return true;
  }

  /** Every link on this device (ADR 0020 revoke-all, or `link.revokeAll`). Returns how many. */
  async revokeAll(by: string): Promise<number> {
    const ids = this.#state.links.map((l) => l.id);
    if (ids.length) this.#revokeLocal(ids, by);
    await this.#changed("revoke_all");
    return ids.length;
  }

  #revokeLocal(ids: string[], by: string): void {
    const at = this.d.now();
    this.#state.links = this.#state.links.filter((l) => !ids.includes(l.id));
    for (const id of ids) {
      this.#state.revoked.push({ id, at, by: by.slice(0, 64) });
      delete this.#state.usage[id];
      delete this.#state.deliveries[id];
    }
    this.#state.revoked = this.#state.revoked.slice(-2000);
    this.#save();
    // Running hand-off tasks over a revoked link stop now.
    for (const [sid, t] of this.#inbound)
      if (ids.includes(t.linkId) && !t.done) void this.#h.interrupt(sid).catch(() => undefined);
    for (const id of ids) this.d.audit("link.revoked", { linkId: id, by });
  }

  /** Publishes the summaries (and sealed details) for the person's clients; `link.list`. */
  async publish(): Promise<void> {
    const rows = [];
    const revokedAt = new Map(this.#state.revoked.map((r) => [r.id, r.at]));
    const all: AgentLink[] = [...this.#state.links];
    for (const link of all) {
      const summary: AgentLinkSummary = {
        v: 1,
        id: link.id,
        mode: link.mode,
        senderDeviceId: link.sender.deviceId,
        receiverDeviceId: link.receiver.deviceId,
        confirm: link.confirm,
        permissionCeiling: link.permissionCeiling,
        expiresAt: link.expiresAt,
        revokedAt: revokedAt.get(link.id) ?? null,
      };
      const detailsCt = await this.#h.sealForClients(
        {
          goal: link.goal,
          workspaceLabel: link.workspaceLabel,
          dailyTokenBudget: link.dailyTokenBudget,
          ratePerHour: link.ratePerHour,
          sender: { deviceId: link.sender.deviceId, sessionId: link.sender.sessionId, appId: link.sender.appId },
          receiver: {
            deviceId: link.receiver.deviceId,
            sessionId: link.receiver.sessionId,
            appId: link.receiver.appId,
          },
          tokensToday: this.#tokensToday(link.id),
        },
        `link:${link.id}`,
      );
      rows.push({ summary, detailsCt });
    }
    await this.d.cloud.publishLinks(rows);
  }

  async #changed(by: string): Promise<void> {
    await this.d
      .publishDeviceEvent({
        v: 1,
        type: "link.changed",
        deviceId: this.d.deviceId,
        active: this.list().length,
        by,
        t: this.d.now(),
      })
      .catch(() => undefined);
    await this.publish().catch((err: unknown) =>
      this.d.log.warn("link.publish_failed", { error: err instanceof Error ? err.message : "error" }),
    );
  }

  #save(): void {
    this.d.storage.save(this.#state);
  }

  // ---- authorization (also Phase D's LinkAuthorizer) -----------------------------------------

  /**
   * Phase D entry: finds the active link from `fromAgent` to `toAgent` on `targetDeviceId` (each
   * matched against the endpoint's session id, app id or device id) and runs every check.
   */
  async authorize(req: LinkAuthorizeRequest): Promise<LinkAuthorizeResult> {
    const matches = (e: LinkEndpoint, who: string) => e.sessionId === who || e.appId === who || e.deviceId === who;
    const link = this.list().find(
      (l) =>
        l.receiver.deviceId === req.targetDeviceId &&
        matches(l.sender, req.fromAgent) &&
        matches(l.receiver, req.toAgent),
    );
    if (!link) return { ok: false, reason: "no_link" };
    return this.#authorizeLink(link, link.mode, req);
  }

  async #authorizeLink(
    link: AgentLink,
    mode: LinkMode,
    req: Pick<LinkAuthorizeRequest, "origin" | "targetDeviceId" | "cwd" | "hop" | "chain">,
  ): Promise<LinkAuthorizeResult> {
    const refuse = (reason: LinkRefusal) => ({ ok: false as const, reason });
    const now = this.d.now();
    const policy = this.d.policy();
    if (this.#state.revoked.some((r) => r.id === link.id)) return refuse("link_revoked");
    if (!this.#state.links.some((l) => l.id === link.id)) return refuse("no_link");
    if (link.expiresAt <= now) return refuse("link_expired");
    if (link.receiver.deviceId !== this.d.deviceId || req.targetDeviceId !== this.d.deviceId)
      return refuse("wrong_endpoint");
    if (link.mode !== mode) return refuse("wrong_mode");
    const fromSid = sidOf(req.origin);
    if (!fromSid || !originAllowed(policy.origins, req.origin)) return refuse("origin_disabled");
    if (link.sender.sessionId !== undefined && link.sender.sessionId !== fromSid) return refuse("wrong_endpoint");
    // Loops: at most LINK_MAX_HOPS hand-offs, and never back into a session already in the chain.
    if (req.hop < 1 || req.hop > LINK_MAX_HOPS || req.chain.length !== req.hop) return refuse("hop_limit");
    if (req.chain.at(-1) !== fromSid || new Set(req.chain).size !== req.chain.length) return refuse("cycle");
    if (link.receiver.sessionId !== undefined && req.chain.includes(link.receiver.sessionId)) return refuse("cycle");
    // Scope: the link's workspace must still be in local policy.
    const ws = policy.workspaces.find((w) => w.label === link.workspaceLabel);
    if (!ws) return refuse("out_of_scope");
    if (req.cwd !== undefined && !within(resolve(req.cwd), resolve(ws.path))) return refuse("out_of_scope");
    // Rate and budget.
    const recent = (this.#state.deliveries[link.id] ?? []).filter((t) => t > now - HOUR_MS);
    if (recent.length >= link.ratePerHour) return refuse("rate_limited");
    if (this.#tokensToday(link.id) >= link.dailyTokenBudget) return refuse("budget_exhausted");
    // Revoke-all marks the cloud mirror; a link the account revoked stops here too. Fail closed.
    try {
      if ((await this.d.cloud.revokedInCloud([link.id])).includes(link.id)) {
        this.#revokeLocal([link.id], "cloud");
        await this.#changed("revoked");
        return refuse("link_revoked");
      }
    } catch (err) {
      this.d.log.warn("link.cloud_check_failed", { error: err instanceof Error ? err.message : "error" });
      return refuse("link_revoked");
    }
    return {
      ok: true,
      linkId: link.id,
      mode: link.mode,
      confirm: link.confirm,
      permissionCeiling: minMode(link.permissionCeiling, policy.remote.maxPermissionMode),
    };
  }

  #tokensToday(linkId: string): number {
    const u = this.#state.usage[linkId];
    return u && u.day === day(this.d.now()) ? u.tokens : 0;
  }

  #spend(linkId: string, tokens: number): number {
    const today = day(this.d.now());
    const u = this.#state.usage[linkId];
    const next = (u && u.day === today ? u.tokens : 0) + tokens;
    this.#state.usage[linkId] = { day: today, tokens: next };
    this.#save();
    return next;
  }

  #recordDelivery(linkId: string): void {
    const now = this.d.now();
    this.#state.deliveries[linkId] = [...(this.#state.deliveries[linkId] ?? []).filter((t) => t > now - HOUR_MS), now];
    this.#save();
  }

  // ---- relays -------------------------------------------------------------------------------

  /**
   * The signature on an `agent-link` relay, against the key recorded locally for the link: the
   * sender's for a hand-off or share, the receiver's for a result. A same-device link is signed
   * with this device's own key.
   */
  async verifyRelay(env: RelayedCommand): Promise<{ ok: true } | { ok: false; reason: string }> {
    const p = env.body.payload as { type: string; linkId?: string; taskId?: string };
    // A result may answer a task sent before its link was revoked; it is still only quoted data.
    const link = p.linkId
      ? (this.#state.links.find((l) => l.id === p.linkId) ??
        (p.type === "link.result" && p.taskId ? this.#outbound.get(p.taskId)?.link : undefined))
      : undefined;
    if (link && link.id !== p.linkId) return { ok: false, reason: "unknown_link" };
    if (!link) return { ok: false, reason: "unknown_link" };
    const from = p.type === "link.result" ? link.receiver : link.sender;
    if (env.signerDeviceId !== from.deviceId) return { ok: false, reason: "bad_signature" };
    const key =
      from.deviceId === this.d.deviceId ? this.d.sign.publicKey : from.pubSign ? await fromB64url(from.pubSign) : null;
    if (!key || !env.sig) return { ok: false, reason: "bad_signature" };
    const ok = await verifyDetached("chalito.link.v1", env.body, env.sig, key);
    return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
  }

  async #relay(
    to: LinkEndpoint,
    origin: Origin,
    build: (cid: string, seal: (v: unknown) => Promise<SealedEnvelope>) => Promise<CommandPayload>,
  ): Promise<void> {
    const cid = `l${randomUUID().replace(/-/g, "")}`;
    const now = this.d.now();
    const pubBox = to.deviceId === this.d.deviceId ? this.d.pubBox : to.pubBox;
    if (!pubBox) throw new Error("no key for the other end");
    const recipientKey = await fromB64url(pubBox);
    const payload = await build(cid, (v) => sealJson(v, { [to.deviceId]: recipientKey }, `command:${cid}`));
    const body: CommandBody = {
      v: 1,
      cid,
      uid: this.d.owner,
      targetDeviceId: to.deviceId,
      origin,
      nonce: await randomNonce(),
      issuedAt: now,
      expiresAt: now + RELAY_TTL_MS,
      payload,
    };
    const signed = await signEnvelope("chalito.link.v1", body, this.d.deviceId, this.d.sign.secretKey);
    const env = RelayedCommand.parse({
      relayedBy: "agent-link",
      body,
      signerDeviceId: this.d.deviceId,
      sig: signed.sig,
    });
    // Same device: through this agent's own command path, so every check runs the same way.
    if (to.deviceId === this.d.deviceId) await this.#h.handleCommand(cid, { env });
    else await this.d.cloud.queueCommand(to.deviceId, cid, env, body.expiresAt);
  }

  // ---- sending ------------------------------------------------------------------------------

  /** `fromSid` hands work over `linkId` (started on this device: the desktop panel, CLI, or a session tool). */
  async handoff(input: { fromSid: string; linkId: string; text: string }): Promise<LinkResultOf<{ taskId: string }>> {
    const link = this.get(input.linkId);
    if (!link || link.mode !== "handoff") return { ok: false, reason: "unknown_link" };
    if (link.sender.deviceId !== this.d.deviceId) return { ok: false, reason: "link_wrong_endpoint" };
    if (link.sender.sessionId !== undefined && link.sender.sessionId !== input.fromSid)
      return { ok: false, reason: "link_wrong_endpoint" };
    if (!this.#h.session(input.fromSid)) return { ok: false, reason: "unknown_session" };
    // The chain this session is already in (if it runs a hand-off itself), plus itself.
    const prior = this.#inbound.get(input.fromSid);
    const hop = (prior && !prior.done ? prior.hop : 0) + 1;
    const chain = [...(prior && !prior.done ? prior.chain : []), input.fromSid];
    const taskId = randomUUID();
    const refused = async (reason: LinkRefusal) => {
      await this.#handoffEvent(input.fromSid, {
        linkId: link.id,
        taskId,
        direction: "out",
        stage: "refused",
        hop,
        peerDeviceId: link.receiver.deviceId,
        reason,
      });
      this.d.audit("link.handoff.refused", { linkId: link.id, taskId, hop, reason, side: "sender" });
      return { ok: false as const, reason: "link_refused" };
    };
    if (hop > LINK_MAX_HOPS) return refused("hop_limit");
    if (link.receiver.sessionId !== undefined && chain.includes(link.receiver.sessionId)) return refused("cycle");
    const message: LinkMessage = LinkMessage.parse({
      messageId: randomUUID(),
      contextId: input.fromSid,
      taskId,
      role: "ROLE_USER",
      parts: [{ text: input.text }],
    });
    this.#outbound.set(taskId, {
      linkId: link.id,
      link,
      fromSid: input.fromSid,
      peerDeviceId: link.receiver.deviceId,
      hop,
    });
    await this.#handoffEvent(input.fromSid, {
      linkId: link.id,
      taskId,
      direction: "out",
      stage: "sent",
      hop,
      peerDeviceId: link.receiver.deviceId,
    });
    this.d.audit("link.handoff.sent", {
      linkId: link.id,
      taskId,
      hop,
      from: input.fromSid,
      to: link.receiver.deviceId,
    });
    try {
      await this.#relay(link.receiver, `agent:${input.fromSid}`, async (_cid, seal) => ({
        type: "link.handoff",
        linkId: link.id,
        taskId,
        hop,
        chain,
        taskCt: await seal(message),
      }));
    } catch (err) {
      this.d.log.warn("link.relay_failed", { error: err instanceof Error ? err.message : "error" });
      this.#outbound.delete(taskId);
      return refused("start_failed");
    }
    return { ok: true, taskId };
  }

  /** `fromSid` shares information over a share link. Never a prompt at the other end. */
  async share(input: { fromSid: string; linkId: string; parts: LinkPart[] }): Promise<LinkResultOf> {
    const link = this.get(input.linkId);
    if (!link || link.mode !== "share") return { ok: false, reason: "unknown_link" };
    if (link.sender.deviceId !== this.d.deviceId) return { ok: false, reason: "link_wrong_endpoint" };
    if (link.sender.sessionId !== undefined && link.sender.sessionId !== input.fromSid)
      return { ok: false, reason: "link_wrong_endpoint" };
    if (!this.#h.session(input.fromSid)) return { ok: false, reason: "unknown_session" };
    const message = LinkMessage.parse({
      messageId: randomUUID(),
      contextId: input.fromSid,
      role: "ROLE_AGENT",
      parts: input.parts,
    });
    await this.#h.event(input.fromSid, {
      type: "link.shared",
      linkId: link.id,
      mode: "share",
      direction: "out",
      peerDeviceId: link.receiver.deviceId,
    });
    this.d.audit("link.share.sent", { linkId: link.id, from: input.fromSid, to: link.receiver.deviceId });
    await this.#relay(link.receiver, `agent:${input.fromSid}`, async (_cid, seal) => ({
      type: "link.share",
      linkId: link.id,
      dataCt: await seal(message),
    }));
    return { ok: true };
  }

  // ---- receiving (from agent-core's dispatch; the relay's signature is already verified) ----

  async onRelay(
    cid: string,
    p: Extract<CommandPayload, { type: "link.handoff" | "link.share" | "link.result" }>,
    origin: Origin,
  ): Promise<LinkResultOf<{ sid?: string }>> {
    const open = <T>(ct: SealedEnvelope) => openJson<T>(ct, this.d.deviceId, this.d.box, `command:${cid}`);
    switch (p.type) {
      case "link.handoff":
        return this.#receiveHandoff(p, origin, LinkMessage.parse(await open<unknown>(p.taskCt)));
      case "link.share":
        return this.#receiveShare(p.linkId, origin, LinkMessage.parse(await open<unknown>(p.dataCt)));
      case "link.result":
        return this.#receiveResult(p.linkId, p.taskId, LinkResult.parse(await open<unknown>(p.resultCt)));
    }
  }

  async #receiveHandoff(
    p: { linkId: string; taskId: string; hop: number; chain: string[] },
    origin: Origin,
    message: LinkMessage,
  ): Promise<LinkResultOf<{ sid?: string }>> {
    const link = this.#state.links.find((l) => l.id === p.linkId);
    const fromSid = sidOf(origin)!;
    if (!link) return { ok: false, reason: "unknown_link" };
    const back = async (reason: LinkRefusal) => {
      this.d.audit("link.handoff.refused", { linkId: link.id, taskId: p.taskId, hop: p.hop, reason, side: "receiver" });
      await this.#sendResult(
        link,
        fromSid,
        p.taskId,
        { v: 1, taskId: p.taskId, state: "TASK_STATE_REJECTED", artifacts: [], reason },
        null,
      );
      return { ok: false as const, reason: "link_refused" };
    };
    const target = link.receiver.sessionId !== undefined ? this.#h.session(link.receiver.sessionId) : undefined;
    const auth = await this.#authorizeLink(link, "handoff", {
      origin,
      targetDeviceId: this.d.deviceId,
      hop: p.hop,
      chain: p.chain,
      ...(target ? { cwd: target.cwd } : {}),
    });
    if (!auth.ok) return back(auth.reason as LinkRefusal);
    if (link.receiver.sessionId !== undefined) {
      if (!target) return back("wrong_endpoint");
      if (PERMISSION_RANK[target.permissionMode] > PERMISSION_RANK[auth.permissionCeiling])
        return back("permission_above_ceiling");
      const running = this.#inbound.get(target.sid);
      if (running && !running.done) return back("receiver_busy");
    }
    this.#recordDelivery(link.id);
    const sid = target?.sid ?? randomUUID();
    // The relay is accepted; asking the phone (up to the approval TTL) and starting the session
    // run after it, so the command path isn't held while the owner decides.
    void this.#deliver({ link, p, origin, fromSid, message, sid, target, ceiling: auth.permissionCeiling, back }).catch(
      (err: unknown) =>
        this.d.log.error("link.deliver_failed", { error: err instanceof Error ? err.message : "error" }),
    );
    return { ok: true, sid };
  }

  async #deliver(o: {
    link: AgentLink;
    p: { taskId: string; hop: number; chain: string[] };
    origin: Origin;
    fromSid: string;
    message: LinkMessage;
    sid: string;
    target: LinkSessionInfo | undefined;
    ceiling: RemotePermissionMode;
    back: (reason: LinkRefusal) => Promise<unknown>;
  }): Promise<void> {
    const { link, p, origin, fromSid, message, sid, target, back } = o;
    if (link.confirm) {
      this.d.audit("link.handoff.confirm_requested", { linkId: link.id, taskId: p.taskId, hop: p.hop });
      const { allow } = await this.#h.confirm(sid, {
        origin,
        details: {
          toolName: "link.handoff",
          input: {
            linkId: link.id,
            from: `${link.sender.deviceId}/${fromSid}`,
            goal: link.goal,
            request: partsAsData(message.parts),
            hop: p.hop,
          },
          reasons: [`Hand-off over link ${link.id} (${p.hop} of ${LINK_MAX_HOPS})`],
        },
      });
      if (!allow) return void (await back("owner_declined"));
      // Revoked (or expired) while the phone was asked: still refused.
      if (!this.get(link.id)) return void (await back("link_revoked"));
    }
    const projector = new LinkProjector({ contextId: sid, now: this.d.now });
    projector.prompt(message.parts.find((x) => x.text !== undefined)?.text ?? "", { messageId: message.messageId });
    const inbound: Inbound = {
      linkId: link.id,
      taskId: p.taskId,
      hop: p.hop,
      chain: [...p.chain],
      fromDeviceId: link.sender.deviceId,
      fromSid,
      projector,
      done: false,
    };
    this.#inbound.set(sid, inbound);
    const frame = handoffFrame({
      link,
      fromDeviceId: link.sender.deviceId,
      fromSid,
      hop: p.hop,
      request: message.parts,
    });
    if (target) {
      await this.#h.prompt(sid, frame, origin);
    } else {
      const started = await this.#h.startSession({
        sid,
        ...(link.receiver.appId ? { appId: link.receiver.appId } : {}),
        workspaceLabel: link.workspaceLabel,
        prompt: frame,
        origin,
        permissionMode: o.ceiling,
      });
      if (!started.ok) {
        this.#inbound.delete(sid);
        return void (await back("start_failed"));
      }
    }
    await this.#handoffEvent(sid, {
      linkId: link.id,
      taskId: p.taskId,
      direction: "in",
      stage: "delivered",
      hop: p.hop,
      peerDeviceId: link.sender.deviceId,
      peerSid: fromSid,
    });
    this.d.audit("link.handoff.delivered", {
      linkId: link.id,
      taskId: p.taskId,
      hop: p.hop,
      sid,
      from: fromSid,
      confirmed: link.confirm,
    });
  }

  async #receiveShare(linkId: string, origin: Origin, message: LinkMessage): Promise<LinkResultOf<{ sid?: string }>> {
    const link = this.#state.links.find((l) => l.id === linkId);
    if (!link) return { ok: false, reason: "unknown_link" };
    const fromSid = sidOf(origin)!;
    const auth = await this.#authorizeLink(link, "share", {
      origin,
      targetDeviceId: this.d.deviceId,
      hop: 1,
      chain: [fromSid],
    });
    if (!auth.ok) {
      this.d.audit("link.share.refused", { linkId, reason: auth.reason });
      return { ok: false, reason: "link_refused" };
    }
    // The receiving session: the one the link names, else the newest in the link's workspace.
    const target =
      link.receiver.sessionId !== undefined
        ? this.#h.session(link.receiver.sessionId)
        : this.#h
            .sessions()
            .filter(
              (s) =>
                s.workspaceLabel === link.workspaceLabel && (!link.receiver.appId || s.appId === link.receiver.appId),
            )
            .at(-1);
    if (!target) {
      this.d.audit("link.share.refused", { linkId, reason: "wrong_endpoint" });
      return { ok: false, reason: "link_refused" };
    }
    this.#recordDelivery(link.id);
    this.#queue(
      target.sid,
      sharedBlock({ linkId, fromDeviceId: link.sender.deviceId, kind: "share", parts: partsAsData(message.parts) }),
    );
    await this.#h.event(target.sid, {
      type: "link.shared",
      linkId,
      mode: "share",
      direction: "in",
      peerDeviceId: link.sender.deviceId,
      ct: await this.#h.sealForClients({ parts: partsAsData(message.parts) }, `event:${target.sid}`),
    });
    this.d.audit("link.share.received", { linkId, sid: target.sid, from: fromSid });
    return { ok: true, sid: target.sid };
  }

  async #receiveResult(linkId: string, taskId: string, result: LinkResult): Promise<LinkResultOf<{ sid?: string }>> {
    const out = this.#outbound.get(taskId);
    if (!out || out.linkId !== linkId || result.taskId !== taskId) return { ok: false, reason: "unknown_link" };
    const link = out.link;
    this.#outbound.delete(taskId);
    const content = artifactsAsData(result.artifacts);
    this.#queue(
      out.fromSid,
      sharedBlock({
        linkId,
        fromDeviceId: link.receiver.deviceId,
        kind: "result",
        taskId,
        state: result.state,
        parts: content,
      }),
    );
    await this.#handoffEvent(out.fromSid, {
      linkId,
      taskId,
      direction: "out",
      stage: STAGE_OF[result.state] ?? "failed",
      hop: out.hop,
      peerDeviceId: link.receiver.deviceId,
      ...(result.reason ? { reason: result.reason } : {}),
    });
    await this.#h.event(out.fromSid, {
      type: "link.shared",
      linkId,
      mode: "handoff",
      direction: "in",
      peerDeviceId: link.receiver.deviceId,
      taskId,
      state: result.state,
      ct: await this.#h.sealForClients({ artifacts: content }, `event:${out.fromSid}`),
    });
    this.d.audit("link.handoff.result", {
      linkId,
      taskId,
      state: result.state,
      ...(result.reason ? { reason: result.reason } : {}),
    });
    return { ok: true, sid: out.fromSid };
  }

  async #sendResult(
    link: AgentLink,
    toSid: string,
    taskId: string,
    result: LinkResult,
    fromSid: string | null,
  ): Promise<void> {
    try {
      await this.#relay(link.sender, `agent:${fromSid ?? `${link.id}`}`, async (_cid, seal) => ({
        type: "link.result",
        linkId: link.id,
        taskId,
        resultCt: await seal(LinkResult.parse(result)),
      }));
    } catch (err) {
      this.d.log.warn("link.result_failed", { toSid, error: err instanceof Error ? err.message : "error" });
    }
  }

  // ---- the receiving session's run -----------------------------------------------------------

  /** Every adapter event of every session (agent-core); only hand-off tasks are tracked. */
  async onAdapterEvent(sid: string, e: AdapterEvent): Promise<void> {
    const t = this.#inbound.get(sid);
    if (!t || t.done) return;
    t.projector.push(e);
    if (e.type === "usage") {
      const spent = this.#spend(t.linkId, e.tokIn + e.tokOut);
      const link = this.#state.links.find((l) => l.id === t.linkId);
      if (link && spent >= link.dailyTokenBudget) {
        this.d.audit("link.budget_exhausted", { linkId: t.linkId, taskId: t.taskId, spent });
        await this.#finish(sid, t, "TASK_STATE_FAILED", "budget_exhausted");
        await this.#h.interrupt(sid).catch(() => undefined);
      }
      return;
    }
    const state = t.projector.task?.status.state;
    if (state && isTerminalLinkState(state)) await this.#finish(sid, t, state);
  }

  async #finish(sid: string, t: Inbound, state: LinkTaskState, reason?: LinkRefusal): Promise<void> {
    if (t.done) return;
    t.done = true;
    this.#inbound.delete(sid);
    const link = this.#state.links.find((l) => l.id === t.linkId);
    await this.#handoffEvent(sid, {
      linkId: t.linkId,
      taskId: t.taskId,
      direction: "in",
      stage: STAGE_OF[state] ?? "failed",
      hop: t.hop,
      peerDeviceId: t.fromDeviceId,
      peerSid: t.fromSid,
      ...(reason ? { reason } : {}),
    });
    this.d.audit("link.handoff.finished", { linkId: t.linkId, taskId: t.taskId, state, ...(reason ? { reason } : {}) });
    if (!link) return; // revoked meanwhile: nothing goes back over it
    await this.#sendResult(
      link,
      t.fromSid,
      t.taskId,
      {
        v: 1,
        taskId: t.taskId,
        state,
        artifacts: t.projector.task?.artifacts ?? [],
        ...(reason ? { reason } : {}),
      },
      sid,
    );
  }

  // ---- shared data for the owner's next prompt -----------------------------------------------

  #queue(sid: string, block: string): void {
    const q = this.#pending.get(sid) ?? [];
    q.push(block);
    this.#pending.set(sid, q.slice(-20));
  }

  /**
   * The owner's prompt with any queued shares and results in front of it, as quoted data. Only
   * a signed (owner) turn takes them; nothing from a link ever starts a turn by itself.
   */
  takeShared(sid: string, prompt: string): string {
    const q = this.#pending.get(sid);
    if (!q?.length) return prompt;
    this.#pending.delete(sid);
    return withLinkData(q, prompt);
  }

  /** Queued blocks for a session (tests, the panel). */
  pending(sid: string): readonly string[] {
    return this.#pending.get(sid) ?? [];
  }

  async #handoffEvent(
    sid: string,
    e: {
      linkId: string;
      taskId: string;
      direction: "in" | "out";
      stage: LinkHandoffStage;
      hop: number;
      peerDeviceId: string;
      peerSid?: string;
      reason?: LinkRefusal;
    },
  ): Promise<void> {
    await this.#h
      .event(sid, { type: "link.handoff", urgency: e.stage === "confirm_pending" ? "normal" : "low", ...e })
      .catch((err: unknown) =>
        this.d.log.warn("link.event_failed", { error: err instanceof Error ? err.message : "error" }),
      );
  }
}
