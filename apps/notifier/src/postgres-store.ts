import type { Sql } from "postgres";
import type { Ladder, Presence, SentRecord, UserPrefs } from "@chalito/escalation";
import type { RelayedCommand } from "@chalito/protocol";
import type {
  CallItem,
  NotificationRow,
  NotifierStore,
  PendingApproval,
  PushSubscriptionRecord,
  UserTx,
} from "./store.js";

type Json = Record<string, unknown>;

/**
 * NotifierStore over the chalito schema (schema-request.sql), as chalito_server. The per-user
 * lock is a transaction-scoped advisory lock, so concurrent Pub/Sub and Cloud Tasks deliveries
 * for one user decide one at a time.
 */
export class PostgresStore implements NotifierStore {
  constructor(private readonly sql: Sql) {}

  withUser<T>(uid: string, fn: (tx: UserTx) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`chalito.notifier:${uid}`}))`;
      return fn({
        prefs: async () => {
          const [u] = await tx<UserRow[]>`
            select tz, locale, quiet_hours, phone_e164, phone_country, phone_verified_at, charges_notice_ack_at,
                   whatsapp_opt_in, calls_enabled, sms_enabled, l4_quiet_override
            from chalito.users where id = ${uid}`;
          return u ? toPrefs(u) : null;
        },
        presence: async (): Promise<Presence> => {
          const [r] = await tx<{ active: boolean }[]>`
            select exists (
              select 1 from chalito.devices
              where owner = ${uid} and not revoked and (presence ->> 'desktopActive')::boolean
                and last_seen_at > now() - interval '2 minutes'
            ) as active`;
          return { desktopActive: r?.active === true };
        },
        history: async (since) => {
          const ladders = await tx<{ ladder: Ladder }[]>`
            select ladder from chalito_private.notification_ladders
            where owner = ${uid} and (state in ('pending', 'snoozed') or updated_at > now() - interval '1 day')`;
          const sent = await tx<{ nid: string; channel: SentRecord["channel"]; at: Date }[]>`
            select nid, channel, created_at as at from chalito_private.notification_sends
            where owner = ${uid} and channel in ('whatsapp', 'call', 'sms') and status <> 'failed'
              and created_at >= ${new Date(since)}`;
          return {
            ladders: ladders.map((r) => r.ladder),
            sent: sent.map((r) => ({ nid: r.nid, channel: r.channel, at: r.at.getTime() })),
          };
        },
        saveLadder: async (l) => {
          await tx`
            insert into chalito_private.notification_ladders (owner, coalesce_key, nid, state, ladder, next_at, updated_at)
            values (${uid}, ${l.item.coalesceKey}, ${l.item.nid}, ${l.state}, ${tx.json(l as never)},
                    ${l.nextAt === null ? null : new Date(l.nextAt)}, now())
            on conflict (owner, coalesce_key) do update set nid = excluded.nid, state = excluded.state,
              ladder = excluded.ladder, next_at = excluded.next_at, updated_at = now()`;
        },
        recordSent: async (s, coalesceKey) => {
          await tx`insert into chalito_private.notification_sends (owner, nid, coalesce_key, channel, status, created_at)
                   values (${uid}, ${s.nid}, ${coalesceKey}, ${s.channel}, 'queued', ${new Date(s.at)})`;
        },
        upsertNotification: async (n: NotificationRow) => {
          await tx`
            insert into chalito.notifications
              (owner, nid, level, source, urgency, counts, deep_link, coalesce_key, state, step, next_at,
               channels, created_at, acked_at, acked_via)
            values (${uid}, ${n.nid}, ${n.level ?? "L0"}, ${n.source}, ${n.urgency}, ${tx.json(n.counts as never)},
                    ${n.deepLink}, ${n.coalesceKey}, ${n.state}, ${n.step}, ${n.nextAt === null ? null : new Date(n.nextAt)},
                    ${n.channels}, ${new Date(n.createdAt)}, ${n.ackedAt === null ? null : new Date(n.ackedAt)}, ${n.ackedVia})
            on conflict (owner, nid) do update set
              level = ${n.level ? tx`excluded.level` : tx`chalito.notifications.level`},
              urgency = excluded.urgency, counts = excluded.counts, deep_link = excluded.deep_link,
              state = excluded.state, step = excluded.step, next_at = excluded.next_at,
              channels = array(select distinct unnest(chalito.notifications.channels || excluded.channels)),
              acked_at = excluded.acked_at, acked_via = excluded.acked_via`;
        },
      });
    }) as Promise<T>;
  }

  async findUserByPhone(e164: string) {
    const [r] = await this.sql<{ id: string }[]>`
      select id from chalito.users where phone_e164 = ${e164} and phone_verified_at is not null limit 1`;
    return r?.id ?? null;
  }

  async pushSubscriptions(uid: string): Promise<PushSubscriptionRecord[]> {
    const rows = await this.sql<{ endpoint: string; p256dh: string; auth: string }[]>`
      select endpoint, p256dh, auth from chalito.push_subscriptions where owner = ${uid}`;
    return rows.map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
  }

  async deletePushSubscription(uid: string, endpoint: string) {
    await this.sql`delete from chalito.push_subscriptions where owner = ${uid} and endpoint = ${endpoint}`;
  }

  async optOut(uid: string, channel: "whatsapp" | "sms") {
    if (channel === "whatsapp") await this.sql`update chalito.users set whatsapp_opt_in = false where id = ${uid}`;
    else await this.sql`update chalito.users set sms_enabled = false where id = ${uid}`;
  }

  async callItems(uid: string) {
    const [u] = await this.sql<{ enabled: boolean | null }[]>`
      select (call_briefing ->> 'enabled')::boolean as enabled from chalito.users where id = ${uid}`;
    const callBriefingEnabled = u?.enabled === true;
    const rows = await this.sql<
      { device_label: string; session_label: string; line: string; device_id: string; sid: string }[]
    >`
      select d.name as device_label, coalesce(s.doc ->> 'label', cl.sid) as session_label, cl.line, cl.device_id, cl.sid
      from chalito.call_lines cl
      join chalito.devices d on d.owner = cl.owner and d.device_id = cl.device_id
      left join chalito.sessions s on s.owner = cl.owner and s.sid = cl.sid
      where cl.owner = ${uid} and cl.expires_at > now()
      order by cl.created_at limit 10`;
    const items: CallItem[] = rows.map((r) => ({
      deviceLabel: r.device_label,
      sessionLabel: r.session_label,
      deviceId: r.device_id,
      sid: r.sid,
      ...(callBriefingEnabled ? { line: r.line } : {}),
    }));
    return { callBriefingEnabled, items };
  }

  async pendingApprovals(uid: string): Promise<PendingApproval[]> {
    const rows = await this.sql<{ aid: string; device_label: string; session_label: string }[]>`
      select a.aid, d.name as device_label, coalesce(s.doc ->> 'label', a.sid) as session_label
      from chalito.approvals a
      join chalito.devices d on d.owner = a.owner and d.device_id = a.device_id
      left join chalito.sessions s on s.owner = a.owner and s.sid = a.sid
      where a.owner = ${uid} and a.status = 'pending' and a.expires_at > now()
      order by a.created_at limit 10`;
    return rows.map((r) => ({ aid: r.aid, deviceLabel: r.device_label, sessionLabel: r.session_label }));
  }

  async planInfo(uid: string) {
    const [u] = await this.sql<{ tier: string | null; tz: string | null; locale: "es" | "en" }[]>`
      select tier, tz, locale from chalito.users where id = ${uid}`;
    return u ? { hubTier: u.tier, tz: u.tz ?? "America/Mexico_City", locale: u.locale } : null;
  }

  async monthlySends(uid: string, sinceMs: number) {
    const rows = await this.sql<{ channel: "whatsapp" | "sms" | "call"; n: string }[]>`
      select channel, count(*) as n from chalito_private.notification_sends
      where owner = ${uid} and channel in ('whatsapp', 'sms', 'call') and status <> 'failed'
        and created_at >= ${new Date(sinceMs)}
      group by channel`;
    const out = { whatsapp: 0, sms: 0, call: 0 };
    for (const r of rows) out[r.channel] = Number(r.n);
    return out;
  }

  async voiceSecondsSince(uid: string, sinceMs: number) {
    const [r] = await this.sql<{ s: string }[]>`
      select coalesce(sum((event ->> 'amount')::bigint), 0) as s from chalito_private.usage_outbox
      where owner = ${uid} and event ->> 'kind' = 'voice.seconds' and created_at >= ${new Date(sinceMs)}`;
    return Number(r?.s ?? 0);
  }

  async markSuppressed(uid: string, nid: string, channel: "whatsapp" | "sms" | "call", reason: string) {
    await this.sql`
      update chalito_private.notification_sends set status = 'failed', error = ${reason}
      where id = (
        select id from chalito_private.notification_sends
        where owner = ${uid} and nid = ${nid} and channel = ${channel} and status = 'queued'
        order by id desc limit 1
      )`;
  }

  async noteOnce(uid: string, n: NotificationRow) {
    await this.sql`
      insert into chalito.notifications
        (owner, nid, level, source, urgency, counts, deep_link, coalesce_key, state, step, next_at, channels, created_at)
      values (${uid}, ${n.nid}, ${n.level ?? "L1"}, ${n.source}, ${n.urgency}, ${this.sql.json(n.counts as never)},
              ${n.deepLink}, ${n.coalesceKey}, ${n.state}, ${n.step}, null, ${n.channels}, ${new Date(n.createdAt)})
      on conflict (owner, nid) do nothing`;
  }

  async claimCallRef(refHash: string, expiresAt: number) {
    const rows = await this.sql`
      insert into chalito_private.voice_call_refs (ref_hash, expires_at) values (${refHash}, ${new Date(expiresAt)})
      on conflict (ref_hash) do nothing returning ref_hash`;
    return rows.length > 0;
  }

  async companionName(uid: string) {
    const [r] = await this.sql<{ name: string }[]>`
      select name from chalito.companions where owner = ${uid} order by created_at limit 1`;
    return r?.name ?? null;
  }

  async agentPubBox(uid: string, deviceId: string) {
    const [r] = await this.sql<{ pub_box: string }[]>`
      select pub_box from chalito.devices where owner = ${uid} and device_id = ${deviceId} and role = 'agent' and not revoked`;
    return r?.pub_box ?? null;
  }

  async insertRelayedCommand(uid: string, targetDeviceId: string, cid: string, env: RelayedCommand, expiresAt: number) {
    await this.sql`
      insert into chalito.commands (owner, target_device_id, id, env, from_device_id, expires_at)
      values (${uid}, ${targetDeviceId}, ${cid}, ${this.sql.json(env as never)}, 'notifier', ${new Date(expiresAt)})`;
  }
}

interface UserRow {
  tz: string | null;
  locale: "es" | "en";
  quiet_hours: Json | null;
  phone_e164: string | null;
  phone_country: string | null;
  phone_verified_at: Date | null;
  charges_notice_ack_at: Date | null;
  whatsapp_opt_in: boolean;
  calls_enabled: boolean;
  sms_enabled: boolean | null;
  l4_quiet_override: string[];
}

const toPrefs = (u: UserRow): UserPrefs => ({
  tz: u.tz ?? "America/Mexico_City",
  locale: u.locale,
  ...(u.quiet_hours === null
    ? {}
    : {
        quietHours:
          u.quiet_hours.off === true ? null : { start: String(u.quiet_hours.start), end: String(u.quiet_hours.end) },
      }),
  phone: u.phone_e164
    ? {
        e164: u.phone_e164,
        country: u.phone_country ?? "",
        verified: u.phone_verified_at !== null,
        chargesNoticeAckAt: u.charges_notice_ack_at ? u.charges_notice_ack_at.getTime() : null,
      }
    : null,
  whatsapp: { optIn: u.whatsapp_opt_in },
  calls: { enabled: u.calls_enabled },
  ...(u.sms_enabled === null ? {} : { sms: { enabled: u.sms_enabled } }),
  l4QuietOverride: u.l4_quiet_override as UserPrefs["l4QuietOverride"],
});
