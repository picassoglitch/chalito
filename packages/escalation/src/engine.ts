import type { Channel, Urgency } from "@chalito/protocol";
import { DEFAULT_ESCALATION, type EscalationConfig } from "./config.js";
import { LEVEL_RANK, ladderFor, maxLevel, minLevel, type Rung } from "./ladder.js";
import { buildPushPayload, buildTemplateVars } from "./payloads.js";
import { inQuietHours, localDate, quietHoursEnd } from "./time.js";
import type {
  Action,
  EscalationEvent,
  EscalationItem,
  History,
  Ladder,
  Presence,
  SuppressReason,
  UserPrefs,
} from "./types.js";

const URGENCY_RANK: Record<Urgency, number> = { low: 0, normal: 1, high: 2, critical: 3 };
const PHONE: ReadonlySet<Channel> = new Set(["push", "whatsapp", "call", "sms"]);

const active = (l: Ladder) => l.state === "pending" || l.state === "snoozed";

/**
 * The escalation engine: a pure function of (event, user prefs, presence, history, now).
 * It returns what to send, what to (re)schedule or cancel, and the ladder state to persist
 * (`ladder` actions). The notifier executes the actions and feeds scheduled ticks back in.
 *
 * Rules (brief §5 M6, ADR 0011):
 * - Levels L0–L4: an item escalates through its ladder up to its own level.
 * - Quiet hours (user tz, default 23:00–07:00) hold phone channels until they end, except for
 *   an L4 item of an allowlisted source. The desktop is always told (it damps itself).
 * - Daily caps per local day (calls 3, WhatsApp 10, SMS 3 by default).
 * - Presence-first: while the desktop is active, phone channels wait 2 min from the ladder start.
 * - Coalescing: a notify with the coalesceKey of an active ladder updates it, never restarts it.
 * - Ack anywhere cancels every pending step of the acked ladder(s).
 * - Approvals: the ladder is clipped to the approval's expiry, then an L1 "Expiró: denegada".
 * - SMS is the last rung, off by default for MX numbers.
 */
export const decide = (
  event: EscalationEvent,
  prefs: UserPrefs,
  presence: Presence,
  history: History,
  now: number,
  config: EscalationConfig = DEFAULT_ESCALATION,
): Action[] => {
  const ctx = new Ctx(prefs, presence, history, now, config);
  switch (event.type) {
    case "notify":
      ctx.notify(event.item);
      break;
    case "tick": {
      const l = ctx.byNid(event.nid);
      if (l && active(l)) ctx.run(l);
      break;
    }
    case "ack":
      for (const l of history.ladders) {
        const hit =
          event.all ||
          (event.nid !== undefined && l.item.nid === event.nid) ||
          (event.coalesceKey !== undefined && l.item.coalesceKey === event.coalesceKey);
        if (hit && active(l)) ctx.ack(l, event.via);
      }
      break;
    case "snooze": {
      const l = ctx.byNid(event.nid);
      if (l && active(l)) ctx.snooze(l);
      break;
    }
    case "approval_expired": {
      const l = ctx.byNid(event.nid);
      if (l && active(l)) ctx.expire(l);
      break;
    }
  }
  return ctx.actions;
};

class Ctx {
  readonly actions: Action[] = [];
  /** Today's outbound sends per channel, including the ones decided in this call. */
  readonly #today = new Map<Channel, number>();
  readonly #quiet: { start: string; end: string } | null;

  constructor(
    readonly prefs: UserPrefs,
    readonly presence: Presence,
    readonly history: History,
    readonly now: number,
    readonly config: EscalationConfig,
  ) {
    const day = localDate(now, prefs.tz);
    for (const s of history.sent)
      if (localDate(s.at, prefs.tz) === day) this.#today.set(s.channel, (this.#today.get(s.channel) ?? 0) + 1);
    this.#quiet = prefs.quietHours === undefined ? config.quietHoursDefault : prefs.quietHours;
  }

  byNid(nid: string) {
    return this.history.ladders.find((l) => l.item.nid === nid);
  }

