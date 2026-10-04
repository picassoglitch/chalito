import { afterEach, describe, expect, it, vi } from "vitest";
import { apiPhone } from "@/lib/phone";

const respond = (status: number, body: unknown) =>
  vi.fn(async () => ({ ok: status < 300, status, json: async () => body }) as Response);

afterEach(() => vi.unstubAllGlobals());

describe("api phone routes (apps/api/src/phone/routes.ts)", () => {
  const phone = () => apiPhone("https://api.example", async () => "tok");

  it("start sends channel, locale and the charges acknowledgement with the bearer", async () => {
    const f = respond(202, { ok: true });
    vi.stubGlobal("fetch", f);
    expect(await phone().verifier.start("+525512345678", { channel: "call", locale: "en" })).toEqual({ ok: true });
    expect(f).toHaveBeenCalledWith(
      "https://api.example/v1/phone/start",
      expect.objectContaining({
        body: JSON.stringify({ e164: "+525512345678", channel: "call", locale: "en", chargesNoticeAck: true }),
        headers: expect.objectContaining({ authorization: "Bearer tok" }),
      }),
    );
  });

  it("maps the api's errors", async () => {
    const cases: [number, unknown, "start" | "check" | "channels", unknown][] = [
      [400, { error: "invalid_phone" }, "start", { ok: false, reason: "invalid" }],
      [400, { error: "charges_notice_required" }, "start", { ok: false, reason: "charges_notice_required" }],
      [429, {}, "start", { ok: false, reason: "rate_limited" }],
      [400, { error: "bad_code" }, "check", { ok: false, reason: "wrong_code" }],
      [409, { error: "phone_in_use" }, "check", { ok: false, reason: "in_use" }],
      [422, { error: "country_not_supported" }, "channels", { ok: false, reason: "country_not_supported" }],
      [409, { error: "phone_not_verified" }, "channels", { ok: false, reason: "phone_not_verified" }],
      [500, {}, "channels", { ok: false, reason: "error" }],
    ];
    for (const [status, body, op, want] of cases) {
      vi.stubGlobal("fetch", respond(status, body));
      const p = phone();
      const got =
        op === "start"
          ? await p.verifier.start("+525512345678", { channel: "sms", locale: "es" })
          : op === "check"
            ? await p.verifier.check("+525512345678", "123456")
            : await p.channels({ calls: true });
      expect(got, `${op} ${status}`).toEqual(want);
    }
  });
});
