import { describe, expect, it } from "vitest";
import { CardPreview } from "../src/index.js";
import { CARD, fakeCanvas, fakeRenderer, fakeTexture } from "./fakes.js";

const host = () => {
  const h = { scheduled: 0, cancelled: 0 };
  return {
    h,
    host: {
      requestAnimationFrame: () => ++h.scheduled,
      cancelAnimationFrame: () => void h.cancelled++,
      hidden: () => false,
      onVisibilityChange: () => () => undefined,
    },
  };
};

describe("CardPreview (the store's skin preview)", () => {
  it("draws the card once plain, animates only while a skin is on, and stops on dispose", async () => {
    const { r, calls } = fakeRenderer();
    const { h, host: loopHost } = host();
    const urls: string[] = [];
    const p = new CardPreview({
      canvas: fakeCanvas() as unknown as HTMLCanvasElement,
      assetBase: "/roster/",
      avatar: "luna",
      drawing: "happy",
      createRenderer: () => r,
      fetchJson: async () => CARD,
      loadTexture: async (u) => (urls.push(u), fakeTexture(u)),
      loopHost,
    });
    await p.load();
    expect(urls).toContain("/roster/assets/luna/h.webp");
    expect(calls.render).toBe(1);
    expect(h.scheduled).toBe(0);
    p.setSkin("galaxy");
    expect(p.skin).toBe("galaxy");
    expect(h.scheduled).toBe(1);
    p.setSkin(null);
    expect(h.cancelled).toBe(1);
    p.setSkin("gold");
    p.dispose();
    expect(h.cancelled).toBe(2);
  });

  it("a skin chosen before the card loads is applied when it does", async () => {
    const { r } = fakeRenderer();
    const p = new CardPreview({
      canvas: fakeCanvas() as unknown as HTMLCanvasElement,
      assetBase: "/roster/",
      avatar: "luna",
      createRenderer: () => r,
      fetchJson: async () => CARD,
      loadTexture: async (u) => fakeTexture(u),
      loopHost: host().host,
    });
    p.setSkin("neon");
    await p.load();
    expect(p.skin).toBe("neon");
    p.dispose();
  });
});
