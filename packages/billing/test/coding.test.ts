import { describe, expect, it } from "vitest";
import { loadPrices, loadProviders } from "@chalito/config";
import { isBillable, usageEvent } from "../src/billable.js";
import { localDayKey, localDayStart } from "../src/caps.js";
import {
  capTz,
  codingDailyCap,
  codingHoldJobId,
  codingSourceId,
  codingWorstCaseMicros,
  planCapZone,
} from "../src/coding.js";

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

describe("the cap's zone (frozen, so a tz switch can't reset the day)", () => {
  const now = Date.UTC(2026, 9, 22, 5); // 23:00 Oct 21 in Mexico City, 14:00 Oct 22 in Tokyo
  it("is frozen on first use", () => {
    expect(planCapZone({ tz: null, next: null, from: null }, "America/Mexico_City", now)).toEqual({
      tz: "America/Mexico_City",
      next: null,
      from: null,
    });
  });
  it("a new zone waits for the frozen zone's day to end", () => {
    const z = planCapZone({ tz: "America/Mexico_City", next: null, from: null }, "Asia/Tokyo", now);
    expect(z).toEqual({ tz: "America/Mexico_City", next: "Asia/Tokyo", from: Date.UTC(2026, 9, 22, 6) });
    expect(capTz(z, now)).toBe("America/Mexico_City");
    expect(capTz(z, Date.UTC(2026, 9, 22, 6))).toBe("Asia/Tokyo");
    // Asking again doesn't push the switch further out; switching back cancels it.
    expect(planCapZone(z, "Asia/Tokyo", now)).toEqual(z);
    expect(planCapZone(z, "America/Mexico_City", now)).toEqual({ tz: "America/Mexico_City", next: null, from: null });
    // Once it took over, it is the frozen zone.
    expect(planCapZone(z, "Asia/Tokyo", Date.UTC(2026, 9, 23))).toEqual({ tz: "Asia/Tokyo", next: null, from: null });
  });
});
