import { loadPlans, loadRooms } from "@chalito/config";
import { resolveInclusions } from "@chalito/protocol";

/**
 * Room limits from the plan's inclusions (brief §5 M11, plans.yaml). A user's `tier` is either a
 * hub tier (free/pro/vip, mapped to a ladder tier by `hubTiers`, with its `limits` caps) or a Solo
 * tier; bundles take their mirrored tier's inclusions. Anything unknown or unset fails closed (0).
 */
export interface RoomLimits {
  rooms: number;
  membersPerRoom: number;
}

const plans = loadPlans();
export const roomsConfig = loadRooms();

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export const roomLimitsFor = (tier: string | null | undefined): RoomLimits => {
  const inc = resolveInclusions(plans, tier);
  return { rooms: num(inc?.rooms), membersPerRoom: num(inc?.membersPerRoom) };
};

/**
 * How many computers (agent devices) the plan allows. Phones and browsers are clients and don't
 * count: they're how a person reaches their computers, and Gratis needs one of each to work.
 */
export const deviceLimitFor = (tier: string | null | undefined): number => num(resolveInclusions(plans, tier)?.devices);

/** rooms.yaml `invites.ttl` (ISO 8601 PnD / PTnH) in ms. */
export const inviteTtlMs = (): number => {
  const m = /^P(?:(\d+)D|T(\d+)H)$/.exec(roomsConfig.invites.ttl);
  if (!m) return 24 * 60 * 60 * 1000;
  return m[1] ? Number(m[1]) * 86_400_000 : Number(m[2]) * 3_600_000;
};
