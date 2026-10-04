export interface TwilioClient {
  createCall(p: { to: string; twiml: string; statusCallback: string }): Promise<{ sid: string }>;
  sendSms(p: { to: string; body: string; statusCallback?: string }): Promise<{ sid: string }>;
  /**
   * Hangs up a call in progress (Status=completed). A call that is already over (400) or
   * unknown (404) counts as ended.
   */
  endCall(callSid: string): Promise<void>;
}

/** Twilio REST (Programmable Voice and Messaging), form-encoded with basic auth. */
export const twilioClient = (opts: {
  accountSid: string;
  authToken: string;
  from: string;
  fetch?: typeof fetch;
}): TwilioClient => {
  const base = `https://api.twilio.com/2010-04-01/Accounts/${opts.accountSid}`;
  const auth = `Basic ${Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString("base64")}`;
  const post = async (path: string, form: Record<string, string>) => {
    const res = await (opts.fetch ?? fetch)(`${base}/${path}`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    if (!res.ok) throw new Error(`twilio ${path} failed: ${res.status}`);
    return (await res.json()) as { sid: string };
  };
  return {
    async endCall(callSid) {
      if (!/^CA[0-9a-f]{32}$/.test(callSid)) throw new Error("twilio endCall: bad CallSid");
      const res = await (opts.fetch ?? fetch)(`${base}/Calls/${callSid}.json`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ Status: "completed" }).toString(),
      });
      if (!res.ok && res.status !== 400 && res.status !== 404) throw new Error(`twilio endCall failed: ${res.status}`);
    },
    createCall: (p) =>
      post("Calls.json", { To: p.to, From: opts.from, Twiml: p.twiml, StatusCallback: p.statusCallback }),
    sendSms: (p) =>
      post("Messages.json", {
        To: p.to,
        From: opts.from,
        Body: p.body,
        ...(p.statusCallback ? { StatusCallback: p.statusCallback } : {}),
      }),
  };
};
