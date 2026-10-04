import { loadPlans, loadRooms } from "@chalito/config";
import { HubTierId, TierId, type Inclusions } from "@chalito/protocol";

/**
 * Room limits from the plan's inclusions (brief §5 M11, plans.yaml). A user's `tier` is either a
 * hub tier (free/pro/vip, mapped to a ladder tier by `hubTiers`) or a Solo tier; bundles take
 * their mirrored tier's inclusions. Anything unknown or unset fails closed (0).
 */
export interface RoomLimits {
  rooms: number;
  membersPerRoom: number;
}

const plans = loadPlans();
export const roomsConfig = loadRooms();

const inclusionsFor = (tier: string | null | undefined): Inclusions | null => {
  if (!tier) return null;
  let id: string | null = tier;
  const hub = HubTierId.safeParse(tier);
  if (hub.success) {
    const access = plans.hubTiers[hub.data]?.access;
    id = !access || access === "none" ? null : access;
  }
  const parsed = TierId.safeParse(id);
  if (!parsed.success) return null;
  const def = plans.tiers[parsed.data];
  if (!def) return null;
  if (def.inclusions !== "mirror_matching_tier") return def.inclusions;
  const mirrored = def.mirrors ? plans.tiers[def.mirrors] : undefined;
  return mirrored && mirrored.inclusions !== "mirror_matching_tier" ? mirrored.inclusions : null;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const roomLimitsFor = (tier: string | null | undefined): RoomLimits => {
  const inc = inclusionsFor(tier);
  return { rooms: num(inc?.rooms), membersPerRoom: num(inc?.membersPerRoom) };
};

/** rooms.yaml `invites.ttl` (ISO 8601 PnD / PTnH) in ms. */
export const inviteTtlMs = (): number => {
  const m = /^P(?:(\d+)D|T(\d+)H)$/.exec(roomsConfig.invites.ttl);
  if (!m) return 24 * 60 * 60 * 1000;
  return m[1] ? Number(m[1]) * 86_400_000 : Number(m[2]) * 3_600_000;
};
