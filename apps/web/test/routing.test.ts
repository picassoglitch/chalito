import { describe, expect, it } from "vitest";
import { routing } from "@/i18n/routing";

describe("i18n routing (ADR 0015, D-018)", () => {
  it("ES is the unprefixed default, EN under /en, locale from the URL only", () => {
    expect(routing.defaultLocale).toBe("es");
    expect(routing.locales).toEqual(["es", "en"]);
    expect(routing.localePrefix).toBe("as-needed");
    expect(routing.localeDetection).toBe(false);
  });
  it("deep links keep the same path in both locales", () => {
    for (const p of ["/a/[id]", "/m/[id]", "/r/[id]", "/creditos", "/auth/sso"] as const)
      expect(routing.pathnames?.[p]).toBe(p);
  });
});