  notify(item: EscalationItem) {
    const existing = this.history.ladders.find((l) => l.item.coalesceKey === item.coalesceKey && active(l));
    if (!existing) {
      this.run({
        item,
        state: "pending",
        step: 0,
        openedAt: this.now,
        startedAt: this.now,
        nextAt: null,
        ackedAt: null,
        ackedVia: null,
      });
      return;
    }
    // Coalesce: same ladder and timers; fresher counts and link; never less urgent; the latest expiry.
    const merged: Ladder = {
      ...existing,
      item: {
        ...existing.item,
        counts: item.counts,
        deepLink: item.deepLink,
        level: maxLevel(existing.item.level, item.level),
        urgency:
          URGENCY_RANK[item.urgency] > URGENCY_RANK[existing.item.urgency] ? item.urgency : existing.item.urgency,
        ...(item.approvalExpiresAt !== undefined || existing.item.approvalExpiresAt !== undefined
          ? { approvalExpiresAt: Math.max(item.approvalExpiresAt ?? 0, existing.item.approvalExpiresAt ?? 0) }
          : {}),
      },
    };
    const level = this.#currentLevel(merged);
    this.actions.push({
      type: "send",
      channel: "desktop",
      nid: merged.item.nid,
      level,
      payload: buildPushPayload(merged.item, level),
    });
    this.#schedule(merged);
    this.actions.push({ type: "ladder", ladder: merged });
  }

