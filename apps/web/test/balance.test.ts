import { describe, expect, it } from "vitest";
import { httpBalance, parseBalance } from "@/lib/balance";

const BODY = {
  remaining: 4_200_000,
  unlimited: false,
  monthlyAllocation: 5_000_000,
  bonus: 100_000,
  monthlyUsed: 900_000,
  reserved: 50_000,
  periodStart: "2026-10-01T00:00:00.000Z",
};
const answer = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

describe("balance (GET /v1/billing/balance)", () => {
  it("keeps tokens, the period start as ms, and a negative remaining as zero", () => {
    expect(parseBalance(BODY)).toEqual({ ...BODY, periodStart: Date.parse(BODY.periodStart) });
    expect(parseBalance({ ...BODY, remaining: -5 })!.remaining).toBe(0);
  });

  it("refuses anything malformed rather than showing zeros", () => {
    for (const bad of [
      null,
      { ...BODY, unlimited: "no" },
      { ...BODY, bonus: -1 },
      { ...BODY, periodStart: "x" },
      { ...BODY, remaining: "1" },
    ])
      expect(parseBalance(bad), JSON.stringify(bad)).toBeNull();
  });

  it("503 is the hub being unavailable; anything else failing is an error", async () => {
    const token = async () => "tok";
    expect(await httpBalance("https://api.test", token, answer(200, BODY))()).toMatchObject({ remaining: 4_200_000 });
    expect(await httpBalance("https://api.test", token, answer(503, { error: "hub_unavailable" }))()).toBe(
      "unavailable",
    );
    expect(await httpBalance("https://api.test", token, answer(403, {}))()).toBe("error");
    expect(await httpBalance("https://api.test", async () => null, answer(200, BODY))()).toBe("error");
  });
});
