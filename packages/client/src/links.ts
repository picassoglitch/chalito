import { AgentEvent, type LinkHandoffStage, type LinkRefusal, type SealedEnvelope } from "@chalito/protocol";
import type { ClientKeys } from "./keys.js";
import type { EventView } from "./live.js";
import { must, type SupaClient } from "./supa.js";

/**
 * Agent-to-agent links on the phone (ADR 0022 §3): what each device's links are (the
 * chalito.agent_links mirror) and how a hand-off or share reads in a session's timeline. Display
 * only: links are made and checked on the devices; from here a person can revoke them (and make
 * share links, with a passkey), never make a hand-off link.
 */

export interface LinkView {
  /** The device that holds this row (one end of the link). */
  deviceId: string;
  linkId: string;
  mode: "share" | "handoff";
  senderDeviceId: string;
  receiverDeviceId: string;
  confirm: boolean;
  permissionCeiling: string;
  expiresAt: number;
  revokedAt: number | null;
  /** Opened details (goal, workspace, budget, rate, tokens today), or null if this device can't read them. */
  details: Record<string, unknown> | null;
}

const ms = (v: unknown): number | null => (typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : null);

/** The owner's links as their devices published them (RLS: the owner's devices only). */
export const listLinks = async (db: SupaClient, owner: string, keys: ClientKeys): Promise<LinkView[]> => {
  const rows = await must<Record<string, unknown>[]>(
    "list links",
    db.from("agent_links").select("*").eq("owner", owner).order("updated_at", { ascending: false }),
  );
  const out: LinkView[] = [];
  for (const r of rows ?? []) {
    const linkId = String(r.link_id);
    const details = await keys
      .open<Record<string, unknown>>(r.details_ct as SealedEnvelope, `link:${linkId}`)
      .catch(() => null);
    out.push({
      deviceId: String(r.device_id),
      linkId,
      mode: r.mode === "handoff" ? "handoff" : "share",
      senderDeviceId: String(r.sender_device_id),
      receiverDeviceId: String(r.receiver_device_id),
      confirm: r.confirm === true,
      permissionCeiling: String(r.permission_ceiling),
      expiresAt: ms(r.expires_at) ?? 0,
      revokedAt: ms(r.revoked_at),
      details,
    });
  }
  return out;
};

/** A timeline line for a link event, or null for any other event. */
export type LinkEventLine =
  | {
      kind: "handoff";
      linkId: string;
      direction: "in" | "out";
      stage: LinkHandoffStage;
      hop: number;
      peerDeviceId: string;
      reason: LinkRefusal | null;
    }
  | {
      kind: "shared";
      linkId: string;
      direction: "in" | "out";
      /** A hand-off's result (`handoff`) or a share. Its content is quoted data, never instructions. */
      mode: "share" | "handoff";
      peerDeviceId: string;
      state: string | null;
      content: unknown;
    };

export const linkEventLine = (e: EventView): LinkEventLine | null => {
  if (e.type !== "link.handoff" && e.type !== "link.shared") return null;
  const parsed = AgentEvent.safeParse({ ...e.meta, type: e.type, v: 1, eid: e.eid, sid: e.sid, seq: e.seq, t: e.t });
  if (!parsed.success) return null;
  const ev = parsed.data;
  if (ev.type === "link.handoff")
    return {
      kind: "handoff",
      linkId: ev.linkId,
      direction: ev.direction,
      stage: ev.stage,
      hop: ev.hop,
      peerDeviceId: ev.peerDeviceId,
      reason: ev.reason ?? null,
    };
  if (ev.type === "link.shared")
    return {
      kind: "shared",
      linkId: ev.linkId,
      direction: ev.direction,
      mode: ev.mode,
      peerDeviceId: ev.peerDeviceId,
      state: ev.state ?? null,
      content: e.content,
    };
  return null;
};
