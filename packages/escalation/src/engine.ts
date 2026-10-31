import type { Channel, Urgency } from "@chalito/protocol";
import { DEFAULT_ESCALATION, type EscalationConfig } from "./config.js";
import { LEVEL_RANK, ladderFor, maxLevel, minLevel, sidOf, type Rung } from "./ladder.js";
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
/** Every rung ran and no approval expiry is left: news on its key starts a fresh ladder, never a silent merge. */
const spent = (l: Ladder) => l.step >= ladderFor(l.item).length && l.item.approvalExpiresAt === undefined;

/** Pure (event, prefs, presence, history, now) → sends, schedules, cancels and ladders to persist. Rules: brief §5 M6 and
 * ADR 0011 (levels, quiet hours, daily caps, presence-first, coalescing, ack anywhere, approval expiry, SMS last). */
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
      // A stale tick (a rest that ended or moved) must not release a ladder early.
      if (l && active(l) && !(l.hold && l.nextAt !== null && now < l.nextAt)) {
        if (l.hold) ctx.release(l, l.hold);
        else ctx.run(l);
      }
      break;
    }
    case "ack":
      for (const l of history.ladders) {
        const hit =
          event.all ||
          (event.nid !== undefined && l.item.nid === event.nid) ||
          (event.coalesceKey !== undefined && l.item.coalesceKey === event.coalesceKey) ||
          (event.sid !== undefined &&
            sidOf(l.item) === event.sid &&
            (!event.sources || event.sources.includes(l.item.source)));
        if (hit && active(l)) ctx.ack(l, event.via);
        // Resolved while parked: undoing the park must not bring it back.
        else if (hit && l.waitingSince !== undefined) ctx.unparkable(l, l.state);
      }
      break;
    // A finished ladder still shows as pending in the app, so opening or parking its session covers it too.
    // Approvals are left out of "seen": they expire in minutes and still need an answer (owner, 2026-10-25).
    case "seen":
      for (const l of history.ladders)
        if (sidOf(l.item) === event.sid && l.item.source !== "approval" && (active(l) || l.state === "done"))
          ctx.seen(l);
      break;
    case "waiting":
      for (const l of history.ladders) {
        if (sidOf(l.item) !== event.sid) continue;
        if (event.on && (active(l) || l.state === "done")) ctx.park(l);
        else if (!event.on && l.state === "acked" && l.waitingSince !== undefined) ctx.unpark(l, l.waitingSince);
      }
      break;
    case "snooze_alert": {
      const l = ctx.byNid(event.nid);
      if (l && (active(l) || l.state === "done")) ctx.snoozeAlert(l);
      break;
    }
    case "snooze": {
      const l = ctx.byNid(event.nid);
      if (l && active(l)) ctx.snooze(l);
      break;
    }
    case "approval_expired": {
      const l = ctx.byNid(event.nid);
      if (l && active(l)) ctx.expire(l);
      else if (l && l.waitingSince !== undefined) ctx.unparkable(l, "expired");
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
    const existing = this.history.ladders.find(
      (l) => l.item.coalesceKey === item.coalesceKey && active(l) && (!spent(l) || l.hold?.kind === "snooze"),
    );
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
    let merged: Ladder = {
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
    // A postponed alert keeps its quiet; news on a session the person only looked at alerts again.
    if (merged.hold?.kind === "snooze") return void this.actions.push({ type: "ladder", ladder: merged });
    if (merged.hold) {
      merged = this.#unheld(merged, merged.hold.since);
      this.actions.push({ type: "cancel", nid: merged.item.nid });
    }
    // After its re-nudge the ladder sat idle: news restarts its clock here instead of finding every rung overdue.
    if (merged.renudged) {
      const prev = ladderFor(merged.item)[Math.max(0, merged.step - 1)]?.afterMs ?? 0;
      merged = { ...merged, renudged: false, startedAt: this.now - prev };
    }
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

  // ---- calmer alerts (from Alux, by Omar) ----

  /** Opened in the app: an ack, plus one gentle re-nudge later; after that re-nudge the next look acks for good. */
  seen(l: Ladder) {
    if (l.renudged) return this.ack(l, "app");
    this.#rest(l, { kind: "seen", since: this.now }, this.config.renudgeMs);
  }

  snoozeAlert(l: Ladder) {
    // Postponing again keeps the original start, so the rung clock shifts by the whole quiet time.
    const since = l.hold?.kind === "snooze" ? l.hold.since : this.now;
    this.#rest(l, { kind: "snooze", since }, this.config.alertSnoozeMs);
  }

  /** "Esperando a alguien": acked until the session changes (a new notify opens a fresh ladder) or it's undone. */
  park(input: Ladder) {
    const { hold: _hold, ...rest } = input;
    const l: Ladder = {
      ...rest,
      state: "acked",
      nextAt: null,
      ackedAt: this.now,
      ackedVia: "app",
      waitingSince: this.now,
    };
    this.actions.push({ type: "cancel", nid: l.item.nid }, { type: "ladder", ladder: l });
  }

  /** Settled while parked (answered or expired): it stays settled, whatever the undo says later. */
  unparkable(input: Ladder, state: Ladder["state"]) {
    const { waitingSince: _w, ...rest } = input;
    this.actions.push({ type: "ladder", ladder: { ...rest, state } });
  }

  unpark(input: Ladder, since: number) {
    const { waitingSince: _w, ...rest } = input;
    this.run(this.#unheld({ ...rest, ackedAt: null, ackedVia: null }, since));
  }

  /** A resting ladder's time came: a postponed one resumes; a seen one gets its single re-nudge. */
  release(input: Ladder, hold: NonNullable<Ladder["hold"]>) {
    const exp = input.item.approvalExpiresAt;
    if (hold.kind === "snooze" || (exp !== undefined && this.now >= exp))
      return this.run(this.#unheld(input, hold.since));
    // Queued behind fresh alerts: a re-nudge never talks over something new.
    const fresh = this.history.ladders.some(
      (o) => o.item.nid !== input.item.nid && o.state === "pending" && !o.renudged && o.nextAt !== null,
    );
    if (fresh) return this.#rest(input, hold, this.config.renudgeRetryMs, false);
    // One re-nudge per session, from its most urgent alert: a sibling that asked again or outranks this one settles it.
    const sid = sidOf(input.item);
    const rank = (l: Ladder) => LEVEL_RANK[l.item.level];
    const sibling = (o: Ladder) => o.item.nid !== input.item.nid && sid !== undefined && sidOf(o.item) === sid;
    const asked = this.history.ladders.some((o) => sibling(o) && o.renudged && o.state !== "acked");
    const outranked = this.history.ladders.some(
      (o) =>
        sibling(o) &&
        o.hold?.kind === "seen" &&
        active(o) &&
        (rank(o) > rank(input) || (rank(o) === rank(input) && o.item.nid < input.item.nid)),
    );
    if (asked || outranked) {
      const { hold: _h, ...rest } = input;
      return this.ack(rest, "app");
    }
    // The rung clock moves past the rest too, so news coalescing in later doesn't find every rung overdue.
    const unheld = this.#unheld(input, hold.since);
    const l: Ladder = { ...unheld, state: spent(unheld) ? "done" : "pending", renudged: true, nextAt: exp ?? null };
    const level = minLevel(l.item.level, "L1");
    this.actions.push({
      type: "send",
      channel: "desktop",
      nid: l.item.nid,
      level,
      payload: buildPushPayload(l.item, level),
    });
    if (exp !== undefined) this.actions.push({ type: "schedule", nid: l.item.nid, at: exp });
    this.actions.push({ type: "ladder", ladder: l });
  }

  /** Rests a ladder for `ms` (never past its approval's expiry, which still fires). */
  #rest(input: Ladder, hold: NonNullable<Ladder["hold"]>, ms: number, cancel = true) {
    const exp = input.item.approvalExpiresAt;
    const at = exp !== undefined ? Math.min(this.now + ms, exp) : this.now + ms;
    const l: Ladder = { ...input, state: "snoozed", hold, nextAt: at };
    if (cancel) this.actions.push({ type: "cancel", nid: l.item.nid });
    this.actions.push({ type: "schedule", nid: l.item.nid, at }, { type: "ladder", ladder: l });
  }

  /** Back to pending, the rung clock shifted by the rest so later rungs keep their spacing. */
  #unheld(input: Ladder, since: number): Ladder {
    const { hold: _hold, ...rest } = input;
    return { ...rest, state: "pending", startedAt: input.startedAt + Math.max(0, this.now - since) };
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

    // Still at the desktop once the hold ends: they saw the turn finish, so "finished" is dropped.
    if (
      item.source === "turn_finished" &&
      this.presence.desktopActive &&
      this.now >= l.openedAt + this.config.presenceHoldMs
    ) {
      this.actions.push({ type: "suppressed", nid: item.nid, channel: rung.channel, reason: "presence_hold" });
      return null;
    }
    if (PHONE.has(rung.channel) && this.presence.desktopActive && this.now < l.openedAt + this.config.presenceHoldMs) {
      this.actions.push({ type: "suppressed", nid: item.nid, channel: rung.channel, reason: "presence_hold" });
      return l.openedAt + this.config.presenceHoldMs;
    }
    if (this.#quietFor(l)) {
      const end = quietHoursEnd(this.now, this.prefs.tz, this.#quiet!);
      this.actions.push({ type: "suppressed", nid: item.nid, channel: rung.channel, reason: "quiet_hours" });
      // An approval can't wait for the morning: skip the rung (the expiry notice still comes).
      // Neither does "your turn finished": at 07:00 it is stale news, so it is dropped, not held.
      if (item.source === "turn_finished") return null;
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
          : (this.prefs.sms?.enabled ??
            (phone ? !this.config.sms.defaultOffCountries.includes(phone.country.toUpperCase()) : false));
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
