export interface TwilioClient {
  createCall(p: { to: string; twiml: string; statusCallback: string }): Promise<{ sid: string }>;
  sendSms(p: { to: string; body: string; statusCallback?: string }): Promise<{ sid: string }>;
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
