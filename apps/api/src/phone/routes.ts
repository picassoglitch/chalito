import { Hono } from "hono";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { principal, requireAuth, type AuthEnv } from "../lib/auth.js";
import { fail } from "../lib/errors.js";
import { rateLimit } from "../lib/rate-limit.js";
import type { PhoneStore } from "./store.js";
import { VerifierError, type PhoneVerifier } from "./twilio.js";

export interface PhoneDeps {
  store: PhoneStore;
  verifier: PhoneVerifier;
}

const E164 = z.string().regex(/^\+[1-9]\d{7,14}$/);
const Start = z.object({
  e164: E164,
  channel: z.enum(["sms", "call"]),
  locale: z.enum(["es", "en"]).default("es"),
  /** "Pueden aplicar cargos de tu operador" / "Charges may apply" was shown and accepted. */
  chargesNoticeAck: z.literal(true),
});
const Check = z.object({ e164: E164, code: z.string().regex(/^\d{4,10}$/) });
const Channels = z
  .object({ whatsapp: z.boolean(), calls: z.boolean(), sms: z.boolean().nullable() })
  .partial()
  .refine((c) => Object.keys(c).length > 0);

/**
 * A Twilio failure is the provider's answer, never a 500: too many attempts (429), a refused
 * number or channel (400), anything else (5xx, network) is 503 and the person can try again.
 */
const viaTwilio = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof VerifierError)) throw err;
    console.error("[phone] verifier failed", err.status ?? "network");
    if (err.status === 429) return fail(429, "too_many_attempts");
    if (err.status === 400) return fail(400, "verify_refused");
    return fail(503, "verify_unavailable");
  }
};

const countryOf = (e164: string) => {
  const p = parsePhoneNumberFromString(e164);
  return p?.isPossible() && p.country ? p.country : null;
};

/**
 * Per-user phone (brief §5 M6, ADR 0011): any country code, OTP verification (Twilio Verify)
 * before any call, the "charges may apply" acknowledgement before any paid channel, and Geo
 * Permissions refusing calls to countries the account can't dial.
 */
export const phoneRoutes = (deps: Deps, phone: PhoneDeps) => {
  const app = new Hono<AuthEnv>();
  const auth = requireAuth(deps, ["user", "client"]);

  app.post("/start", auth, rateLimit({ capacity: 5, refillPerSec: 1 / 120, now: deps.now }), async (c) => {
    const raw = (await c.req.json().catch(() => null)) as { chargesNoticeAck?: unknown } | null;
    const body = Start.safeParse(raw);
    if (!body.success) return fail(400, raw?.chargesNoticeAck !== true ? "charges_notice_required" : "bad_request");
    if (!countryOf(body.data.e164)) return fail(400, "invalid_phone");
    await viaTwilio(() => phone.verifier.start(body.data.e164, body.data.channel, body.data.locale));
    await deps.audit.record({ action: "phone.verify_started", owner: principal(c).owner, actor: principal(c).uid });
    return c.json({ ok: true }, 202);
  });

  app.post("/check", auth, rateLimit({ capacity: 10, refillPerSec: 1 / 30, now: deps.now }), async (c) => {
    const p = principal(c);
    const body = Check.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const country = countryOf(body.data.e164);
    if (!country) return fail(400, "invalid_phone");
    if (!(await viaTwilio(() => phone.verifier.check(body.data.e164, body.data.code)))) return fail(400, "bad_code");
    // The acknowledgement was required to start; it is recorded with the verification, at server time.
    if ((await phone.store.setVerified(p.owner, { e164: body.data.e164, country, at: deps.now() })) === "in_use")
      return fail(409, "phone_in_use");
    await deps.audit.record({ action: "phone.verified", owner: p.owner, actor: p.uid, meta: { country } });
    return c.json({ ok: true, country });
  });

  app.post("/channels", auth, async (c) => {
    const p = principal(c);
    const body = Channels.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const turningOn = Object.values(body.data).some((v) => v === true);
    if (turningOn) {
      const s = await phone.store.get(p.owner);
      if (!s?.verifiedAt || !s.e164) return fail(409, "phone_not_verified");
      if (!s.chargesNoticeAckAt) return fail(409, "charges_notice_required");
      if (body.data.calls === true && !(await viaTwilio(() => phone.verifier.callsAllowed(s.country ?? ""))))
        return fail(422, "country_not_supported", "Calls to this country aren't available.");
    }
    await phone.store.setChannels(p.owner, body.data);
    await deps.audit.record({ action: "phone.channels", owner: p.owner, actor: p.uid, meta: body.data });
    return c.json({ ok: true });
  });

  app.delete("/", auth, async (c) => {
    const p = principal(c);
    await phone.store.clear(p.owner);
    await deps.audit.record({ action: "phone.removed", owner: p.owner, actor: p.uid });
    return c.json({ ok: true });
  });

  return app;
};
