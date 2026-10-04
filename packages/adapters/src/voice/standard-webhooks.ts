import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Standard Webhooks (https://github.com/standard-webhooks/standard-webhooks), the scheme OpenAI
 * webhooks use: headers webhook-id, webhook-timestamp (unix seconds) and webhook-signature
 * ("v1,<base64>" entries, space-separated). The signature is HMAC-SHA256 over
 * "<id>.<timestamp>.<raw body>", keyed with the base64 secret after its "whsec_" prefix.
 */
const key = (secret: string) => Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");

export const signStandardWebhook = (secret: string, id: string, timestamp: number, body: string) =>
  `v1,${createHmac("sha256", key(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}`;

export const verifyStandardWebhook = (p: {
  secret: string;
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  body: string;
  nowMs: number;
  /** Replay window either side of now (default 5 minutes, as the spec suggests). */
  toleranceSec?: number;
}): boolean => {
  if (!p.id || !p.timestamp || !p.signature || !/^\d+$/.test(p.timestamp)) return false;
  const ts = Number(p.timestamp);
  if (Math.abs(p.nowMs / 1000 - ts) > (p.toleranceSec ?? 300)) return false;
  const expected = Buffer.from(signStandardWebhook(p.secret, p.id, ts, p.body).slice(3), "base64");
  return p.signature.split(" ").some((entry) => {
    const [version, sig] = entry.split(",", 2);
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
};