  /** Runs every rung that is due, then schedules the next one. */
  run(input: Ladder) {
    const l: Ladder = { ...input };
    const exp = l.item.approvalExpiresAt;
    if (exp !== undefined && this.now >= exp) return this.expire(l);
    const rungs = ladderFor(l.item);
    // A snooze recall: re-anchor the rung clock so the call is due now and later rungs keep their spacing.
    if (l.state === "snoozed") l.startedAt = this.now - (rungs[this.#callIndex(rungs)]?.afterMs ?? 0);
    l.state = "pending";
    if (l.step === 0 && l.item.level === "L0") {
      // Ambient: the desktop only, no ladder.
      this.actions.push({
        type: "send",
        channel: "desktop",
        nid: l.item.nid,
        level: "L0",
        payload: buildPushPayload(l.item, "L0"),
      });
    }
    while (l.step < rungs.length) {
      const rung = rungs[l.step]!;
      const due = l.startedAt + rung.afterMs;
      if (due > this.now) break;
      if (LEVEL_RANK[rung.level] > LEVEL_RANK[l.item.level]) {
        l.step++;
        continue;
      }
      const holdUntil = this.#deliver(l, rung);
      if (holdUntil !== null) {
        // Hold the whole ladder: rungs keep their spacing after the hold.
        l.startedAt += holdUntil - due;
        break;
      }
      l.step++;
    }
    if (l.step >= rungs.length && exp === undefined) {
      l.state = "done";
      l.nextAt = null;
    } else {
      this.#schedule(l);
    }
    this.actions.push({ type: "ladder", ladder: l });
  }

  ack(input: Ladder, via: Channel | "app") {
    const l: Ladder = { ...input, state: "acked", nextAt: null, ackedAt: this.now, ackedVia: via };
    this.actions.push({ type: "cancel", nid: l.item.nid }, { type: "ladder", ladder: l });
  }

  /** DTMF 2: call again a minute before a Mesa starts, else after the snooze interval. */
  snooze(input: Ladder) {
    const rungs = ladderFor(input.item);
    const at =
      input.item.mesaStartsAt !== undefined
        ? Math.max(this.now, input.item.mesaStartsAt - this.config.mesaRecallLeadMs)
        : this.now + this.config.snoozeMs;
    const exp = input.item.approvalExpiresAt;
    const l: Ladder = {
      ...input,
      state: "snoozed",
      step: this.#callIndex(rungs),
      nextAt: exp !== undefined ? Math.min(at, exp) : at,
    };
    this.actions.push(
      { type: "cancel", nid: l.item.nid },
      { type: "schedule", nid: l.item.nid, at: l.nextAt! },
      { type: "ladder", ladder: l },
    );
  }

  /** The approval expired: tell the user (desktop, plus push outside quiet hours) and stop. */
  expire(input: Ladder) {
    const l: Ladder = { ...input, state: "expired", nextAt: null };
    const payload = buildPushPayload(l.item, "L1", "approval_expired");
    this.actions.push({ type: "cancel", nid: l.item.nid });
    this.actions.push({ type: "send", channel: "desktop", nid: l.item.nid, level: "L1", payload });
    if (this.#quietFor(l))
      this.actions.push({ type: "suppressed", nid: l.item.nid, channel: "push", reason: "quiet_hours" });
    else this.actions.push({ type: "send", channel: "push", nid: l.item.nid, level: "L1", payload });
    this.actions.push({ type: "ladder", ladder: l });
  }

  /** Sends one rung, or returns the time to hold the ladder until (quiet hours, presence). */
  #deliver(l: Ladder, rung: Rung): number | null {
    const { item } = l;
    const level = minLevel(rung.level, item.level);
    this.actions.push({
      type: "send",
      channel: "desktop",
      nid: item.nid,
      level,
      payload: buildPushPayload(item, level),
    });

    if (PHONE.has(rung.channel) && this.presence.desktopActive && this.now < l.openedAt + this.config.presenceHoldMs) {
      this.actions.push({ type: "suppressed", nid: item.nid, channel: rung.channel, reason: "presence_hold" });
      return l.openedAt + this.config.presenceHoldMs;
    }
    if (this.#quietFor(l)) {
      const end = quietHoursEnd(this.now, this.prefs.tz, this.#quiet!);
      this.actions.push({ type: "suppressed", nid: item.nid, channel: rung.channel, reason: "quiet_hours" });
      // An approval can't wait for the morning: skip the rung (the expiry notice still comes).
      return item.approvalExpiresAt !== undefined && end >= item.approvalExpiresAt ? null : end;
    }
    const blocked = this.#unavailable(rung.channel);
    if (blocked) {
      this.actions.push({ type: "suppressed", nid: item.nid, channel: rung.channel, reason: blocked });
      return null;
    }
    const cap = this.#cap(rung.channel);
    if (cap !== null && (this.#today.get(rung.channel) ?? 0) >= cap) {
      this.actions.push({ type: "suppressed", nid: item.nid, channel: rung.channel, reason: "cap" });
      return null;
    }
    this.#today.set(rung.channel, (this.#today.get(rung.channel) ?? 0) + 1);
    switch (rung.channel) {
      case "push":
        this.actions.push({
          type: "send",
          channel: "push",
          nid: item.nid,
          level,
          payload: buildPushPayload(item, level),
        });
        break;
      case "whatsapp":
      case "sms":
        this.actions.push({
          type: "send",
          channel: rung.channel,
          nid: item.nid,
          level,
          payload: buildTemplateVars(item, this.prefs.locale),
        });
        break;
      case "call":
        this.actions.push({ type: "send", channel: "call", nid: item.nid, level, payload: { nid: item.nid } });
        break;
    }
    return null;
  }

  /** Quiet hours hold this item's phone channels, unless it is an L4 item of an allowlisted source. */
  #quietFor(l: Ladder) {
    if (!this.#quiet || !inQuietHours(this.now, this.prefs.tz, this.#quiet)) return false;
    return !(l.item.level === "L4" && (this.prefs.l4QuietOverride ?? []).includes(l.item.source));
  }

  #unavailable(channel: Rung["channel"]): SuppressReason | null {
    if (channel === "push") return null;
    const phone = this.prefs.phone;
    const enabled =
      channel === "whatsapp"
        ? this.prefs.whatsapp?.optIn === true
        : channel === "call"
          ? this.prefs.calls?.enabled === true
          : (this.prefs.sms?.enabled ?? (phone ? phone.country.toUpperCase() !== "MX" : false));
    if (!enabled) return "disabled";
    if (!phone?.verified) return "no_verified_phone";
    if ((channel === "call" || channel === "sms") && phone.chargesNoticeAckAt === null) return "no_charges_ack";
    return null;
  }

  #cap(channel: Rung["channel"]) {
    return channel === "push" ? null : this.config.caps[channel];
  }

  #callIndex(rungs: readonly Rung[]) {
    const i = rungs.findIndex((r) => r.channel === "call");
    return i < 0 ? rungs.length : i;
  }

  /** The level reached so far (for desktop refreshes when an item coalesces). */
  #currentLevel(l: Ladder) {
    const rungs = ladderFor(l.item);
    let level: Ladder["item"]["level"] = "L0";
    for (let i = 0; i < Math.min(l.step, rungs.length); i++)
      if (LEVEL_RANK[rungs[i]!.level] <= LEVEL_RANK[l.item.level]) level = maxLevel(level, rungs[i]!.level);
    return level;
  }

  #schedule(l: Ladder) {
    const rungs = ladderFor(l.item);
    const next = l.step < rungs.length ? l.startedAt + rungs[l.step]!.afterMs : Infinity;
    const exp = l.item.approvalExpiresAt ?? Infinity;
    const at = Math.min(next, exp);
    l.nextAt = Number.isFinite(at) ? Math.max(at, this.now) : null;
    if (l.nextAt !== null) this.actions.push({ type: "schedule", nid: l.item.nid, at: l.nextAt });
  }
}
