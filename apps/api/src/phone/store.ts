/** The user's phone and channel opt-ins (chalito.users columns; a CHECK there mirrors these rules). */
export interface PhoneState {
  e164: string | null;
  country: string | null;
  verifiedAt: number | null;
  chargesNoticeAckAt: number | null;
  whatsapp: boolean;
  calls: boolean;
  /** null: the country default. */
  sms: boolean | null;
}

export interface PhoneStore {
  get(owner: string): Promise<PhoneState | null>;
  /** Sets a verified number (and the charges acknowledgement); "in_use" if another account verified it. */
  setVerified(owner: string, p: { e164: string; country: string; at: number }): Promise<"ok" | "in_use">;
  setChannels(owner: string, c: Partial<Pick<PhoneState, "whatsapp" | "calls" | "sms">>): Promise<void>;
  /** Removes the number and every opt-in in one write. */
  clear(owner: string): Promise<void>;
}

export class MemoryPhoneStore implements PhoneStore {
  readonly users = new Map<string, PhoneState>();
  async get(owner: string) {
    return this.users.get(owner) ?? null;
  }
  async setVerified(owner: string, p: { e164: string; country: string; at: number }) {
    for (const [o, s] of this.users)
      if (o !== owner && s.e164 === p.e164 && s.verifiedAt !== null) return "in_use" as const;
    const cur = this.users.get(owner) ?? { whatsapp: false, calls: false, sms: null };
    this.users.set(owner, {
      ...cur,
      e164: p.e164,
      country: p.country,
      verifiedAt: p.at,
      chargesNoticeAckAt: p.at,
    } as PhoneState);
    return "ok" as const;
  }
  async setChannels(owner: string, c: Partial<Pick<PhoneState, "whatsapp" | "calls" | "sms">>) {
    const cur = this.users.get(owner);
    if (cur) this.users.set(owner, { ...cur, ...c });
  }
  async clear(owner: string) {
    this.users.set(owner, {
      e164: null,
      country: null,
      verifiedAt: null,
      chargesNoticeAckAt: null,
      whatsapp: false,
      calls: false,
      sms: null,
    });
  }
}
