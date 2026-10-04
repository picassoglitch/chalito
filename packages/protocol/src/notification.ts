import { z } from "zod";
import {
  Counts,
  DeepLink,
  DeviceId,
  EpochMs,
  Level,
  Locale,
  NotificationId,
  SessionId,
  Uid,
  Urgency,
} from "./common.js";

export const NotificationSource = z.enum([
  "approval",
  "session_question",
  "mesa_starting",
  "room_event",
  "unanswered_messages",
  "budget",
  "trial",
  "devmode",
  "security",
  "reminder",
]);
export type NotificationSource = z.infer<typeof NotificationSource>;

export const Channel = z.enum(["desktop", "push", "whatsapp", "call", "sms"]);
export type Channel = z.infer<typeof Channel>;

export const NotificationState = z.enum(["pending", "acked", "snoozed", "expired"]);

/** `users/{uid}/notifications/{nid}`: metadata only, never content. */
export const Notification = z.object({
  v: z.literal(1),
  nid: NotificationId,
  uid: Uid,
  level: Level,
  source: NotificationSource,
  urgency: Urgency,
  counts: Counts,
  deepLink: DeepLink,
  /** Coalescing key: notifications with the same key merge into one ladder. */
  coalesceKey: z.string().max(128),
  state: NotificationState,
  step: z.number().int().nonnegative(),
  nextAt: EpochMs.nullable(),
  channels: z.array(Channel),
  createdAt: EpochMs,
  ackedAt: EpochMs.nullable().default(null),
  ackedVia: Channel.or(z.literal("app")).nullable().default(null),
});
export type Notification = z.infer<typeof Notification>;

/**
 * The ONLY values that may be rendered into a WhatsApp/SMS template.
 * Integers and enums; no free text, so content can't leak by construction.
 */
export const OutboundTemplateVars = z
  .object({
    template: z.enum(["chalito_pendientes_v1"]),
    locale: Locale,
    total: z.number().int().nonnegative().max(999),
    source: NotificationSource,
    urgency: Urgency,
    /** Button URL suffix: an opaque notification id, resolved after sign-in. */
    linkId: NotificationId,
  })
  .strict();
export type OutboundTemplateVars = z.infer<typeof OutboundTemplateVars>;

/**
 * `users/{uid}/callLines/{lid}`: the only plaintext content the device publishes,
 * and only when call briefing is enabled for the user and allowed by local policy.
 * One short sentence: session label + open question. No paths, diffs or commands.
 */
const FORBIDDEN_IN_CALL_LINE = /[/\\`$|<>{}~]|https?:|\w\.\w{1,5}\b/;
export const CallLine = z.object({
  v: z.literal(1),
  notificationId: NotificationId,
  deviceId: DeviceId,
  sid: SessionId,
  line: z
    .string()
    .min(1)
    .max(160)
    .refine((s) => !FORBIDDEN_IN_CALL_LINE.test(s), "call line must not contain paths, URLs or command syntax")
    .refine((s) => (s.match(/[.?!]/g) ?? []).length <= 1, "call line must be one sentence"),
  expireAt: EpochMs,
});
export type CallLine = z.infer<typeof CallLine>;

/** DTMF menu is fixed: 1 connect, 2 snooze (re-call at T-1 min / later), 3 dismiss. */
export const CallMenuChoice = z.enum(["connect", "snooze", "dismiss"]);

/** Input to the deterministic briefing script builder (packages/escalation/briefing.ts). */
export const CallBriefing = z.object({
  v: z.literal(1),
  nid: NotificationId,
  uid: Uid,
  locale: Locale,
  kind: z.enum(["mesa_starting", "agents_waiting", "unanswered_messages", "mixed"]),
  counts: Counts,
  mesa: z.object({ title: z.string().max(80), startsInMin: z.number().int().nonnegative() }).optional(),
  unansweredWindowHours: z.number().int().positive().optional(),
  items: z
    .array(
      z.object({
        deviceLabel: z.string().max(40),
        sessionLabel: z.string().max(60),
        /** Present only when callBriefing.enabled and the device published a CallLine. */
        line: z.string().max(160).optional(),
      }),
    )
    .max(10),
  callBriefingEnabled: z.boolean(),
});
export type CallBriefing = z.infer<typeof CallBriefing>;
