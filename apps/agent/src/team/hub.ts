import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { selectDelivery, type DeliveryAdapter, type DeliveryFactory } from "./delivery/index.js";
import { ClientDeclaration, type DeliveryLink, type TeamMessage } from "./delivery/types.js";
import { pull } from "./delivery/pull.js";

/** Any MCP client may join under its own id; these four keep their named trust rows and native hooks. */
export const KNOWN_PROVIDERS = ["claude", "codex", "grok", "cursor"] as const;
export const TeamProvider = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
export type TeamProvider = z.infer<typeof TeamProvider>;
const Join = z
  .object({
    provider: TeamProvider,
    cwd: z.string().max(4096).refine(isAbsolute),
    /** The id this process had before its connection dropped; kept if it left recently. */
    resume: z.string().uuid().optional(),
  })
  .strict();
const Send = z
  .object({
    to: z.string().uuid().optional(),
    kind: z.enum(["status", "request", "result"]).default("status"),
    text: z.string().trim().min(1).max(8000),
  })
  .strict();
type Message = TeamMessage;
interface Peer {
  id: string;
  cwd: string;
  provider: TeamProvider;
  workspace: string;
  cursor: number;
  recent: number[];
  link: DeliveryLink | null;
  delivery: DeliveryAdapter;
  timer?: ReturnType<typeof setTimeout>;
  pushes: number[];
}

/** Wake pacing per peer: bursts coalesce into one push, and two AIs answering each other cannot spin. */
export interface PushPacing {
  debounceMs: number;
  minGapMs: number;
  windowMs: number;
  maxPerWindow: number;
  maxBatch: number;
}
export const PUSH_PACING: PushPacing = {
  debounceMs: 1500,
  minGapMs: 5000,
  windowMs: 10 * 60_000,
  maxPerWindow: 20,
  maxBatch: 8,
};

export interface TeamHubOptions {
  pacing?: Partial<PushPacing>;
  chain?: readonly DeliveryFactory[];
  audit?: (type: string, meta: Record<string, unknown>) => void;
  /** An id that is not trusted for the workspace tried to join, so the panel can offer to trust it. */
  rejected?: (provider: TeamProvider, cwd: string) => void;
}

/** Same-user, local messaging only. Provider names are labels, never proof of identity or authority. */
export class TeamHub {
  #peers = new Map<AbortSignal, Peer>();
  #messages: Message[] = [];
  /** Highest seq dropped unread per workspace (cap or expiry), for historyTruncated. */
  #dropped = new Map<string, number>();
  #seq = 0;
  constructor(
    private readonly workspaceFor: (cwd: string) => string | null,
    private readonly now = Date.now,
    private readonly trusted: (provider: TeamProvider, cwd: string) => boolean = () => false,
    private readonly opts: TeamHubOptions = {},
  ) {
    this.#pacing = { ...PUSH_PACING, ...opts.pacing };
  }
  readonly #pacing: PushPacing;

  #prune() {
    for (const [connection, member] of this.#peers)
      if (this.workspaceFor(member.cwd) !== member.workspace || !this.trusted(member.provider, member.cwd))
        this.#leave(connection);
    const live = new Set([...this.#peers.values()].map((p) => p.workspace));
    for (const workspace of this.#dropped.keys()) if (!live.has(workspace)) this.#dropped.delete(workspace);
    this.#messages = this.#messages.filter((m) => {
      if (!live.has(m.workspace)) return false;
      if (m.at > this.now() - 60 * 60_000) return true;
      this.#drop(m);
      return false;
    });
  }

  #drop(m: Message) {
    this.#dropped.set(m.workspace, Math.max(this.#dropped.get(m.workspace) ?? 0, m.seq));
  }

  /** Recently dropped connections, so a reconnecting process keeps its id and unread messages. */
  #departed = new Map<string, { provider: TeamProvider; workspace: string; cursor: number; at: number }>();

