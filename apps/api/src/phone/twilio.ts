/** Twilio Verify (OTP by SMS or call) and Voice Geo Permissions, over REST. */
export interface PhoneVerifier {
  start(e164: string, channel: "sms" | "call", locale: "es" | "en"): Promise<void>;
  /** True when Twilio says the code is approved. */
  check(e164: string, code: string): Promise<boolean>;
  /** Whether voice calls to this ISO country are allowed by the account's Geo Permissions. */
  callsAllowed(country: string): Promise<boolean>;
}

export const twilioPhoneVerifier = (opts: {
  accountSid: string;
  authToken: string;
  verifyServiceSid: string;
  fetch?: typeof fetch;
}): PhoneVerifier => {
  const auth = `Basic ${Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString("base64")}`;
  const f = opts.fetch ?? fetch;
  const form = (url: string, body: Record<string, string>) =>
    f(url, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  const verify = `https://verify.twilio.com/v2/Services/${opts.verifyServiceSid}`;
  return {
    async start(e164, channel, locale) {
      const res = await form(`${verify}/Verifications`, { To: e164, Channel: channel, Locale: locale });
      if (!res.ok) throw new Error(`verify start failed: ${res.status}`);
    },
    async check(e164, code) {
      const res = await form(`${verify}/VerificationCheck`, { To: e164, Code: code });
      if (res.status === 404) return false; // expired or already used
      if (!res.ok) throw new Error(`verify check failed: ${res.status}`);
      return ((await res.json()) as { status?: string }).status === "approved";
    },
    async callsAllowed(country) {
      const res = await f(`https://voice.twilio.com/v1/DialingPermissions/Countries/${encodeURIComponent(country)}`, {
        headers: { authorization: auth },
      });
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`dialing permissions failed: ${res.status}`);
      return ((await res.json()) as { low_risk_numbers_enabled?: boolean }).low_risk_numbers_enabled === true;
    },
  };
};
