import type { EscalationConfig } from "@chalito/config";
import {
  buildBriefing,
  decide,
  type Action,
  type EscalationEvent,
  type Ladder,
  type UserPrefs,
} from "@chalito/escalation";
import type { CallBriefing, Channel, Level } from "@chalito/protocol";
import { smsSegments, type CommsBilling } from "./billing.js";
import type { Scheduler } from "./scheduler.js";
import type { PushSender } from "./senders/push.js";
import type { TwilioClient } from "./senders/twilio.js";
import type { WhatsAppSender } from "./senders/whatsapp.js";
import type { NotificationRow, NotifierStore } from "./store.js";
import { smsBody } from "./template.js";
import { briefingTwiml } from "./twiml.js";

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface NotifierDeps {
  store: NotifierStore;
  push: PushSender;
  whatsapp: WhatsAppSender;
  twilio: TwilioClient;
  scheduler: Scheduler;
  config: EscalationConfig;
  /** Public base URL of this service (Twilio callbacks are signed over it). */
  publicBaseUrl: string;
  /** The web app, for SMS links (`<appUrl>/n/<nid>`). */
  appUrl: string;
  now: () => number;
  log: Logger;
  /** Hub admission and metering for paid channels (WhatsApp, SMS, calls). Unset: not metered. */
  billing?: CommsBilling;
}

const HISTORY_WINDOW_MS = 48 * 3_600_000;
const STATE: Record<Ladder["state"], NotificationRow["state"]> = {
  pending: "pending",
  done: "pending",
  snoozed: "snoozed",
  acked: "acked",
  expired: "expired",
};

/**
 * Decides under the user's lock and persists the result (ladders, sends for the caps, the
 * notification row the desktop watches) before anything leaves: a crash after commit can only
 * under-deliver, never double-send. Then it sends, schedules and cancels.
 */
export const handleEvent = async (deps: NotifierDeps, uid: string, event: EscalationEvent): Promise<Action[]> => {
  const now = deps.now();
  const decided = await deps.store.withUser(uid, async (tx) => {
    const prefs = await tx.prefs();
    if (!prefs) return null;
    const history = await tx.history(now - HISTORY_WINDOW_MS);
    const actions = decide(event, prefs, await tx.presence(), history, now, deps.config);
    const keyOf = (nid: string) =>
      actions.find((x): x is Extract<typeof x, { type: "ladder" }> => x.type === "ladder" && x.ladder.item.nid === nid)
        ?.ladder.item.coalesceKey ??
      history.ladders.find((l) => l.item.nid === nid)?.item.coalesceKey ??
      nid;
    for (const a of actions) {
      if (a.type === "send" && (a.channel === "whatsapp" || a.channel === "call" || a.channel === "sms"))
        await tx.recordSent({ nid: a.nid, channel: a.channel, at: now }, keyOf(a.nid));
    }
    for (const a of actions) {
      if (a.type !== "ladder") continue;
      await tx.saveLadder(a.ladder);
      await tx.upsertNotification(notificationRow(a.ladder, actions));
    }
    return { prefs, history, actions };
  });
  if (!decided) {
    deps.log.info("notifier.unknown_user", { uid });
    return [];
  }
  const { prefs, history, actions } = decided;
  const previous = new Map(history.ladders.map((l) => [l.item.nid, l]));
  const ladders = new Map(
    actions.flatMap((a) => (a.type === "ladder" ? [[a.ladder.item.nid, a.ladder] as const] : [])),
  );

  for (const a of actions) {
    try {
      await execute(deps, uid, prefs, a, previous.get("nid" in a ? a.nid : "")?.nextAt ?? null, ladders);
    } catch (err) {
      deps.log.error("notifier.action_failed", {
        uid,
        type: a.type,
        channel: a.type === "send" ? a.channel : undefined,
        error: err instanceof Error ? err.message : "error",
      });
    }
  }
  return actions;
};

const notificationRow = (l: Ladder, actions: Action[]): NotificationRow => {
  const mine = actions.filter((a): a is Extract<Action, { type: "send" }> => a.type === "send" && a.nid === l.item.nid);
  const desktop = mine.filter((a) => a.channel === "desktop").at(-1);
  return {
    nid: l.item.nid,
    source: l.item.source,
    urgency: l.item.urgency,
    counts: l.item.counts,
    deepLink: l.item.deepLink,
    coalesceKey: l.item.coalesceKey,
    state: STATE[l.state],
    step: l.step,
    nextAt: l.nextAt,
    createdAt: l.openedAt,
    ...(desktop ? { level: desktop.level as Level } : {}),
    channels: [...new Set(mine.map((a) => a.channel as Channel))],
    ackedAt: l.ackedAt,
    ackedVia: l.ackedVia,
  };
};

