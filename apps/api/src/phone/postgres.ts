import type { Sql } from "postgres";
import type { PhoneState, PhoneStore } from "./store.js";

/** PhoneStore over chalito.users (migration 20261004001100), as chalito_server. */
export class PostgresPhoneStore implements PhoneStore {
  constructor(private readonly sql: Sql) {}

  async get(owner: string): Promise<PhoneState | null> {
    const [u] = await this.sql<
      {
        phone_e164: string | null;
        phone_country: string | null;
        phone_verified_at: Date | null;
        charges_notice_ack_at: Date | null;
        whatsapp_opt_in: boolean;
        calls_enabled: boolean;
        sms_enabled: boolean | null;
      }[]
    >`select phone_e164, phone_country, phone_verified_at, charges_notice_ack_at, whatsapp_opt_in, calls_enabled, sms_enabled
      from chalito.users where id = ${owner}`;
    if (!u) return null;
    return {
      e164: u.phone_e164,
      country: u.phone_country,
      verifiedAt: u.phone_verified_at?.getTime() ?? null,
      chargesNoticeAckAt: u.charges_notice_ack_at?.getTime() ?? null,
      whatsapp: u.whatsapp_opt_in,
      calls: u.calls_enabled,
      sms: u.sms_enabled,
    };
  }

  async setVerified(owner: string, p: { e164: string; country: string; at: number }) {
    try {
      await this.sql`
        update chalito.users set phone_e164 = ${p.e164}, phone_country = ${p.country},
          phone_verified_at = ${new Date(p.at)}, charges_notice_ack_at = ${new Date(p.at)}
        where id = ${owner}`;
      return "ok" as const;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return "in_use" as const; // users_verified_phone_key
      throw err;
    }
  }

  async setChannels(owner: string, c: Partial<Pick<PhoneState, "whatsapp" | "calls" | "sms">>) {
    await this.sql`
      update chalito.users set
        whatsapp_opt_in = ${c.whatsapp ?? this.sql`whatsapp_opt_in`},
        calls_enabled = ${c.calls ?? this.sql`calls_enabled`},
        sms_enabled = ${c.sms === undefined ? this.sql`sms_enabled` : c.sms}
      where id = ${owner}`;
  }

  async clear(owner: string) {
    // One statement: the CHECK forbids opt-ins without a verified number and acknowledgement.
    await this.sql`
      update chalito.users set phone_e164 = null, phone_country = null, phone_verified_at = null,
        charges_notice_ack_at = null, whatsapp_opt_in = false, calls_enabled = false, sms_enabled = null
      where id = ${owner}`;
  }
}
