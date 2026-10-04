import { createHmac, timingSafeEqual } from "node:crypto";

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * X-Twilio-Signature: base64 HMAC-SHA1 (auth token) over the full URL followed by every POST
 * parameter, sorted by name, as name+value.
 */
export const twilioSignature = (authToken: string, url: string, params: Record<string, string>) =>
  createHmac("sha1", authToken)
    .update(
      url +
        Object.keys(params)
          .sort()
          .map((k) => k + params[k])
          .join(""),
    )
    .digest("base64");

export const twilioSignatureValid = (
  authToken: string,
  url: string,
  params: Record<string, string>,
  header: string | undefined,
) => !!header && safeEqual(twilioSignature(authToken, url, params), header);

/** X-Hub-Signature-256: "sha256=" + hex HMAC-SHA256 of the raw body, keyed with the app secret. */
export const metaSignature = (appSecret: string, rawBody: string) =>
  `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;

export const metaSignatureValid = (appSecret: string, rawBody: string, header: string | undefined) =>
  !!header && safeEqual(metaSignature(appSecret, rawBody), header);
