import type { AgentLinkSummary, RelayedCommand, SealedEnvelope } from "@chalito/protocol";
import type { SupaClient } from "../supabase-store.js";

/** One published link: plaintext metadata, details sealed to the person's clients. */
export interface PublishedLink {
  summary: AgentLinkSummary;
  /** When the link was made here: a link first published after a revoke-all but made before it arrives revoked. */
  createdAt: number;
  detailsCt: SealedEnvelope;
}

/**
 * A link's row in the cloud mirror. A link with no row is absent from the answer: it was never
 * published (or its publish failed), so revoke-all had nothing to mark. Delivery needs "active".
 */
export type CloudLinkStatus = "active" | "revoked";

/**
 * What links need from the cloud (ADR 0022 §3). Nothing here grants anything: the cloud carries
 * relays between the owner's agents, shows the links on the phone, and can say a link was
 * revoked (revoke-all). The links themselves, and every key a relay is checked against, are
 * local (links/storage.ts).
 */
export interface LinkCloud {
  /** A relay to another of the owner's agents (chalito.commands; RLS: an active agent, agent-link only). */
  queueCommand(targetDeviceId: string, cid: string, env: RelayedCommand, expiresAt: number): Promise<void>;
  /** This device's links for the person's clients: plaintext metadata, details sealed to them. */
  publishLinks(rows: PublishedLink[]): Promise<void>;
  /** The mirror rows of these link ids (revoke-all marks them); an id without a row is left out. */
  linkStatus(ids: string[]): Promise<Map<string, CloudLinkStatus>>;
}

/**
 * For tests and setups without a cloud. Like chalito.publish_agent_links: a published link gets a
 * row, a revoked row stays revoked, and after `revokeAll()` a link made before it arrives revoked.
 * (Rows aren't kept per device, so two test agents can share one.)
 */
export class MemoryLinkCloud implements LinkCloud {
  queued: { targetDeviceId: string; cid: string; env: RelayedCommand; expiresAt: number }[] = [];
  published: PublishedLink[] = [];
  /** link id → revoked? (the mirror). */
  readonly rows = new Map<string, boolean>();
  /** Test hook: ids the account revoked (revoke-all), whether or not they have a row. */
  revoked = new Set<string>();
  /** Test hook: the next this-many publishes fail. */
  failPublishes = 0;
  /** Test hook: every status lookup fails (the cloud is unreachable). */
  statusFails = false;
  #revokedAllAt: number | null = null;
  /** Test hook: where queued relays go (another agent's handleCommand). */
  deliver?: (targetDeviceId: string, cid: string, env: RelayedCommand) => Promise<void>;
  async queueCommand(targetDeviceId: string, cid: string, env: RelayedCommand, expiresAt: number) {
    this.queued.push({ targetDeviceId, cid, env, expiresAt });
    await this.deliver?.(targetDeviceId, cid, env);
  }
  async publishLinks(rows: PublishedLink[]) {
    if (this.failPublishes > 0) {
      this.failPublishes--;
      throw new Error("publish links: unavailable");
    }
    for (const r of rows) {
      const cut = this.#revokedAllAt !== null && r.createdAt <= this.#revokedAllAt;
      this.rows.set(r.summary.id, (this.rows.get(r.summary.id) ?? false) || r.summary.revokedAt !== null || cut);
    }
    this.published = rows;
  }
  /** Test hook: chalito_private.revoke_agent_links (every row, and the account's cut-off). */
  revokeAll(at = Date.now()) {
    for (const id of this.rows.keys()) this.rows.set(id, true);
    this.#revokedAllAt = at;
  }
  async linkStatus(ids: string[]) {
    if (this.statusFails) throw new Error("link status: unavailable");
    const out = new Map<string, CloudLinkStatus>();
    for (const id of ids) {
      const row = this.rows.get(id);
      if (this.revoked.has(id) || row === true) out.set(id, "revoked");
      else if (row === false) out.set(id, "active");
    }
    return out;
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Over the hub's Supabase, signed in as this device (migrations 20261015000200 / 000300). */
export class SupabaseLinkCloud implements LinkCloud {
  constructor(
    private readonly db: SupaClient,
    private readonly owner: string,
    private readonly deviceId: string,
  ) {}

  async queueCommand(targetDeviceId: string, cid: string, env: RelayedCommand, expiresAt: number) {
    const { error } = await this.db.from("commands").insert({
      owner: this.owner,
      target_device_id: targetDeviceId,
      id: cid,
      env,
      from_device_id: this.deviceId,
      expires_at: iso(expiresAt),
    });
    if (error) throw new Error(`link relay: ${error.message}`);
  }

  async publishLinks(rows: PublishedLink[]) {
    const links = rows.map(({ summary: s, createdAt, detailsCt }) => ({
      link_id: s.id,
      mode: s.mode,
      sender_device_id: s.senderDeviceId,
      receiver_device_id: s.receiverDeviceId,
      confirm: s.confirm,
      permission_ceiling: s.permissionCeiling,
      expires_at: iso(s.expiresAt),
      created_at: iso(createdAt),
      revoked_at: s.revokedAt === null ? null : iso(s.revokedAt),
      details_ct: detailsCt,
    }));
    const { error } = await this.db.rpc("publish_agent_links", { p_links: links });
    if (error) throw new Error(`publish links: ${error.message}`);
  }

  async linkStatus(ids: string[]) {
    const out = new Map<string, CloudLinkStatus>();
    if (ids.length === 0) return out;
    const { data, error } = await this.db
      .from("agent_links")
      .select("link_id, revoked_at")
      .eq("owner", this.owner)
      .eq("device_id", this.deviceId)
      .in("link_id", ids);
    if (error) throw new Error(`link status: ${error.message}`);
    for (const r of (data as { link_id: string; revoked_at: string | null }[] | null) ?? [])
      out.set(r.link_id, r.revoked_at === null ? "active" : "revoked");
    return out;
  }
}
