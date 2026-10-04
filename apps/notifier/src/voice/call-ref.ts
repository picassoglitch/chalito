import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Ties a SIP call arriving at OpenAI to the Twilio call it came from. On DTMF 1 the notifier
 * dials `<sip uri>?X-Chalito-Ref=<ref>`; Twilio passes X- headers through, and OpenAI lists them in
 * realtime.call.incoming `sip_headers`. The ref is HMAC-signed, expires in 2 minutes and is
 * accepted once per instance; a call without a valid ref is rejected.
 */
export interface CallRef {
  uid: string;
  nid: string;
  callSid: string;
  locale: "es" | "en";
  exp: number;
}

const mac = (secret: string, body: string) =>
  createHmac("sha256", secret).update(`chalito.call-ref.v1.${body}`).digest("base64url");

export const signCallRef = (secret: string, ref: CallRef) => {
  const body = Buffer.from(JSON.stringify(ref)).toString("base64url");
  return `${body}.${mac(secret, body)}`;
};

export const verifyCallRef = (secret: string, token: string | undefined, nowMs: number): CallRef | null => {
  const [body, sig] = (token ?? "").split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const ref = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CallRef;
    return typeof ref.exp === "number" && ref.exp > nowMs && /^CA[0-9a-f]{32}$/.test(ref.callSid) ? ref : null;
  } catch {
    return null;
  }
};

/** Best-effort single use within this instance (refs also expire in 2 minutes). */
export class UsedRefs {
  #seen = new Map<string, number>();
  claim(token: string, exp: number, nowMs: number): boolean {
    for (const [k, e] of this.#seen) if (e <= nowMs) this.#seen.delete(k);
    if (this.#seen.has(token)) return false;
    this.#seen.set(token, exp);
    return true;
  }
}
