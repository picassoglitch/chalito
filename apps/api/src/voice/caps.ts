import type { Sql } from "postgres";
import { localMonthKey, localMonthStart, monthlyLimit } from "@chalito/billing";
import type { PlansConfig } from "@chalito/protocol";

/** Monthly voice minutes (plans.yaml voiceMinutes), shared by desktop push-to-talk and calls. */
export interface VoiceCap {
  status(owner: string, now: number): Promise<{ limitSeconds: number; usedSeconds: number }>;
  /** One in-app note per month when the minutes run out. */
  note(owner: string, now: number): Promise<void>;
}

/** VoiceCap over chalito.users (tier, tz) and the usage outbox's voice.seconds events. */
export const pgVoiceCap = (sql: Sql, plans: PlansConfig, isComped: (uid: string) => boolean): VoiceCap => {
  const user = async (owner: string) =>
    (
      await sql<{ tier: string | null; tz: string | null; locale: "es" | "en" }[]>`
      select tier, tz, locale from chalito.users where id = ${owner}`
    )[0];
  return {
    async status(owner, now) {
      const u = await user(owner);
      if (!u) return { limitSeconds: 0, usedSeconds: 0 };
      const limitSeconds =
        monthlyLimit(plans, { uid: owner, hubTier: u.tier, comped: isComped(owner), now }, "voice") * 60;
      const [r] = await sql<{ s: string }[]>`
        select coalesce(sum((event ->> 'amount')::bigint), 0) as s from chalito_private.usage_outbox
        where owner = ${owner} and event ->> 'kind' = 'voice.seconds'
          and created_at >= ${new Date(localMonthStart(now, u.tz ?? "America/Mexico_City"))}`;
      return { limitSeconds, usedSeconds: Number(r?.s ?? 0) };
    },
    async note(owner, now) {
      const u = await user(owner);
      if (!u) return;
      await sql`
        insert into chalito.notifications
          (owner, nid, level, source, urgency, counts, deep_link, coalesce_key, state, step, channels, created_at)
        values (${owner}, ${`cap_voice_${localMonthKey(now, u.tz ?? "America/Mexico_City")}`}, 'L1', 'budget', 'normal',
                ${sql.json({ approvals: 0, questions: 0, messages: 0, mesas: 0 })},
                ${u.locale === "en" ? "/en/creditos" : "/creditos"}, 'cap:voice', 'pending', 0, '{desktop}', ${new Date(now)})
        on conflict (owner, nid) do nothing`;
    },
  };
};
