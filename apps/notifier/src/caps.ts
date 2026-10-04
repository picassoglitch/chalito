import { localMonthKey, localMonthStart, monthlyLimit, type CappedChannel } from "@chalito/billing";
import type { PlansConfig } from "@chalito/protocol";
import type { NotifierDeps } from "./executor.js";

/** Monthly plan caps for paid channels (plans.yaml inclusions), checked before the hub admit. */
export interface CapsConfig {
  plans: PlansConfig;
  isComped: (uid: string) => boolean;
}

/**
 * True when this send would go over the user's monthly allowance for the channel. The send
 * being decided is already recorded (queued) when this runs, so it counts itself.
 */
export const overMonthlyCap = async (deps: NotifierDeps, uid: string, channel: "whatsapp" | "sms" | "call") => {
  if (!deps.caps) return false;
  const info = await deps.store.planInfo(uid);
  if (!info) return true;
  const now = deps.now();
  const limit = monthlyLimit(
    deps.caps.plans,
    { uid, hubTier: info.hubTier, comped: deps.caps.isComped(uid), now },
    channel,
  );
  const used = (await deps.store.monthlySends(uid, localMonthStart(now, info.tz)))[channel];
  return used > limit;
};

/** Whether the user still has voice minutes this month (desktop and calls share them). */
export const voiceMinutesLeft = async (deps: NotifierDeps, uid: string) => {
  if (!deps.caps) return true;
  const info = await deps.store.planInfo(uid);
  if (!info) return false;
  const now = deps.now();
  const limitSec =
    monthlyLimit(deps.caps.plans, { uid, hubTier: info.hubTier, comped: deps.caps.isComped(uid), now }, "voice") * 60;
  return (await deps.store.voiceSecondsSince(uid, localMonthStart(now, info.tz))) < limitSec;
};

/** One in-app note per channel per month: "this month's <channel> allowance is used up". */
export const capNote = async (deps: NotifierDeps, uid: string, channel: CappedChannel) => {
  const info = await deps.store.planInfo(uid);
  const now = deps.now();
  await deps.store.noteOnce(uid, {
    nid: `cap_${channel}_${localMonthKey(now, info?.tz ?? "UTC")}`,
    source: "budget",
    urgency: "normal",
    counts: { approvals: 0, questions: 0, messages: 0, mesas: 0 },
    deepLink: info?.locale === "en" ? "/en/creditos" : "/creditos",
    coalesceKey: `cap:${channel}`,
    state: "pending",
    step: 0,
    nextAt: null,
    createdAt: now,
    level: "L1",
    channels: ["desktop"],
    ackedAt: null,
    ackedVia: null,
  });
};
