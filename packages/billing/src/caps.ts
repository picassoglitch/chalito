import { HubTierId, type Entitlements, type PlansConfig } from "@chalito/protocol";
import { computeEntitlements } from "./entitlements.js";

/**
 * Monthly plan caps (plans.yaml inclusions: whatsapp, calls, sms, voiceMinutes), counted per
 * calendar month in the user's time zone. "Margin first": an unset limit allows nothing.
 */
export type CappedChannel = "whatsapp" | "sms" | "call" | "voice";

const LIMIT_KEY: Record<CappedChannel, keyof Entitlements["limits"]> = {
  whatsapp: "whatsapp",
  sms: "sms",
  call: "calls",
  voice: "voiceMinutes",
};

const wallClock = (t: number, tz: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(t))
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
};

/** The instant the user's current calendar month began (local midnight on the 1st). */
export const localMonthStart = (now: number, tz: string): number => {
  const local = new Date(wallClock(now, tz));
  const firstLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
  // Two passes settle the offset across DST changes.
  let t = firstLocal - (wallClock(firstLocal, tz) - firstLocal);
  t = firstLocal - (wallClock(t, tz) - t);
  return t;
};

/** "YYYY_MM" of the user's current month, for once-a-month notes. */
export const localMonthKey = (now: number, tz: string) => {
  const d = new Date(wallClock(now, tz));
  return `${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** The hub tier as the SSO token reported it (users.tier), or null if it isn't one we know. */
export const hubTierOf = (tier: string | null | undefined) => {
  const r = HubTierId.safeParse((tier ?? "").toLowerCase());
  return r.success ? r.data : null;
};

/** Monthly limit for a channel (in sends, or minutes for voice); unset → 0. */
export const monthlyLimit = (
  plans: PlansConfig,
  p: { uid: string; hubTier: string | null; comped: boolean; now: number },
  channel: CappedChannel,
): number => {
  const e = computeEntitlements(
    {
      uid: p.uid,
      hubTier: hubTierOf(p.hubTier),
      soloTier: null,
      hubTrialActive: false,
      hubBalanceRemaining: 0,
      comped: p.comped,
      now: p.now,
    },
    plans,
  );
  const v = e.limits[LIMIT_KEY[channel]];
  return typeof v === "number" ? v : 0;
};
