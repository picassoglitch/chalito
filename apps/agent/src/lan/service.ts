import { lanAdvertId, fromB64url } from "@chalito/crypto";
import {
  LAN_MAX_MESSAGE_BYTES,
  LAN_WS_PATH,
  type AgentEvent,
  type LanFrame,
  type LanGrant,
  type LanToken,
  type SignedCommand,
} from "@chalito/protocol";
import { publicReason } from "../command-result.js";
import type { Logger } from "../redact.js";
import type { LanCloud } from "./cloud.js";
import { LanAuthError, dialHandshake, listenHandshake, type HandshakeContext, type SecureLink } from "./handshake.js";
import type { DiscoveredService, Discovery } from "./mdns.js";
import { dialLan, listenLan, type LanListener } from "./ws.js";

/**
 * The LAN direct path (ADR 0022 §5). Off unless local policy turns it on (`policy.lan.enabled`).
 *
 * - Discovery: advertises an opaque id that rotates with every window and every token, and maps
 *   the ids it sees back to the owner's other agents (only a token holder can).
 * - Links: mutual auth with the cloud-issued token plus device keys (handshake.ts). The device with
 *   the lower id dials, so two agents keep one link.
 * - Inbound: a `cmd` frame is handed to the same AgentCore.handleCommand as a cloud row, so the
 *   signature (local trusted list), nonce, TTL, target and owner checks are the cloud path's own.
 * - Outbound: `sendCommand` tries the link and falls back to the cloud on any failure; events are
 *   copied to the links while the durable write still goes to the cloud (lan/tee.ts).
 */

export interface LanPolicy {
  enabled: boolean;
  port: number;
}

export type CommandOutcome = { ok: boolean; reason?: string };

export interface LanServiceDeps {
  self: { deviceId: string; sign: HandshakeContext["sign"] };
  cloud: LanCloud;
  /** Created when the service starts (and closed when it stops). */
  discovery: () => Promise<Discovery>;
  policy: () => LanPolicy | undefined;
  /** AgentCore.handleCommand: the cloud path's own verification. */
  handleCommand(id: string, doc: Record<string, unknown>): Promise<CommandOutcome>;
  /** Events another of the owner's agents sent over the link (already bound to that agent). */
  onPeerEvent?(fromDeviceId: string, e: AgentEvent): void;
  now: () => number;
  log: Logger;
  /** Bind address of the listener (all interfaces by default: it's the LAN path). */
  host?: string;
  ackTimeoutMs?: number;
  dialTimeoutMs?: number;
  /** All the addresses of one peer are tried within this long (default LAN_DIAL_DEADLINE_MS). */
  dialDeadlineMs?: number;
  /** How often to refresh the grant (revocations), re-advertise and query (default 30 s). */
  tickMs?: number;
  /** Advertised-id rotation window (default 5 min). */
  advertWindowMs?: number;
  every?: (fn: () => void, ms: number) => { clear(): void };
}

/** Per-link inbound command bucket, like the cloud's per-device S7 limit on `commands`. */
const CMD_BURST = 30;
const CMD_REFILL_PER_S = 1;
/** At most this many advertised addresses are dialled per peer (a flood of A records is cut off)… */
export const LAN_MAX_DIAL_ADDRESSES = 4;
/** …within this long in all, however slow each one is. */
export const LAN_DIAL_DEADLINE_MS = 8000;
/** Unknown advertised ids may trigger a grant refresh at most this often. */
const UNKNOWN_REFRESH_MS = 60 * 1000;

const defaultEvery = (fn: () => void, ms: number) => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return { clear: () => clearInterval(t) };
};

export class LanService {
  #grant: LanGrant | null = null;
  #grantAt = 0;
  #listener: LanListener | null = null;
  #discovery: Discovery | null = null;
  #ticker: { clear(): void } | null = null;
  #running = false;
  #starting: Promise<void> | null = null;
  readonly #links = new Map<string, SecureLink>();
  readonly #dialing = new Set<string>();
  /** advertised id → which peer and token it stands for (recomputed per window and grant). */
  #names = new Map<string, { deviceId: string; token: LanToken }>();
  #namesKey = "";
  #lastUnknownRefresh = 0;
  readonly #acks = new Map<string, (r: CommandOutcome | null) => void>();
  readonly #buckets = new Map<SecureLink, { tokens: number; at: number }>();

