import type { PhoneVerifier } from "@chalito/ui";

export type ChannelsPatch = { whatsapp?: boolean; calls?: boolean; sms?: boolean | null };
export type ChannelsResult =
  | { ok: true }
  | { ok: false; reason: "phone_not_verified" | "charges_notice_required" | "country_not_supported" | "error" };

/** POST /v1/phone/channels: the only way to turn a paid channel ON (the settings RPC refuses it). */
export type ChannelSetter = (patch: ChannelsPatch) => Promise<ChannelsResult>;

/**
 * Chalito's api phone routes (apps/api/src/phone/routes.ts, Twilio Verify behind them), with the
 * person's Supabase session as bearer. Errors arrive as {error}.
 */
export const apiPhone = (
  apiBase: string,
  accessToken: () => Promise<string | null>,
): { verifier: PhoneVerifier; channels: ChannelSetter } => {
  const post = async (path: string, body: unknown) => {
    const token = await accessToken();
    const res = await fetch(`${apiBase}/v1/phone${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      credentials: "omit",
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    return { status: res.status, ok: res.ok, error: json.error ?? "" };
  };
  return {
    verifier: {
      async start(e164, { channel, locale }) {
        try {
          // The UI only offers "send code" once the notice was acknowledged.
          const r = await post("/start", { e164, channel, locale, chargesNoticeAck: true });
          if (r.ok) return { ok: true };
          if (r.status === 429) return { ok: false, reason: "rate_limited" };
          if (r.error === "charges_notice_required") return { ok: false, reason: "charges_notice_required" };
          return { ok: false, reason: r.error === "invalid_phone" ? "invalid" : "error" };
        } catch {
          return { ok: false, reason: "error" };
        }
      },
      async check(e164, code) {
        try {
          const r = await post("/check", { e164, code });
          if (r.ok) return { ok: true };
          if (r.status === 409 && r.error === "phone_in_use") return { ok: false, reason: "in_use" };
          // Twilio reports an expired code as a wrong one.
          return { ok: false, reason: r.error === "bad_code" ? "wrong_code" : "error" };
        } catch {
          return { ok: false, reason: "error" };
        }
      },
    },
    async channels(patch) {
      try {
        const r = await post("/channels", patch);
        if (r.ok) return { ok: true };
        if (
          r.error === "phone_not_verified" ||
          r.error === "charges_notice_required" ||
          r.error === "country_not_supported"
        )
          return { ok: false, reason: r.error };
        return { ok: false, reason: "error" };
      } catch {
        return { ok: false, reason: "error" };
      }
    },
  };
};
