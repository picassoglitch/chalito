import type { PhoneVerifier } from "@chalito/ui";

/**
 * Phone verification through Chalito's api (Twilio Verify behind it). The browser only proposes
 * a number; the server stores it as verified after a correct code. Route names follow the api
 * slice; the access token is the person's Supabase session.
 */
export const apiPhoneVerifier = (apiBase: string, accessToken: () => Promise<string | null>): PhoneVerifier => {
  const post = async (path: string, body: unknown) => {
    const token = await accessToken();
    return fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      credentials: "omit",
    });
  };
  return {
    async start(e164) {
      try {
        const r = await post("/v1/phone/start", { e164 });
        if (r.ok) return { ok: true };
        return { ok: false, reason: r.status === 429 ? "rate_limited" : r.status === 400 ? "invalid" : "error" };
      } catch {
        return { ok: false, reason: "error" };
      }
    },
    async check(e164, code) {
      try {
        const r = await post("/v1/phone/check", { e164, code });
        if (r.ok) return { ok: true };
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        return { ok: false, reason: body.error === "expired" ? "expired" : r.status === 400 ? "wrong_code" : "error" };
      } catch {
        return { ok: false, reason: "error" };
      }
    },
  };
};
