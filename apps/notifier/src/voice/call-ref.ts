import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Ties a SIP call arriving at OpenAI to the Twilio call it came from. On DTMF 1 the notifier
 * dials `<sip uri>?X-Chalito-Ref=<ref>`; Twilio passes X- headers through, and OpenAI lists them in
 * realtime.call.incoming `sip_headers`. The ref is HMAC-signed, expires in 2 minutes and is
 * accepted once globally (chalito_private.voice_call_refs); a call without a valid ref is rejected.
 */
export interface CallRef {
  uid: string;
  nid: string;
  callSid: string;
  locale: "es" | "en";
  exp: number;
  /**
   * The call_lines the call was placed for (frozen at DTMF 1). Only these can be answered on the
   * call: the binding is server-side, whatever the voice model picks.
   */
  lids: string[];
  /** The call's voice bound (also Twilio's Dial timeLimit): what the session may bill at most. */
  maxSec: number;
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
    return typeof ref.exp === "number" &&
      ref.exp > nowMs &&
      /^CA[0-9a-f]{32}$/.test(ref.callSid) &&
      Number.isInteger(ref.maxSec) &&
      ref.maxSec > 0 &&
      Array.isArray(ref.lids) &&
      ref.lids.length <= 10 &&
      ref.lids.every((l) => typeof l === "string")
      ? ref
      : null;
  } catch {
    return null;
  }
};
