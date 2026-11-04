import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { selectDelivery, type DeliveryAdapter, type DeliveryFactory } from "./delivery/index.js";
import { ClientDeclaration, type DeliveryLink, type TeamMessage } from "./delivery/types.js";
import { pull } from "./delivery/pull.js";
import type { ResponderJob } from "./responder.js";

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
    /** The responder run that started this process (CHALITO_TEAM_RUN). */
    run: z.string().uuid().optional(),
  })
  .strict();
const Send = z
  .object({
    /** A teammate id from team_read, or an app name ("codex") to reach it even when no session is open. */
    to: z.union([z.string().uuid(), TeamProvider]).optional(),
    kind: z.enum(["status", "request", "result"]).default("status"),
    text: z.string().trim().min(1).max(8000),
  })
  .strict();
/** taken: a session of the app read it or its CLI took it. cwd: the asker's folder, where a CLI runs.
 *  reservedFor: an ackOnRead session it was pushed to, so other sessions of the app don't also act on it. */
type Message = TeamMessage & { taken?: boolean; cwd?: string; reservedFor?: string; reservedAt?: number };
/** A reservation held this long by a session that can no longer be woken is released to others or the CLI. */
const RESERVE_MS = 10 * 60_000;
/** The mcp process's report on an ackOnRead push: ok false hands the seqs back for retry or the responder. */
const DeliveryResult = z.object({ seqs: z.array(z.number().int().positive()).max(64), ok: z.boolean() }).strict();
const HOUR = 60 * 60_000;
/** Messages for an app with no open session wait this long for one, or for its responder. */
const HELD_MS = 24 * HOUR;
const held = (m: Message) => !!m.toProvider && !m.taken;
const view = ({ taken: _t, cwd: _c, reservedFor: _r, reservedAt: _a, ...m }: Message): TeamMessage => m;
/** One argument holds the whole prompt: Linux caps it at 128 KiB, Windows the command line at 32 KiB. */
const PROMPT_BUDGET = 24_000;
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
  /** Joined while its app's CLI was running here: most likely that CLI, so its requests start no CLI. */
  spawned: boolean;
  /** Its last push failed: it can't be counted on to wake until one succeeds. */
  failing: boolean;
  /** ackOnRead adapters: seqs already pushed and still unread, so they are not pushed again. */
  pushed: Set<number>;
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
  /** Runs the app's CLI for one turn when a request names it and none of its sessions can be woken.
   *  Resolves to its answer, or null when the app has no CLI here. */
  responder?: { has(provider: string): boolean; run(job: ResponderJob): Promise<string | null> };
  /** At most this many responder runs per workspace per window (default 12 per 10 min). */
  responderLimit?: { max: number; windowMs: number };
}

