import { describe, expect, it } from "vitest";
import { loadModels, loadPrices } from "@chalito/config";
import { HubUsageEvent } from "@chalito/protocol";
import { AVATAR_IMAGES, avatarQuote, avatarUsageEvent, imageCostMicros } from "../src/index.js";

const prices = loadPrices();
const model = loadModels().images.avatar;

describe("custom companion pricing", () => {
  it("a creation is the neutral drawing plus four emotion edits", () => {
    expect(AVATAR_IMAGES).toBe(5);
  });

  it("costs images × the per-image price in prices.yaml, rounded up to whole µ$", () => {
    const per = prices.images[model.provider]![model.model]!.perImage;
    expect(imageCostMicros(prices, model.provider, model.model, 5)).toBe(Math.ceil(5 * per * 1e6));
    expect(imageCostMicros(prices, model.provider, model.model, 0)).toBe(0);
    expect(() => imageCostMicros(prices, "google", "no-such-model", 1)).toThrow(/no image price/);
  });

  it("the shown price is what the hub bills at its default 160% margin: cost × 2.6 / 4 µ$", () => {
    const q = avatarQuote(prices, model, "pre_margin");
    expect(q.priceTokens).toBe(Math.ceil((q.costMicros * 2.6) / 4));
    // pre_margin: the hub adds the margin when it reserves; post_margin: the estimate carries it.
    expect(q.estTokens).toBe(Math.ceil(q.costMicros / 4));
    expect(avatarQuote(prices, model, "post_margin").estTokens).toBe(q.priceTokens);
  });

  it("the usage event reports the real cost (the hub adds the margin), once per creation", () => {
    const e = avatarUsageEvent({
      owner: "hub-user-1",
      creationId: "cr_0123456789abcdef",
      images: 5,
      costMicros: 335_000,
      reservationId: "11111111-1111-4111-8111-111111111111",
      model,
      occurredAt: Date.parse("2026-10-05T12:00:00Z"),
    });
    expect(HubUsageEvent.parse(e)).toMatchObject({
      source_id: "avatar:cr_0123456789abcdef",
      kind: "image.generations",
      provider: "google",
      amount: 5,
      cost_usd_micros: 335_000,
      reservation_id: "11111111-1111-4111-8111-111111111111",
      metadata: { model: model.model },
    });
  });
});
