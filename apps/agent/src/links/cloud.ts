import type { AgentLinkSummary, RelayedCommand, SealedEnvelope } from "@chalito/protocol";
import type { SupaClient } from "../supabase-store.js";

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
  publishLinks(rows: { summary: AgentLinkSummary; detailsCt: SealedEnvelope }[]): Promise<void>;
  /** Of these link ids, the ones the account revoked (revoke-all marks the mirror rows). */
  revokedInCloud(ids: string[]): Promise<string[]>;
}

/** For tests and setups without a cloud: relays go nowhere, nothing is revoked remotely. */
export class MemoryLinkCloud implements LinkCloud {
  queued: { targetDeviceId: string; cid: string; env: RelayedCommand; expiresAt: number }[] = [];
  published: { summary: AgentLinkSummary; detailsCt: SealedEnvelope }[] = [];
  revoked = new Set<string>();
  /** Test hook: where queued relays go (another agent's handleCommand). */
  deliver?: (targetDeviceId: string, cid: string, env: RelayedCommand) => Promise<void>;
  async queueCommand(targetDeviceId: string, cid: string, env: RelayedCommand, expiresAt: number) {
    this.queued.push({ targetDeviceId, cid, env, expiresAt });
    await this.deliver?.(targetDeviceId, cid, env);
  }
  async publishLinks(rows: { summary: AgentLinkSummary; detailsCt: SealedEnvelope }[]) {
    this.published = rows;
  }
  async revokedInCloud(ids: string[]) {
    return ids.filter((id) => this.revoked.has(id));
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

  async publishLinks(rows: { summary: AgentLinkSummary; detailsCt: SealedEnvelope }[]) {
    const links = rows.map(({ summary: s, detailsCt }) => ({
      link_id: s.id,
      mode: s.mode,
      sender_device_id: s.senderDeviceId,
      receiver_device_id: s.receiverDeviceId,
      confirm: s.confirm,
      permission_ceiling: s.permissionCeiling,
      expires_at: iso(s.expiresAt),
      revoked_at: s.revokedAt === null ? null : iso(s.revokedAt),
      details_ct: detailsCt,
    }));
    const { error } = await this.db.rpc("publish_agent_links", { p_links: links });
    if (error) throw new Error(`publish links: ${error.message}`);
  }

  async revokedInCloud(ids: string[]) {
    if (ids.length === 0) return [];
    const { data, error } = await this.db
      .from("agent_links")
      .select("link_id, revoked_at")
      .eq("owner", this.owner)
      .eq("device_id", this.deviceId)
      .in("link_id", ids);
    if (error) throw new Error(`link status: ${error.message}`);
    return ((data as { link_id: string; revoked_at: string | null }[] | null) ?? [])
      .filter((r) => r.revoked_at !== null)
      .map((r) => r.link_id);
  }
}
