import { describe, expect, it } from "vitest";
import { loadPrices } from "@chalito/config";
import {
  callCostMicros,
  computeCostMicros,
  llmCostMicros,
  realtimeCostMicros,
  smsCostMicros,
  voiceSecondsCostMicros,
  whatsappCostMicros,
} from "../src/cost.js";

const prices = loadPrices();

describe("cost module (prices.yaml → cost_usd_micros)", () => {
  it("prices LLM tokens including cache reads and writes", () => {
    // Sonnet 5.5: $2 in, $10 out, $0.20 cache read, $2.50 cache write (5 min), $4 (1 h) per 1M.
    const t = { input: 1_000, output: 500, cacheRead: 2_000, cacheWrite: 1_000 };
    expect(llmCostMicros(prices, "anthropic", "claude-sonnet-5-5", t)).toBe(2_000 + 5_000 + 400 + 2_500);
    expect(llmCostMicros(prices, "anthropic", "claude-sonnet-5-5", { ...t, cacheWriteTtl: "1h" })).toBe(
      2_000 + 5_000 + 400 + 4_000,
    );
    // OpenAI has a single cacheWrite rate.
    expect(llmCostMicros(prices, "openai", "gpt-6-luna", { input: 1_000_000, output: 0, cacheWrite: 1_000_000 })).toBe(
      100_000 + 125_000,
    );
  });

  it("rounds up, never down, and refuses unknown models", () => {
    expect(llmCostMicros(prices, "openai", "gpt-6-luna", { input: 1, output: 0 })).toBe(1); // 0.1 µ$ → 1
    expect(llmCostMicros(prices, "openai", "gpt-6-luna", { input: 0, output: 0 })).toBe(0);
    expect(() => llmCostMicros(prices, "openai", "gpt-unknown", { input: 1, output: 1 })).toThrow(/no price/);
  });

  it("prices realtime audio and wall-clock voice seconds (≈ $0.03/min upper bound)", () => {
    expect(realtimeCostMicros(prices, "gpt-realtime-2.1-mini", { audioIn: 1_000_000 })).toBe(10_000_000);
    expect(voiceSecondsCostMicros(prices, "gpt-realtime-2.1-mini", 60)).toBe(30_000);
    expect(() => voiceSecondsCostMicros(prices, "gpt-unknown", 1)).toThrow();
  });

  it("prices Twilio per started minute, SIP on top, SMS per segment", () => {
    // 61 s to an MX mobile over SIP = 2 minutes × ($0.0473 + $0.0040).
    expect(callCostMicros(prices, { seconds: 61, destination: "MX_mobile", sip: true })).toBe(102_600);
    expect(callCostMicros(prices, { seconds: 0, destination: "US" })).toBe(0);
    expect(smsCostMicros(prices, "MX", 2)).toBe(363_800);
  });

  it("prices WhatsApp by market; unknown markets at the most expensive known rate", () => {
    expect(whatsappCostMicros(prices, "MX")).toBe(8_500);
    expect(whatsappCostMicros(prices, "US")).toBe(3_400);
    expect(whatsappCostMicros(prices, "CO")).toBe(11_300);
    expect(whatsappCostMicros(prices, "JP")).toBe(20_000);
    expect(smsCostMicros(prices, "JP", 1)).toBe(181_900);
  });

  it("prices compute at the hub contract rates", () => {
    expect(computeCostMicros(prices, 10)).toBe(880);
    expect(computeCostMicros(prices, 10, "boost")).toBe(2_080);
  });
});