/** Same-user, local messaging only. Provider names are labels, never proof of identity or authority. */
export class TeamHub {
  #peers = new Map<AbortSignal, Peer>();
  #messages: Message[] = [];
  /** Highest seq dropped unread per workspace (cap or expiry), for historyTruncated. */
  #dropped = new Map<string, number>();
  #seq = 0;
  /** This hub's run: seqs start over with a new one, so helpers key what they've seen by it. */
  readonly #instance = randomUUID();
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
    const byId = new Map([...this.#peers.values()].map((p) => [p.id, p]));
    for (const m of this.#messages) {
      if (!m.reservedFor) continue;
      const owner = byId.get(m.reservedFor);
      if (owner && (owner.delivery.canWake || (m.reservedAt ?? 0) > this.now() - RESERVE_MS)) continue;
      delete m.reservedFor;
      if (owner) {
        this.#wakeApp(owner.workspace, owner.provider);
        this.#retryHeld(owner.workspace, owner.provider);
      }
    }
    this.#messages = this.#messages.filter((m) => {
      if (held(m)) return m.at > this.now() - HELD_MS;
      if (!live.has(m.workspace)) return false;
      if (m.at > this.now() - HOUR) return true;
      this.#drop(m);
      return false;
    });
  }

  #drop(m: Message) {
    this.#dropped.set(m.workspace, Math.max(this.#dropped.get(m.workspace) ?? 0, m.seq));
  }

  /** Recently dropped connections, so a reconnecting process keeps its id and unread messages. */
  #departed = new Map<
    string,
    { provider: TeamProvider; workspace: string; cursor: number; pushed: Set<number>; at: number }
  >();

  #leave(signal: AbortSignal) {
    const peer = this.#peers.get(signal);
    if (!peer) return;
    clearTimeout(peer.timer);
    this.#peers.delete(signal);
    for (const m of this.#messages) if (m.reservedFor === peer.id) delete m.reservedFor;
    this.#departed.set(peer.id, {
      provider: peer.provider,
      workspace: peer.workspace,
      cursor: peer.cursor,
      pushed: peer.pushed,
      at: this.now(),
    });
    for (const [id, d] of this.#departed)
      if (this.#departed.size > 64 || d.at < this.now() - 10 * 60_000) this.#departed.delete(id);
    // A request it was going to be pushed, or had reserved, may now go to another session or the app's CLI.
    this.#wakeApp(peer.workspace, peer.provider);
    this.#retryHeld(peer.workspace, peer.provider);
  }

  /** The CLI's own team server says its run id; a CLI that doesn't pass env is matched by folder and time. */
  #isRun(workspace: string, provider: string, cwd: string, run?: string) {
    const r = this.#running.get(`${workspace}\u0000${provider}`);
    if (!r) return false;
    if (run) return run === r.run;
    return cwd === r.cwd && this.now() - r.at < 60_000;
  }

  /** Released by-name messages: every live session of the app gets a chance to be pushed them. */
  #wakeApp(workspace: string, provider: string) {
    for (const p of this.#peers.values()) if (p.workspace === workspace && p.provider === provider) this.#schedule(p);
  }

  #retryHeld(workspace: string, provider: string) {
    const first = this.#messages.find(
      (m) => m.workspace === workspace && m.toProvider === provider && held(m) && m.kind === "request" && m.cwd,
    );
    if (first) this.#respond(workspace, provider, first.cwd!);
  }

  #unread(peer: Peer) {
    return this.#messages.filter((m) =>
      m.workspace !== peer.workspace || m.from === peer.id
        ? false
        : m.toProvider
          ? m.toProvider === peer.provider &&
            !m.taken &&
            (!m.reservedFor || m.reservedFor === peer.id) &&
            m.at > this.now() - HELD_MS
          : m.seq > peer.cursor && (!m.to || m.to === peer.id) && m.at > this.now() - HOUR,
    );
  }

  /** A message to an app by name goes to one of its sessions: the first that reads it, or gets it pushed. */
  #seen(messages: readonly Message[]) {
    for (const m of messages) if (m.toProvider) m.taken = true;
  }

  /** Responder runs in progress, by workspace + app. */
  #running = new Map<string, { run: string; cwd: string; at: number }>();
  #runs = new Map<string, number[]>();

  /** No session of the app can be woken: hand its waiting requests to its CLI for one turn. */
  #respond(workspace: string, provider: string, cwd: string) {
    const r = this.opts.responder;
    const key = `${workspace}\u0000${provider}`;
    // Trust can be revoked while a request waits: checked on every path that starts a CLI.
    if (!r || this.#running.has(key) || !this.trusted(provider, cwd) || !r.has(provider)) return;
    const live = [...this.#peers.values()].filter((p) => p.workspace === workspace && p.provider === provider);
    if (live.some((p) => p.delivery.canWake && !p.failing)) return;
    // Not what a live session of the app was handed: that one may already be doing it.
    const reservedLive = new Set(live.map((p) => p.id));
    const all = this.#messages.filter(
      (m) =>
        m.workspace === workspace &&
        m.toProvider === provider &&
        held(m) &&
        !(m.reservedFor && reservedLive.has(m.reservedFor)),
    );
    // Only a request from a session the user runs starts a CLI (one Chalito started has no cwd).
    if (!all.some((m) => m.kind === "request" && m.cwd)) return;
    // What doesn't fit in one prompt waits for the next turn.
    let size = 0;
    const waiting = all.filter((m, i) => (size += m.text.length) <= PROMPT_BUDGET || i === 0);
    const limit = this.opts.responderLimit ?? { max: 12, windowMs: 10 * 60_000 };
    const runs = (this.#runs.get(workspace) ?? []).filter((t) => t > this.now() - limit.windowMs);
    if (runs.length >= limit.max) {
      this.opts.audit?.("team.responder_limited", { workspace, provider });
      return;
    }
    runs.push(this.now());
    this.#runs.set(workspace, runs);
    for (const m of waiting) m.taken = true;
    const runId = randomUUID();
    this.#running.set(key, { run: runId, cwd, at: this.now() });
    this.opts.audit?.("team.responder_started", { workspace, provider, run: runId, seqs: waiting.map((m) => m.seq) });
    const job: ResponderJob = { run: runId, provider, workspace, cwd, messages: waiting.map(view) };
    void r
      .run(job)
      .catch((e: unknown) => `(${provider} could not answer: ${e instanceof Error ? e.message : "error"})`)
      .then((answer) => {
        this.#running.delete(key);
        this.opts.audit?.("team.responder_finished", { workspace, provider, run: runId, answered: !!answer });
        // Its CLI went away: the messages wait for a session of the app instead.
        if (answer === null) {
          for (const m of waiting) {
            m.taken = false;
            if (!this.#messages.includes(m)) this.#messages.push(m);
          }
          this.#messages.sort((x, y) => x.seq - y.seq);
        }
        if (answer) for (const sender of new Set(waiting.map((m) => m.from))) this.#reply(runId, job, sender, answer);
        // Requests that arrived while it ran get their own turn.
        this.#respond(workspace, provider, cwd);
      });
  }

  /** The responder's answer, as a result from that app to whoever asked. */
  #reply(runId: string, job: ResponderJob, sender: string, answer: string) {
    const to = [...this.#peers.values()].find((p) => p.id === sender && p.workspace === job.workspace);
    const asker = job.messages.find((m) => m.from === sender);
    const text = answer.length > 8000 ? `${answer.slice(0, 7990)}\n[cut]` : answer;
    this.#post({
      seq: 0,
      workspace: job.workspace,
      from: runId,
      provider: job.provider,
      ...(to ? { to: to.id } : asker ? { toProvider: asker.provider } : {}),
      kind: "result",
      text,
      at: this.now(),
    });
  }

  /** Stores a message, caps the workspace's history, and wakes whoever it is for. */
  #post(message: Message) {
    message.seq = ++this.#seq;
    this.#messages.push(message);
    // The cap is per workspace: a busy workspace never pushes out another's unread messages.
    const own = this.#messages.filter((m) => m.workspace === message.workspace && !held(m));
    if (own.length > 64) {
      const drop = own[0]!;
      this.#messages = this.#messages.filter((m) => m !== drop);
      this.#drop(drop);
    }
    const waiting = this.#messages.filter((m) => m.workspace === message.workspace && held(m));
    if (waiting.length > 64) {
      this.#messages = this.#messages.filter((m) => m !== waiting[0]);
      this.#drop(waiting[0]!);
    }
    if (message.kind === "status") return;
    for (const other of this.#peers.values())
      if (
        other.id !== message.from &&
        other.workspace === message.workspace &&
        (message.toProvider ? other.provider === message.toProvider : !message.to || message.to === other.id)
      )
        this.#schedule(other);
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
    const live = new Set(this.#messages.map((m) => m.seq));
    for (const seq of peer.pushed) if (!live.has(seq)) peer.pushed.delete(seq);
    const pending = this.#unread(peer).filter((m) => !peer.pushed.has(m.seq));
    // Already read through team_read, or only status updates left: nothing to wake for.
    if (!pending.some((m) => m.kind !== "status")) return;
    const messages = pending.slice(0, this.#pacing.maxBatch);
    const batch = {
      workspace: peer.workspace,
      historyTruncated: (this.#dropped.get(peer.workspace) ?? 0) > peer.cursor,
      more: pending.length - messages.length,
      messages: messages.map(view),
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
    peer.failing = !ok;
    if (!ok) this.#retryHeld(peer.workspace, peer.provider);
    if (ok && peer.delivery.ackOnRead)
      for (const m of messages) {
        peer.pushed.add(m.seq);
        if (m.toProvider) {
          m.reservedFor = peer.id;
          m.reservedAt = this.now();
        }
      }
    else if (ok) {
      peer.cursor = batch.more
        ? Math.max(peer.cursor, ...messages.filter((m) => !m.toProvider).map((m) => m.seq))
        : this.#seq;
      this.#seen(messages);
    }
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
    // A resumed join leaves the unread messages for the push or the next team_read.
    let resumedNow = false;
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
          back &&
          back.provider === p.data.provider &&
          back.workspace === workspace &&
          back.at > this.now() - 10 * 60_000
            ? back
            : null;
        if (resumed) {
          this.#departed.delete(p.data.resume!);
          resumedNow = true;
        }
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
          spawned: this.#isRun(workspace, p.data.provider, p.data.cwd, p.data.run),
          failing: false,
          pushed: resumed?.pushed ?? new Set(),
        };
        this.#peers.set(signal, peer);
        signal.addEventListener(
          "abort",
          () => {
            this.#leave(signal);
            // Forget messages after the last participant leaves a workspace; ones held for an app stay.
            this.#messages = this.#messages.filter(
              (m) => held(m) || [...this.#peers.values()].some((p) => p.workspace === m.workspace),
            );
          },
          { once: true },
        );
      }
    }
    if (!peer) return { ok: false, error: "join_first" };
    if (action === "team_join" && resumedNow)
      return {
        ok: true,
        result: {
          self: peer.id,
          hub: this.#instance,
          workspace: peer.workspace,
          historyTruncated: false,
          peers: [],
          messages: [],
        },
      };
    if (action === "team_client") {
      const p = ClientDeclaration.safeParse(raw);
      if (!p.success) return { ok: false, error: "bad_params" };
      const before = peer.delivery;
      peer.delivery = selectDelivery({ provider: peer.provider, client: p.data, link: peer.link }, this.opts.chain);
      // Its push route changed (the mod left): what it was already handed may be a turn in progress, so it stays
      // reserved for this session (its team_read or leaving frees it), never handed to a second one.
      if (before.ackOnRead && before.id !== peer.delivery.id) {
        peer.failing = false;
        // A reloaded mod lost what it held: pushed again when one returns (a live one dedupes by epoch:seq).
        peer.pushed.clear();
      }
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
    if (action === "team_delivery") {
      const p = DeliveryResult.safeParse(raw);
      if (!p.success) return { ok: false, error: "bad_params" };
      // A failure counts even after the session re-declared (the report trails it): what it held must be freed.
      if (p.data.ok) {
        if (!peer.delivery.ackOnRead) return { ok: true, result: {} };
        peer.failing = false;
        return { ok: true, result: {} };
      }
      const seqs = new Set(p.data.seqs);
      for (const seq of seqs) peer.pushed.delete(seq);
      for (const m of this.#messages) if (seqs.has(m.seq) && m.reservedFor === peer.id) delete m.reservedFor;
      // Already read through team_read: nothing was lost, so this session still counts as wakeable.
      if (!this.#unread(peer).some((m) => seqs.has(m.seq))) return { ok: true, result: {} };
      peer.failing = true;
      this.opts.audit?.("team.delivery_failed", {
        adapter: peer.delivery.id,
        to: peer.id,
        workspace: peer.workspace,
        seqs: [...seqs],
      });
      // Retried at the paced rate; a request to the app by name may go to its CLI meanwhile.
      this.#retryHeld(peer.workspace, peer.provider);
      this.#wakeApp(peer.workspace, peer.provider);
      return { ok: true, result: {} };
    }
    if (action === "team_read" && !z.object({}).strict().safeParse(raw).success)
      return { ok: false, error: "bad_params" };
    if (action === "team_send") {
      const p = Send.safeParse(raw);
      if (!p.success) return { ok: false, error: "bad_params" };
      const { to, ...rest } = p.data;
      let address: { to: string } | { toProvider: string } | Record<string, never> = {};
      if (to && z.string().uuid().safeParse(to).success) {
        const live = [...this.#peers.values()].some(
          (other) => other.id === to && other.id !== peer.id && other.workspace === peer.workspace,
        );
        const gone = this.#departed.get(to);
        // A teammate that just left: its app gets the message instead of losing it.
        if (live) address = { to };
        else if (gone && gone.workspace === peer.workspace) address = { toProvider: gone.provider };
        else return { ok: false, error: "recipient_unavailable" };
      } else if (to) {
        if (!this.trusted(to, peer.cwd)) return { ok: false, error: "recipient_not_trusted" };
        address = { toProvider: to };
      }
      peer.recent = peer.recent.filter((t) => t > this.now() - 60_000);
      if (peer.recent.length >= 30) return { ok: false, error: "rate_limited" };
      peer.recent.push(this.now());
      this.#post({
        seq: 0,
        workspace: peer.workspace,
        from: peer.id,
        provider: peer.provider,
        ...rest,
        ...address,
        at: this.now(),
        // A CLI Chalito started may ask a session that's open, never start another CLI: no chains or loops.
        ...(peer.spawned ? {} : { cwd: peer.cwd }),
      });
      if ("toProvider" in address && rest.kind === "request" && !peer.spawned)
        this.#respond(peer.workspace, address.toProvider, peer.cwd);
    } else if (action !== "team_join" && action !== "team_read") return { ok: false, error: "unknown_tool" };
    const historyTruncated = (this.#dropped.get(peer.workspace) ?? 0) > peer.cursor;
    // The join is the mcp process starting, not the model reading: held messages wait for team_read.
    const unread = action === "team_join" ? [] : this.#unread(peer);
    this.#seen(unread);
    const messages = unread.map(view);
    peer.cursor = this.#seq;
    if (action !== "team_join") peer.pushed.clear();
    return {
      ok: true,
      result: {
        self: peer.id,
        hub: this.#instance,
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