  #leave(signal: AbortSignal) {
    const peer = this.#peers.get(signal);
    if (!peer) return;
    clearTimeout(peer.timer);
    this.#peers.delete(signal);
    this.#departed.set(peer.id, { ...peer, at: this.now() });
    for (const [id, d] of this.#departed)
      if (this.#departed.size > 64 || d.at < this.now() - 10 * 60_000) this.#departed.delete(id);
  }

  #unread(peer: Peer) {
    return this.#messages.filter(
      (m) =>
        m.seq > peer.cursor &&
        m.from !== peer.id &&
        (!m.to || m.to === peer.id) &&
        m.workspace === peer.workspace &&
        m.at > this.now() - 60 * 60_000,
    );
  }

  // Status updates never wake anyone: they ride along with the next request/result or team_read.
  #schedule(peer: Peer) {
    if (!peer.delivery.canWake || peer.timer) return;
    const p = this.#pacing,
      now = this.now();
    peer.pushes = peer.pushes.filter((t) => t > now - p.windowMs);
    let at = now + p.debounceMs;
    const last = peer.pushes.at(-1);
    if (last !== undefined) at = Math.max(at, last + p.minGapMs);
    if (peer.pushes.length >= p.maxPerWindow) at = Math.max(at, peer.pushes[0]! + p.windowMs);
    peer.timer = setTimeout(() => {
      peer.timer = undefined;
      this.#flush(peer);
    }, at - now);
    peer.timer.unref?.();
  }

  #flush(peer: Peer) {
    this.#prune();
    if (![...this.#peers.values()].includes(peer)) return;
    const pending = this.#unread(peer);
    // Already read through team_read, or only status updates left: nothing to wake for.
    if (!pending.some((m) => m.kind !== "status")) return;
    const messages = pending.slice(0, this.#pacing.maxBatch);
    const batch = {
      workspace: peer.workspace,
      historyTruncated: (this.#dropped.get(peer.workspace) ?? 0) > peer.cursor,
      more: pending.length - messages.length,
      messages,
    };
    const ok = peer.delivery.deliver(batch, { id: peer.id, provider: peer.provider, workspace: peer.workspace });
    const text = messages.map((m) => m.text).join("\u0000");
    this.opts.audit?.("team.delivered", {
      adapter: peer.delivery.id,
      ok,
      to: peer.id,
      provider: peer.provider,
      workspace: peer.workspace,
      count: messages.length,
      bytes: Buffer.byteLength(text, "utf8"),
      sha256: createHash("sha256").update(text).digest("hex"),
      seqs: messages.map((m) => m.seq),
    });
    // A failed attempt still counts against pacing, so a broken adapter retries slowly instead of spinning.
    peer.pushes.push(this.now());
    if (ok) peer.cursor = batch.more ? messages.at(-1)!.seq : this.#seq;
    if (!ok || batch.more) this.#schedule(peer);
  }

  members() {
    this.#prune();
    return [...this.#peers.values()].map(({ id, provider, workspace }) => ({ id, provider, workspace }));
  }

  call(signal: AbortSignal, action: string, raw: unknown, link: DeliveryLink | null = null): Record<string, unknown> {
    if (signal.aborted) return { ok: false, error: "closed" };
    this.#prune();
    let peer = this.#peers.get(signal);
    if (action === "team_join") {
      const p = Join.safeParse(raw);
      if (!p.success) return { ok: false, error: "bad_params" };
      const workspace = this.workspaceFor(p.data.cwd);
      if (workspace && !this.trusted(p.data.provider, p.data.cwd)) {
        this.opts.rejected?.(p.data.provider, p.data.cwd);
        return { ok: false, error: "not_trusted" };
      }
      if (!workspace) return { ok: false, error: "unknown_workspace" };
      if (peer && (peer.workspace !== workspace || peer.provider !== p.data.provider))
        return { ok: false, error: "already_joined" };
      if (!peer) {
        if (this.#peers.size >= 64) return { ok: false, error: "team_full" };
        const back = p.data.resume ? this.#departed.get(p.data.resume) : undefined;
        const resumed =
          back && back.provider === p.data.provider && back.workspace === workspace && p.data.resume ? back : null;
        if (resumed) this.#departed.delete(p.data.resume!);
        peer = {
          id: resumed ? p.data.resume! : randomUUID(),
          cwd: p.data.cwd,
          provider: p.data.provider,
          workspace,
          cursor: resumed?.cursor ?? this.#seq,
          recent: [],
          link,
          delivery: pull,
          pushes: [],
        };
        this.#peers.set(signal, peer);
        signal.addEventListener(
          "abort",
          () => {
            this.#leave(signal);
            // Forget messages after the last participant leaves a workspace.
            this.#messages = this.#messages.filter((m) =>
              [...this.#peers.values()].some((p) => p.workspace === m.workspace),
            );
          },
          { once: true },
        );
      }
    }
    if (!peer) return { ok: false, error: "join_first" };
    if (action === "team_client") {
      const p = ClientDeclaration.safeParse(raw);
      if (!p.success) return { ok: false, error: "bad_params" };
      peer.delivery = selectDelivery({ provider: peer.provider, client: p.data, link: peer.link }, this.opts.chain);
      this.opts.audit?.("team.delivery_selected", {
        peer: peer.id,
        provider: peer.provider,
        workspace: peer.workspace,
        adapter: peer.delivery.id,
        client: p.data.name ?? null,
      });
      if (this.#unread(peer).some((m) => m.kind !== "status")) this.#schedule(peer);
      return { ok: true, result: { self: peer.id, delivery: peer.delivery.id, wakes: peer.delivery.canWake } };
    }
    if (action === "team_read" && !z.object({}).strict().safeParse(raw).success)
      return { ok: false, error: "bad_params" };
    if (action === "team_send") {
      const p = Send.safeParse(raw);
      if (!p.success) return { ok: false, error: "bad_params" };
      if (
        p.data.to &&
        ![...this.#peers.values()].some(
          (other) => other.id === p.data.to && other.id !== peer.id && other.workspace === peer.workspace,
        )
      )
        return { ok: false, error: "recipient_unavailable" };
      peer.recent = peer.recent.filter((t) => t > this.now() - 60_000);
      if (peer.recent.length >= 30) return { ok: false, error: "rate_limited" };
      peer.recent.push(this.now());
      this.#messages.push({
        seq: ++this.#seq,
        workspace: peer.workspace,
        from: peer.id,
        provider: peer.provider,
        ...p.data,
        at: this.now(),
      });
      // The cap is per workspace: a busy workspace never pushes out another's unread messages.
      const own = this.#messages.filter((m) => m.workspace === peer.workspace);
      if (own.length > 64) {
        const drop = own[0]!;
        this.#messages = this.#messages.filter((m) => m !== drop);
        this.#drop(drop);
      }
      const sent = this.#messages.at(-1)!;
      if (sent.kind !== "status")
        for (const other of this.#peers.values())
          if (other.id !== peer.id && other.workspace === peer.workspace && (!sent.to || sent.to === other.id))
            this.#schedule(other);
    } else if (action !== "team_join" && action !== "team_read") return { ok: false, error: "unknown_tool" };
    const historyTruncated = (this.#dropped.get(peer.workspace) ?? 0) > peer.cursor;
    const messages = this.#unread(peer);
    peer.cursor = this.#seq;
    return {
      ok: true,
      result: {
        self: peer.id,
        workspace: peer.workspace,
        historyTruncated,
        peers: [...this.#peers.values()]
          .filter((p) => p.workspace === peer.workspace && p.id !== peer.id)
          .map((p) => ({ id: p.id, provider: p.provider })),
        messages,
      },
    };
  }
}