const execute = async (
  deps: NotifierDeps,
  uid: string,
  prefs: UserPrefs,
  a: Action,
  previousNextAt: number | null,
  ladders: Map<string, Ladder>,
) => {
  switch (a.type) {
    case "schedule":
      return deps.scheduler.schedule(uid, a.nid, a.at);
    case "cancel":
      if (previousNextAt !== null) await deps.scheduler.cancel(uid, a.nid, previousNextAt);
      return;
    case "suppressed":
      deps.log.info("notifier.suppressed", { uid, nid: a.nid, channel: a.channel, reason: a.reason });
      return;
    case "ladder":
      return; // persisted under the lock
    case "send":
      break;
  }
  const to = prefs.phone?.e164;
  switch (a.channel) {
    case "desktop":
      return; // the notification row written under the lock reaches the desktop over Realtime
    case "push": {
      const ttl = a.payload.notice ? 3600 : a.payload.source === "approval" ? 600 : 3600;
      for (const sub of await deps.store.pushSubscriptions(uid)) {
        if ((await deps.push.send(sub, a.payload, ttl)) === "gone")
          await deps.store.deletePushSubscription(uid, sub.endpoint);
      }
      return;
    }
    case "whatsapp":
    case "sms": {
      if (!to) return;
      const country = prefs.phone?.country ?? "";
      const gate = deps.billing ? await deps.billing.admit(uid, a.channel, a.nid, country) : null;
      if (gate && !gate.ok) {
        deps.log.info("notifier.suppressed", { uid, nid: a.nid, channel: a.channel, reason: gate.reason });
        return;
      }
      const body = a.channel === "sms" ? smsBody(a.payload, deps.appUrl) : "";
      try {
        if (a.channel === "whatsapp") await deps.whatsapp.sendTemplate(to, a.payload);
        else await deps.twilio.sendSms({ to, body, statusCallback: `${deps.publicBaseUrl}/webhooks/twilio/status` });
      } catch (err) {
        if (gate?.ok) await deps.billing!.release(gate.reservationId);
        throw err;
      }
      if (gate?.ok)
        await deps.billing!.recordSend(uid, {
          channel: a.channel,
          nid: a.nid,
          country,
          segments: a.channel === "sms" ? smsSegments(body) : 1,
          reservationId: gate.reservationId,
        });
      return;
    }
    case "call": {
      const ladder = ladders.get(a.nid);
      if (!to || !ladder) return;
      const country = prefs.phone?.country ?? "";
      const gate = deps.billing ? await deps.billing.admit(uid, "call", a.nid, country) : null;
      if (gate && !gate.ok) {
        deps.log.info("notifier.suppressed", { uid, nid: a.nid, channel: "call", reason: gate.reason });
        return;
      }
      const script = buildBriefing(await callBriefing(deps, uid, prefs, ladder), {
        snoozeMin: Math.round(deps.config.snoozeMs / 60_000),
      });
      const gather = `${deps.publicBaseUrl}/webhooks/twilio/gather?uid=${encodeURIComponent(uid)}&nid=${encodeURIComponent(a.nid)}&lang=${prefs.locale}`;
      // The status callback carries who to bill (Twilio signs the whole URL).
      const status = new URL(`${deps.publicBaseUrl}/webhooks/twilio/status`);
      status.searchParams.set("uid", uid);
      status.searchParams.set("c", country);
      if (gate?.ok) status.searchParams.set("rid", gate.reservationId);
      try {
        await deps.twilio.createCall({
          to,
          twiml: briefingTwiml(script, deps.config.voices[prefs.locale], gather),
          statusCallback: status.toString(),
        });
      } catch (err) {
        if (gate?.ok) await deps.billing!.release(gate.reservationId);
        throw err;
      }
      return;
    }
  }
};

/** CallBriefing from the ladder's metadata plus the user's waiting items (lines only if enabled). */
const callBriefing = async (deps: NotifierDeps, uid: string, prefs: UserPrefs, l: Ladder): Promise<CallBriefing> => {
  const { callBriefingEnabled, items, mesaTitle } = await deps.store.callItems(uid);
  const { source, mesaStartsAt } = l.item;
  const mesa =
    source === "mesa_starting" && mesaTitle && mesaStartsAt !== undefined
      ? { title: mesaTitle.slice(0, 80), startsInMin: Math.max(0, Math.round((mesaStartsAt - deps.now()) / 60_000)) }
      : undefined;
  const kind: CallBriefing["kind"] = mesa
    ? "mesa_starting"
    : source === "approval" || source === "session_question"
      ? "agents_waiting"
      : source === "unanswered_messages"
        ? "unanswered_messages"
        : "mixed";
  return {
    v: 1,
    nid: l.item.nid,
    uid,
    locale: prefs.locale,
    kind,
    counts: l.item.counts,
    ...(mesa ? { mesa } : {}),
    items: items.slice(0, 10).map((it) => ({
      deviceLabel: it.deviceLabel.slice(0, 40),
      sessionLabel: it.sessionLabel.slice(0, 60),
      ...(callBriefingEnabled && it.line ? { line: it.line.slice(0, 160) } : {}),
    })),
    callBriefingEnabled,
  };
};