  constructor(private readonly d: LanServiceDeps) {}

  get running(): boolean {
    return this.#running;
  }
  /** Device ids of the owner's agents with a live link. */
  peers(): string[] {
    return [...this.#links.keys()];
  }
  get port(): number | null {
    return this.#listener?.port ?? null;
  }

  /** Starts or stops to match local policy. Called at start and on every policy change; never throws. */
  async onPolicyChange(): Promise<void> {
    try {
      await this.#apply();
    } catch (err) {
      // E.g. the port is taken: the LAN path stays off, the cloud path carries everything.
      this.d.log.error("lan.start_failed", { error: err instanceof Error ? err.message : "error" });
      await this.stop("start_failed").catch(() => undefined);
    }
  }

  async #apply(): Promise<void> {
    const p = this.d.policy();
    if (p?.enabled && !this.#running) await this.start();
    else if (!p?.enabled && this.#running) await this.stop("policy_off");
    else if (p?.enabled && this.#running && this.#listener && p.port !== 0 && p.port !== this.#listener.port) {
      await this.stop("port_changed");
      await this.start();
    }
  }

  async start(): Promise<void> {
    if (this.#running) return;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => (this.#starting = null));
    return this.#starting;
  }

  async #start(): Promise<void> {
    const p = this.d.policy();
    if (!p?.enabled) return;
    try {
      await this.#refreshGrant();
    } catch (err) {
      // No token, no LAN: everything keeps going through the cloud.
      this.d.log.warn("lan.grant_failed", { error: err instanceof Error ? err.message : "error" });
      return;
    }
    this.#listener = await listenLan({
      host: this.d.host ?? "0.0.0.0",
      port: p.port,
      path: LAN_WS_PATH,
      maxBytes: LAN_MAX_MESSAGE_BYTES,
      maxConnections: 16,
      maxPerAddress: 3,
      onConn: (conn) => {
        listenHandshake(conn, this.#ctx())
          .then((link) => this.#adopt(link))
          .catch((err: unknown) => this.#authFailed("listen", err, conn.remote));
      },
    });
    this.#discovery = await this.d.discovery();
    this.#discovery.onFound((s) => void this.#onFound(s));
    this.#running = true;
    await this.#advertise();
    this.#discovery.query();
    this.#ticker = (this.d.every ?? defaultEvery)(() => void this.tick(), this.d.tickMs ?? 30_000);
    this.d.log.info("lan.started", { port: this.#listener.port, peers: this.#grant?.peers.length ?? 0 });
  }

  async stop(reason = "stop"): Promise<void> {
    if (this.#starting) await this.#starting.catch(() => undefined);
    if (!this.#running && !this.#listener && !this.#discovery) return;
    this.#running = false;
    this.#ticker?.clear();
    this.#ticker = null;
    for (const l of this.#links.values()) l.close(reason);
    this.#links.clear();
    for (const r of this.#acks.values()) r(null);
    this.#acks.clear();
    await this.#discovery?.close().catch(() => undefined);
    this.#discovery = null;
    await this.#listener?.close().catch(() => undefined);
    this.#listener = null;
    this.d.log.info("lan.stopped", { reason });
  }

  /** Periodic upkeep: grant refresh, peer revocation, advert rotation, a discovery query. */
  async tick(): Promise<void> {
    if (!this.#running) return;
    // Every tick, so a revocation in the directory ends links within one tick (the cloud mints a
    // new token only when the newest has less than 5 minutes left).
    await this.#refreshGrant().catch((err: unknown) =>
      this.d.log.warn("lan.grant_failed", { error: err instanceof Error ? err.message : "error" }),
    );
    const now = this.d.now();
    // Without a fresh grant, links end with their token (the cloud stays the path).
    if (this.#grant && !this.#grant.tokens.some((t) => t.expiresAt > now)) this.#grant = null;
    for (const [id, link] of this.#links) {
      if (!this.#peerKey(id)) link.close("peer_revoked");
      else if (link.tokenExpiresAt <= now) link.close("token_expired");
    }
    if (!this.#running) return;
    await this.#advertise();
    this.#discovery?.query();
  }

  // ---------------------------------------------------------------- outbound

  /**
   * Sends a client-signed command to another of the owner's agents: over the link when there is
   * one, else (and on any transport failure or a missing ack) through `cloud`. A definite answer
   * from the peer (accepted or refused) is final: the cloud would see the same command (and the
   * same nonce) and refuse it as a replay.
   */
  async sendCommand(
    target: string,
    id: string,
    env: SignedCommand,
    cloud: () => Promise<void>,
  ): Promise<{ via: "lan" | "cloud"; ok?: boolean; reason?: string }> {
    const link = this.#links.get(target);
    if (link) {
      const ack = await this.#sendAndWait(link, id, env);
      if (ack) return { via: "lan", ...ack };
      this.d.log.warn("lan.fallback", { target, cid: id });
    }
    await cloud();
    return { via: "cloud" };
  }

  #sendAndWait(link: SecureLink, id: string, env: SignedCommand): Promise<CommandOutcome | null> {
    const key = `${link.peerDeviceId}:${id}`;
    if (this.#acks.has(key)) return Promise.resolve(null);
    return new Promise<CommandOutcome | null>((resolve) => {
      const t = setTimeout(() => done(null), this.d.ackTimeoutMs ?? 3000);
      const done = (r: CommandOutcome | null) => {
        clearTimeout(t);
        this.#acks.delete(key);
        resolve(r);
      };
      this.#acks.set(key, done);
      link.send({ k: "cmd", id, env }).catch(() => done(null));
    });
  }

  /** Best-effort live copy of an event to every link (the durable copy goes to the cloud). */
  broadcastEvent(e: AgentEvent): void {
    for (const l of this.#links.values()) l.send({ k: "evt", e }).catch(() => undefined);
  }

  // ---------------------------------------------------------------- inbound

  #adopt(link: SecureLink) {
    if (!this.#running) return link.close("stopped");
    const prev = this.#links.get(link.peerDeviceId);
    this.#links.set(link.peerDeviceId, link);
    prev?.close("replaced");
    this.#buckets.set(link, { tokens: CMD_BURST, at: this.d.now() });
    link.onFrame((f) => void this.#onFrame(link, f));
    link.onClose((reason) => {
      this.#buckets.delete(link);
      if (this.#links.get(link.peerDeviceId) === link) this.#links.delete(link.peerDeviceId);
      // Waiting commands fall back to the cloud now rather than at their ack timeout.
      for (const [key, done] of this.#acks) if (key.startsWith(`${link.peerDeviceId}:`)) done(null);
      this.d.log.info("lan.link_down", { peer: link.peerDeviceId, reason });
    });
    this.d.log.info("lan.link_up", { peer: link.peerDeviceId });
  }

  #take(link: SecureLink): boolean {
    const b = this.#buckets.get(link);
    if (!b) return false;
    const now = this.d.now();
    b.tokens = Math.min(CMD_BURST, b.tokens + ((now - b.at) / 1000) * CMD_REFILL_PER_S);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  async #onFrame(link: SecureLink, f: LanFrame) {
    switch (f.k) {
      case "cmd": {
        const ack = (ok: boolean, reason?: string) =>
          link.send({ k: "ack", id: f.id, ok, ...(reason ? { reason } : {}) }).catch(() => undefined);
        if (!this.#take(link)) return ack(false, "rate_limited");
        if (f.env.body.cid !== f.id) return ack(false, "invalid");
        if (f.env.body.targetDeviceId !== this.d.self.deviceId) return ack(false, "wrong_device");
        const r = await this.d.handleCommand(f.id, { env: f.env, via: "lan" });
        return ack(r.ok, r.ok ? undefined : publicReason(r.reason));
      }
      case "ack": {
        const key = `${link.peerDeviceId}:${f.id}`;
        this.#acks.get(key)?.({ ok: f.ok, ...(f.reason ? { reason: f.reason } : {}) });
        return;
      }
      case "evt":
        // The link authenticated the sender; an event about another device is refused.
        if (f.e.deviceId !== link.peerDeviceId) return link.close("wrong_event_source");
        this.d.onPeerEvent?.(link.peerDeviceId, f.e);
        return;
      case "bye":
        return;
    }
  }

  // ---------------------------------------------------------------- discovery and grant

  #ctx(): HandshakeContext {
    return {
      deviceId: this.d.self.deviceId,
      sign: this.d.self.sign,
      tokens: () => this.#grant?.tokens ?? [],
      peerKey: (id) => this.#peerKey(id),
      now: this.d.now,
    };
  }

  #peerKey(deviceId: string): string | null {
    return this.#grant?.peers.find((p) => p.deviceId === deviceId)?.pubSign ?? null;
  }

  async #refreshGrant() {
    const g = await this.d.cloud.grant();
    const now = this.d.now();
    const tokens = g.tokens.filter((t) => t.expiresAt > now).sort((a, b) => b.expiresAt - a.expiresAt);
    if (!tokens.length) throw new Error("lan: no live token");
    this.#grant = { tokens, peers: g.peers.filter((p) => p.deviceId !== this.d.self.deviceId) };
    this.#grantAt = now;
  }

  #window(now = this.d.now()) {
    return Math.floor(now / (this.d.advertWindowMs ?? 5 * 60 * 1000));
  }

  async #advertise() {
    const token = this.#grant?.tokens[0];
    if (!token || !this.#listener || !this.#discovery) return;
    const id = await lanAdvertId(await fromB64url(token.secret), this.d.self.deviceId, this.#window());
    this.#discovery.advertise(id, this.#listener.port);
  }

  /** Every name the owner's other agents could be advertising now (each token, this and the last window). */
  async #nameMap() {
    const w = this.#window();
    const key = `${w}:${this.#grantAt}`;
    if (key === this.#namesKey) return this.#names;
    const next = new Map<string, { deviceId: string; token: LanToken }>();
    for (const token of this.#grant?.tokens ?? []) {
      const secret = await fromB64url(token.secret);
      for (const p of this.#grant?.peers ?? [])
        for (const win of [w - 1, w, w + 1])
          next.set(await lanAdvertId(secret, p.deviceId, win), { deviceId: p.deviceId, token });
    }
    this.#names = next;
    this.#namesKey = key;
    return next;
  }

  async #onFound(s: DiscoveredService) {
    if (!this.#running) return;
    let hit = (await this.#nameMap()).get(s.id);
    if (!hit) {
      // Another owner's agent, or one of ours on a token we haven't fetched yet.
      const now = this.d.now();
      if (now - this.#lastUnknownRefresh < UNKNOWN_REFRESH_MS) return;
      this.#lastUnknownRefresh = now;
      await this.#refreshGrant().catch(() => undefined);
      hit = (await this.#nameMap()).get(s.id);
      if (!hit) return;
    }
    const peer = hit.deviceId;
    // One link per pair: the lower device id dials.
    if (this.d.self.deviceId > peer || this.#links.has(peer) || this.#dialing.has(peer)) return;
    this.#dialing.add(peer);
    const deadline = this.d.now() + (this.d.dialDeadlineMs ?? LAN_DIAL_DEADLINE_MS);
    try {
      for (const addr of [...new Set(s.addresses)].slice(0, LAN_MAX_DIAL_ADDRESSES)) {
        if (this.d.now() >= deadline || !this.#running) {
          this.d.log.warn("lan.dial_deadline", { peer });
          return;
        }
        try {
          const conn = await dialLan(
            `ws://${addr}:${s.port}${LAN_WS_PATH}`,
            LAN_MAX_MESSAGE_BYTES,
            this.d.dialTimeoutMs ?? 3000,
          );
          const link = await dialHandshake(conn, this.#ctx(), hit.token, peer);
          this.#adopt(link);
          return;
        } catch (err) {
          this.#authFailed("dial", err, addr);
        }
      }
    } finally {
      this.#dialing.delete(peer);
    }
  }

  #authFailed(side: "dial" | "listen", err: unknown, remote: string) {
    if (err instanceof LanAuthError) this.d.log.warn("lan.auth_failed", { side, reason: err.reason, remote });
    else this.d.log.warn("lan.connect_failed", { side, remote, error: err instanceof Error ? err.message : "error" });
  }
}
