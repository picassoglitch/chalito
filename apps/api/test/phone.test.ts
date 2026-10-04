import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { MemoryAudit } from "../src/deps.js";
import { MemoryPhoneStore } from "../src/phone/store.js";
import { twilioPhoneVerifier } from "../src/phone/twilio.js";
import type { ApiRepo, IdentityIssuer } from "../src/repo.js";

/** Twilio Verify and Voice Geo Permissions, mocked at the HTTP layer. */
const seen: { path: string; form?: Record<string, string> }[] = [];
const allowed = new Set(["MX", "US"]);
const server = setupServer(
  http.post("https://verify.twilio.com/v2/Services/:sid/Verifications", async ({ request }) => {
    seen.push({ path: "start", form: Object.fromEntries(new URLSearchParams(await request.text())) });
    return HttpResponse.json({ status: "pending" }, { status: 201 });
  }),
  http.post("https://verify.twilio.com/v2/Services/:sid/VerificationCheck", async ({ request }) => {
    const form = Object.fromEntries(new URLSearchParams(await request.text()));
    seen.push({ path: "check", form });
    return HttpResponse.json({ status: form.Code === "123456" ? "approved" : "pending" });
  }),
  http.get("https://voice.twilio.com/v1/DialingPermissions/Countries/:iso", ({ params }) =>
    HttpResponse.json({ iso_code: params.iso, low_risk_numbers_enabled: allowed.has(String(params.iso)) }),
  ),
);
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());
beforeEach(() => void (seen.length = 0));

const setup = () => {
  const store = new MemoryPhoneStore();
  const identity = {
    verify: async (token: string) => ({ uid: token, role: "user", owner: token }),
  } as unknown as IdentityIssuer;
  const app = createApp({
    repo: {} as ApiRepo,
    identity,
    audit: new MemoryAudit(),
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: () => 1_790_000_000_000,
    phone: {
      store,
      verifier: twilioPhoneVerifier({ accountSid: "ACtest", authToken: "tok", verifyServiceSid: "VAtest" }),
    },
  });
  const call = async (method: string, path: string, body: unknown, user = "u1") => {
    const res = await app.request(`/v1/phone${path}`, {
      method,
      headers: { authorization: `Bearer ${user}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  return { store, call };
};

describe("phone verification", () => {
  it("needs the charges notice, a possible number, and a correct OTP", async () => {
    const { call, store } = setup();
    expect(await call("POST", "/start", { e164: "+525512345678", channel: "sms" })).toMatchObject({
      status: 400,
      json: { error: "charges_notice_required" },
    });
    expect((await call("POST", "/start", { e164: "+5255", channel: "sms", chargesNoticeAck: true })).status).toBe(400);
    expect(
      (await call("POST", "/start", { e164: "+525512345678", channel: "call", chargesNoticeAck: true, locale: "es" }))
        .status,
    ).toBe(202);
    expect(seen[0]).toEqual({ path: "start", form: { To: "+525512345678", Channel: "call", Locale: "es" } });

    expect(await call("POST", "/check", { e164: "+525512345678", code: "000000" })).toMatchObject({
      status: 400,
      json: { error: "bad_code" },
    });
    expect(await store.get("u1")).toBeNull();
    expect(await call("POST", "/check", { e164: "+525512345678", code: "123456" })).toEqual({
      status: 200,
      json: { ok: true, country: "MX" },
    });
    expect(await store.get("u1")).toMatchObject({
      e164: "+525512345678",
      country: "MX",
      verifiedAt: 1_790_000_000_000,
      chargesNoticeAckAt: 1_790_000_000_000,
    });
  });

  it("a number verified by another account can't be taken", async () => {
    const { call } = setup();
    await call("POST", "/check", { e164: "+525512345678", code: "123456" }, "u1");
    expect(await call("POST", "/check", { e164: "+525512345678", code: "123456" }, "u2")).toMatchObject({
      status: 409,
      json: { error: "phone_in_use" },
    });
  });

  it("channels turn on only with a verified number; calls also need Geo Permissions for the country", async () => {
    const { call, store } = setup();
    expect(await call("POST", "/channels", { whatsapp: true })).toMatchObject({
      status: 409,
      json: { error: "phone_not_verified" },
    });
    expect((await call("POST", "/channels", { calls: false })).status).toBe(200); // turning off is always fine

    await call("POST", "/check", { e164: "+525512345678", code: "123456" });
    expect((await call("POST", "/channels", { whatsapp: true, calls: true, sms: true })).status).toBe(200);
    expect(await store.get("u1")).toMatchObject({ whatsapp: true, calls: true, sms: true });

    // A country outside Geo Permissions: no calls, with a clear error.
    await call("POST", "/check", { e164: "+34612345678", code: "123456" }, "u3");
    expect(await call("POST", "/channels", { calls: true }, "u3")).toMatchObject({
      status: 422,
      json: { error: "country_not_supported" },
    });
    expect((await call("POST", "/channels", { whatsapp: true }, "u3")).status).toBe(200);
  });

  it("removing the number clears every opt-in at once", async () => {
    const { call, store } = setup();
    await call("POST", "/check", { e164: "+525512345678", code: "123456" });
    await call("POST", "/channels", { whatsapp: true, calls: true });
    expect((await call("DELETE", "", {})).status).toBe(200);
    expect(await store.get("u1")).toMatchObject({
      e164: null,
      verifiedAt: null,
      whatsapp: false,
      calls: false,
      sms: null,
    });
  });

  it("requires a signed-in user", async () => {
    const { call } = setup();
    const res = await call("POST", "/channels", { whatsapp: false }, "");
    expect(res.status).toBe(401);
  });
});
