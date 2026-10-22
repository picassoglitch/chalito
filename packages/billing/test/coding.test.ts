import { describe, expect, it } from "vitest";
import { loadPrices, loadProviders } from "@chalito/config";
import { isBillable, usageEvent } from "../src/billable.js";
import { localDayKey, localDayStart } from "../src/caps.js";
import { codingDailyCap, codingHoldJobId, codingSourceId, codingWorstCaseMicros } from "../src/coding.js";

const prices = loadPrices();
const cfg = loadProviders().codingManaged;

describe("the owner's local day (the daily cap's window)", () => {
  it("starts at local midnight, in the user's time zone", () => {
    const now = Date.UTC(2026, 9, 21, 3); // Oct 21 03:00 UTC = Oct 20 21:00 in Mexico City
    expect(new Date(localDayStart(now, "America/Mexico_City")).toISOString()).toBe("2026-10-20T06:00:00.000Z");
    expect(localDayKey(now, "America/Mexico_City")).toBe("2026-10-20");
    expect(localDayKey(now, "UTC")).toBe("2026-10-21");
    expect(new Date(localDayStart(now, "Asia/Tokyo")).toISOString()).toBe("2026-10-20T15:00:00.000Z");
  });

  it("holds across a DST change (New York, Nov 1 2026)", () => {
    const noonAfter = Date.UTC(2026, 10, 1, 17); // Nov 1 12:00 EST
    expect(new Date(localDayStart(noonAfter, "America/New_York")).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(localDayKey(noonAfter, "America/New_York")).toBe("2026-11-01");
  });
});

describe("managed coding usage is billable; the user's own coding sessions never are", () => {
  it("session.managed produces a work event; BYO and session.codex produce nothing", () => {
    expect(isBillable({ owner: "u", billingMode: "managed", origin: "session.managed" })).toBe(true);
    expect(isBillable({ owner: "u", billingMode: "managed", origin: "session.codex" })).toBe(false);
    expect(isBillable({ owner: "u", billingMode: "byo_api_key", origin: "session.managed" })).toBe(false);
    const e = usageEvent(
      { owner: "u", billingMode: "managed", origin: "session.managed" },
      {
        kind: "llm.tokens",
        provider: "openai",
        amount: 10,
        costUsdMicros: 3,
        occurredAt: Date.UTC(2026, 9, 21),
        sourceId: "s",
      },
    );
    expect(e?.metadata?.purpose).toBe("work");
  });

  it("hold job ids and request source ids never collide", () => {
    expect(codingHoldJobId("cc_1", 0)).toBe("coding:cc_1:0");
    expect(codingSourceId("cc_1", 0)).toBe("coding:cc_1:r0");
  });
});

describe("worst case of one request", () => {
  it("input is the body size, never more than the model's window; output is the clamped limit", () => {
    const r = { model: "gpt-5.6-luna", maxInputTokens: 400_000, maxOutputTokens: 32_000 };
    // gpt-5.6-luna: input 0.20, output 1.20 per 1M → 100k bytes + 32k out = 20_000 + 38_400 micros.
    expect(codingWorstCaseMicros(prices, "openai", { ...r, inputBytes: 100_000 })).toBe(58_400);
    expect(codingWorstCaseMicros(prices, "openai", { ...r, inputBytes: 9_000_000 })).toBe(80_000 + 38_400);
  });

  it("an unpriced model throws, so the gateway fails closed before spending", () => {
    expect(() =>
      codingWorstCaseMicros(prices, "openai", {
        model: "gpt-unknown",
        inputBytes: 1,
        maxInputTokens: 1,
        maxOutputTokens: 1,
      }),
    ).toThrow(/no price/);
  });
});

describe("daily cap", () => {
  it("the default when never set; the owner's own otherwise; never above the tier's ceiling; nothing off paid tiers", () => {
    expect(codingDailyCap(cfg, "Pro", null)).toBe(1_250_000);
    expect(codingDailyCap(cfg, "pro", 300_000)).toBe(300_000);
    expect(codingDailyCap(cfg, "Pro", 99_000_000)).toBe(cfg.dailyCap.ceiling.pro);
    expect(codingDailyCap(cfg, " VIP ", 99_000_000)).toBe(cfg.dailyCap.ceiling.vip);
    expect(codingDailyCap(cfg, "free", null)).toBe(0);
    expect(codingDailyCap(cfg, null, null)).toBe(0);
  });
});
